import { randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { buildContextManifest, PROMPT_VERSION } from "../provider/prompt-context.mjs";
import { TranslationTaskOrchestrator } from "../provider/task-orchestrator.mjs";
import { contentDigest } from "./contracts.mjs";
import { TranslationFlowBudgetService } from "./flow-budget-service.mjs";

export class TemporaryContextConflictError extends Error {
  constructor(message = "temporary translation context conflict") { super(message); this.name = "TemporaryContextConflictError"; this.code = "TEMPORARY_CONTEXT_CONFLICT"; }
}

function actor(input, types) {
  if (!input || !types.includes(input.type) || typeof input.id !== "string" || input.id.length === 0) throw new TemporaryContextConflictError("actor is not authorized");
  return input;
}

function affirmative(type) { return !["disputed", "warning-only"].includes(type); }

export class TemporaryContextService {
  constructor(database, trustedWorkspaceId, { id = () => randomUUID(), now = () => new Date(), tasks = null, budgets = null } = {}) {
    this.database = database; this.workspaceId = trustedWorkspaceId; this.id = id; this.now = now;
    this.tasks = tasks ?? new TranslationTaskOrchestrator(database, trustedWorkspaceId, { id, now });
    this.budgets = budgets ?? new TranslationFlowBudgetService(database, trustedWorkspaceId, { id, now });
  }

  assemble(workflowId, { guidanceIds = [], researchClaimIds = [] } = {}, actorInput = { type: "system", id: "temporary-context-assembler" }) {
    const by = actor(actorInput, ["system", "fixture"]); const timestamp = this.now().toISOString();
    const plan = this.database.prepare(`SELECT head.plan_revision_id AS planRevisionId, head.state, revision.revision
      FROM translation_context_plan_heads head JOIN translation_context_plan_revisions revision
      ON revision.workspace_id = head.workspace_id AND revision.plan_revision_id = head.plan_revision_id
      WHERE head.workspace_id = ? AND head.workflow_id = ?`).get(this.workspaceId, workflowId);
    if (!plan || plan.state !== "approved") throw new TemporaryContextConflictError("approved current ContextPlan is required");
    if (!Array.isArray(guidanceIds) || !Array.isArray(researchClaimIds) || new Set(guidanceIds).size !== guidanceIds.length || new Set(researchClaimIds).size !== researchClaimIds.length) throw new TypeError("context source ids must be unique arrays");
    const items = this.#planItems(plan.planRevisionId);
    for (const guidanceId of guidanceIds) items.push(this.#guidanceItem(workflowId, guidanceId));
    for (const claimId of researchClaimIds) items.push(this.#claimItem(claimId));
    if (items.length > 256) throw new TemporaryContextConflictError("temporary context item limit exceeded");
    const prior = this.database.prepare("SELECT revision, version, state FROM temporary_context_heads WHERE workspace_id = ? AND workflow_id = ?").get(this.workspaceId, workflowId);
    if (prior && !["rejected", "stale", "draft"].includes(prior.state)) throw new TemporaryContextConflictError("current context cannot be replaced");
    const revision = (prior?.revision ?? 0) + 1; const contextRevisionId = this.id();
    const context = Object.freeze({ schemaVersion: "m5c-temporary-context-v1", contextRevisionId, workflowId, planRevisionId: plan.planRevisionId,
      revision, items: Object.freeze(items.map(Object.freeze)), createdAt: timestamp });
    const digest = contentDigest(context);
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO temporary_context_revisions VALUES (?, ?, ?, ?, ?, 'pending-user', ?, ?, ?, ?, ?)")
        .run(this.workspaceId, contextRevisionId, workflowId, plan.planRevisionId, revision, stableJson(context), digest, by.type, by.id, timestamp);
      for (const item of items) this.database.prepare("INSERT INTO temporary_context_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, item.contextItemId, workflowId, contextRevisionId, item.instructionType, item.sourceType, item.sourceId, item.sourceDigest,
          stableJson(item.segmentIds), stableJson(item.content), item.contentDigest, item.affirmative ? 1 : 0);
      if (!prior) this.database.prepare("INSERT INTO temporary_context_heads VALUES (?, ?, ?, ?, 0, 'pending-user', ?)")
        .run(this.workspaceId, workflowId, contextRevisionId, revision, timestamp);
      else {
        const changed = this.database.prepare("UPDATE temporary_context_heads SET context_revision_id = ?, revision = ?, version = version + 1, state = 'pending-user', updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND version = ?")
          .run(contextRevisionId, revision, timestamp, this.workspaceId, workflowId, prior.version).changes;
        if (changed !== 1) throw new TemporaryContextConflictError("context version conflict");
      }
      this.database.prepare("UPDATE translation_flow_controls SET flow_state = 'context-approval', version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND flow_state IN ('research','context-approval')")
        .run(timestamp, this.workspaceId, workflowId);
    }).immediate();
    return this.get(workflowId);
  }

  decide(workflowId, expectedVersion, decision, actorInput) {
    const by = actor(actorInput, ["user"]); if (!new Set(["approved", "rejected", "canceled"]).has(decision)) throw new TypeError("invalid context decision");
    const current = this.get(workflowId); if (current.head.version !== expectedVersion || current.head.state !== "pending-user") throw new TemporaryContextConflictError("context decision conflict");
    const timestamp = this.now().toISOString(); const decisionId = this.id();
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO context_use_decisions VALUES (?, ?, ?, ?, ?, 'user', ?, ?)")
        .run(this.workspaceId, decisionId, workflowId, current.context.contextRevisionId, decision, by.id, timestamp);
      const changed = this.database.prepare("UPDATE temporary_context_heads SET state = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND state = 'pending-user' AND version = ?")
        .run(decision, timestamp, this.workspaceId, workflowId, expectedVersion).changes;
      if (changed !== 1) throw new TemporaryContextConflictError("context decision conflict");
      this.database.prepare("UPDATE translation_flow_controls SET flow_state = ?, outcome_state = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND flow_state = 'context-approval'")
        .run(decision === "approved" ? "translating" : decision === "canceled" ? "canceled" : "research", decision === "canceled" ? "failed" : "none", timestamp, this.workspaceId, workflowId);
    }).immediate();
    return Object.freeze({ ...this.get(workflowId), decisionId });
  }

  enqueueTranslation(workflowId, input) {
    const current = this.get(workflowId); if (current.head.state !== "approved" || !current.decision || current.decision.decision !== "approved") throw new TemporaryContextConflictError("approved ContextUseDecision is required");
    const workflow = this.database.prepare("SELECT document_id AS documentId, source_revision_id AS sourceRevisionId, target_language AS targetLanguage FROM translation_workflows WHERE workspace_id = ? AND workflow_id = ?")
      .get(this.workspaceId, workflowId);
    const segmentIds = input.segmentIds ?? this.database.prepare("SELECT segment_id AS segmentId FROM source_segment_versions WHERE workspace_id = ? AND source_revision_id = ? AND translatable = 1 ORDER BY ordinal")
      .all(this.workspaceId, workflow.sourceRevisionId).map((row) => row.segmentId);
    if (!segmentIds.length) throw new TemporaryContextConflictError("translation segment scope is empty");
    const contextDigests = {}; let estimatedTokens = 0;
    for (const segmentId of segmentIds) {
      const built = buildContextManifest(this.database, this.workspaceId, { workflowId, segmentIds: [segmentId], promptVersion: input.promptVersion ?? PROMPT_VERSION,
        temporaryContextRevisionId: current.context.contextRevisionId });
      contextDigests[segmentId] = built.contextDigest; estimatedTokens += built.estimatedTokens;
    }
    const budgetCategory = input.budgetCategory ?? "translation";
    if (!new Set(["translation", "retranslation"]).has(budgetCategory)) throw new TypeError("invalid translation budget category");
    const reservationId = input.flowBudgetReservationId ?? `${budgetCategory}:${input.idempotencyKey}`;
    const requestedUsage = input.estimatedUsage ?? { calls: segmentIds.length, inputTokens: estimatedTokens, outputTokens: segmentIds.length * 1_024,
      costMicrosCny: 0, costMicrosUsd: 0, durationMs: segmentIds.length * 30_000 };
    this.budgets.reserve(workflowId, budgetCategory, reservationId, requestedUsage, { contextRevisionId: current.context.contextRevisionId });
    let task;
    try {
      if (budgetCategory === "translation") this.database.prepare("UPDATE translation_workflows SET state = 'queued', version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND state = 'source-confirmed'")
        .run(this.now().toISOString(), this.workspaceId, workflowId);
      task = this.tasks.enqueue({ workflowId, documentId: workflow.documentId, sourceRevisionId: workflow.sourceRevisionId, targetLanguage: workflow.targetLanguage,
        segmentIds, providerId: input.providerId, modelId: input.modelId, promptVersion: input.promptVersion ?? PROMPT_VERSION,
        contextDigests, requestDigest: contentDigest({ workflowId, segmentIds, contextDigests, providerId: input.providerId, modelId: input.modelId }),
        policyVersion: input.policyVersion ?? "m5c-translation-policy-v1", idempotencyKey: input.idempotencyKey,
        maxAttempts: input.maxAttempts ?? 3, batchSize: input.batchSize ?? 1 });
      this.database.transaction(() => {
        for (const attempt of task.attempts) this.database.prepare("INSERT OR IGNORE INTO m5c_translation_attempt_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(this.workspaceId, attempt.attempt_id, attempt.task_id, workflowId, attempt.segment_id, current.context.contextRevisionId,
            current.decision.decisionId, current.context.planRevisionId, reservationId, contextDigests[attempt.segment_id], this.now().toISOString());
      }).immediate();
    } catch (error) {
      if (task) { try { this.tasks.cancel(task.task.task_id); } catch {} }
      try { this.budgets.release(workflowId, reservationId, { reason: "enqueue-failed" }); } catch {}
      throw error;
    }
    return Object.freeze({ task, contextRevisionId: current.context.contextRevisionId, contextDigests: Object.freeze(contextDigests), flowBudgetReservationId: reservationId, budgetCategory });
  }

  get(workflowId) {
    const head = this.database.prepare("SELECT context_revision_id AS contextRevisionId, revision, version, state FROM temporary_context_heads WHERE workspace_id = ? AND workflow_id = ?")
      .get(this.workspaceId, workflowId);
    if (!head) throw new TemporaryContextConflictError("temporary context not found");
    const row = this.database.prepare("SELECT context_json AS contextJson, context_digest AS contextDigest FROM temporary_context_revisions WHERE workspace_id = ? AND context_revision_id = ?")
      .get(this.workspaceId, head.contextRevisionId);
    const context = JSON.parse(row.contextJson); if (contentDigest(context) !== row.contextDigest) throw new TemporaryContextConflictError("temporary context integrity failed");
    const decision = this.database.prepare("SELECT decision_id AS decisionId, decision FROM context_use_decisions WHERE workspace_id = ? AND workflow_id = ? AND context_revision_id = ?")
      .get(this.workspaceId, workflowId, head.contextRevisionId) ?? null;
    return Object.freeze({ head: Object.freeze(head), context: Object.freeze({ ...context, items: Object.freeze(context.items.map(Object.freeze)), contextDigest: row.contextDigest }), decision: decision && Object.freeze(decision) });
  }

  #planItems(planRevisionId) {
    return this.database.prepare("SELECT item_id AS sourceId, instruction_type AS instructionType, segment_ids_json AS segmentIdsJson, item_json AS contentJson, item_digest AS sourceDigest FROM translation_context_plan_items WHERE workspace_id = ? AND plan_revision_id = ? ORDER BY item_id")
      .all(this.workspaceId, planRevisionId).map((row) => { const content = JSON.parse(row.contentJson); return { contextItemId: this.id(), instructionType: row.instructionType,
        sourceType: "plan-item", sourceId: row.sourceId, sourceDigest: row.sourceDigest, segmentIds: JSON.parse(row.segmentIdsJson), content,
        contentDigest: contentDigest(content), affirmative: affirmative(row.instructionType) }; });
  }

  #guidanceItem(workflowId, guidanceId) {
    const row = this.database.prepare(`SELECT revision.guidance_revision_id AS sourceId, revision.interpretation_json AS interpretationJson,
      revision.interpretation_digest AS sourceDigest, revision.raw_text AS rawText FROM user_guidance_heads head JOIN user_guidance_revisions revision
      ON revision.workspace_id = head.workspace_id AND revision.guidance_revision_id = head.guidance_revision_id
      WHERE head.workspace_id = ? AND head.workflow_id = ? AND head.guidance_id = ? AND head.state = 'confirmed'`).get(this.workspaceId, workflowId, guidanceId);
    if (!row) throw new TemporaryContextConflictError("confirmed guidance not found"); const interpretation = JSON.parse(row.interpretationJson);
    const content = { rawText: row.rawText, action: interpretation.action, stateDiff: interpretation.stateDiff };
    return { contextItemId: this.id(), instructionType: interpretation.instructionType, sourceType: "user-guidance", sourceId: row.sourceId,
      sourceDigest: row.sourceDigest, segmentIds: interpretation.affectedSegmentIds, content, contentDigest: contentDigest(content), affirmative: affirmative(interpretation.instructionType) };
  }

  #claimItem(claimId) {
    const row = this.database.prepare("SELECT claim_id AS sourceId, claim_text AS text, claim_digest AS sourceDigest, support_level AS supportLevel, inference FROM research_claims WHERE workspace_id = ? AND claim_id = ?")
      .get(this.workspaceId, claimId); if (!row) throw new TemporaryContextConflictError("research claim not found");
    const instructionType = row.supportLevel === "CD" ? "disputed" : row.supportLevel === "CI" || row.inference ? "warning-only" : "background";
    const content = { text: row.text, supportLevel: row.supportLevel, inference: row.inference === 1 };
    return { contextItemId: this.id(), instructionType, sourceType: "research-claim", sourceId: row.sourceId, sourceDigest: row.sourceDigest,
      segmentIds: [], content, contentDigest: contentDigest(content), affirmative: affirmative(instructionType) };
  }
}
