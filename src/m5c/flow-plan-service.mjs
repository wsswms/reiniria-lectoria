import { randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import {
  contentDigest,
  contextPlanContract,
  contextPlanItemContract,
  DEFAULT_FLOW_BUDGET,
  flowBudgetPolicyContract,
  M5C_CONTRACT_VERSION,
  userGuidanceContract,
} from "./contracts.mjs";
import { LocalContextPlanner } from "./local-context-planner.mjs";
import { LocalGuidanceInterpreter } from "./guidance-interpreter.mjs";

export class FlowPlanConflictError extends Error {
  constructor(message = "M5C flow or plan conflict") { super(message); this.name = "FlowPlanConflictError"; this.code = "FLOW_PLAN_CONFLICT"; }
}

function actor(input, types) {
  if (!input || !types.includes(input.type) || typeof input.id !== "string" || input.id.length === 0) throw new FlowPlanConflictError("actor is not authorized");
  return input;
}

export class FlowPlanService {
  constructor(database, trustedWorkspaceId, { id = () => randomUUID(), now = () => new Date(), planner = null, guidanceInterpreter = null } = {}) {
    this.database = database; this.workspaceId = trustedWorkspaceId; this.id = id; this.now = now;
    this.planner = planner ?? new LocalContextPlanner(database, trustedWorkspaceId);
    this.guidanceInterpreter = guidanceInterpreter ?? new LocalGuidanceInterpreter();
  }

  create({ workflowId, documentId, sourceRevisionId, targetLanguage, plannerEnabled = true, budget = DEFAULT_FLOW_BUDGET }, actorInput) {
    const by = actor(actorInput, ["user"]);
    if (typeof plannerEnabled !== "boolean") throw new TypeError("plannerEnabled must be boolean");
    const timestamp = this.now().toISOString();
    const local = this.planner.build({ workflowId, documentId, sourceRevisionId, targetLanguage });
    const items = local.items.map((item) => contextPlanItemContract({ itemId: this.id(), ...item }));
    const planRevisionId = this.id(); const budgetRevisionId = this.id();
    const plan = contextPlanContract({ schemaVersion: M5C_CONTRACT_VERSION, planRevisionId, workflowId, documentId, sourceRevisionId, targetLanguage,
      revision: 1, plannerMode: "local", state: "draft", items, researchScope: local.researchScope, qaProfile: local.qaProfile,
      createdBy: { type: "system", id: "local-context-planner" }, createdAt: timestamp });
    const policy = flowBudgetPolicyContract({ schemaVersion: M5C_CONTRACT_VERSION, workflowId, revision: 1, ...budget, authorizedBy: by, createdAt: timestamp });
    try {
      this.database.transaction(() => {
        const source = this.database.prepare(`SELECT 1 FROM source_revisions revision JOIN document_imports imported
          ON imported.workspace_id = revision.workspace_id AND imported.source_revision_id = revision.source_revision_id
          JOIN import_confirmations confirmation ON confirmation.workspace_id = imported.workspace_id AND confirmation.import_id = imported.import_id
          WHERE revision.workspace_id = ? AND revision.document_id = ? AND revision.source_revision_id = ?`).get(this.workspaceId, documentId, sourceRevisionId);
        if (!source) throw new FlowPlanConflictError("a confirmed source revision is required");
        this.database.prepare("INSERT INTO translation_workflows(workspace_id,workflow_id,document_id,source_revision_id,target_language,version,state,legacy_content_json,origin_type,updated_at) VALUES (?, ?, ?, ?, ?, 0, 'source-confirmed', '{}', 'native', ?)")
          .run(this.workspaceId, workflowId, documentId, sourceRevisionId, targetLanguage, timestamp);
        this.database.prepare("INSERT INTO translation_flow_controls VALUES (?, ?, 'planning', 'none', NULL, ?, 0, 0, 0, 0, ?, ?)")
          .run(this.workspaceId, workflowId, plannerEnabled ? 1 : 0, timestamp, timestamp);
        this.database.prepare("INSERT INTO flow_budget_policy_revisions VALUES (?, ?, ?, 1, ?, ?, 'user', ?, ?)")
          .run(this.workspaceId, budgetRevisionId, workflowId, stableJson(policy), contentDigest(policy), by.id, timestamp);
        this.database.prepare("INSERT INTO flow_budget_policy_heads VALUES (?, ?, ?, 1, 0, ?)").run(this.workspaceId, workflowId, budgetRevisionId, timestamp);
        this.#insertPlan(plan);
        this.database.prepare("INSERT INTO translation_context_plan_heads VALUES (?, ?, ?, 1, 0, 'draft', ?)").run(this.workspaceId, workflowId, planRevisionId, timestamp);
        this.#event(workflowId, "flow-created", by, { plannerEnabled, planRevisionId, budgetRevisionId }, timestamp);
      }).immediate();
    } catch (error) { if (error instanceof FlowPlanConflictError) throw error; throw new FlowPlanConflictError(String(error?.message ?? error)); }
    return this.get(workflowId);
  }

  revisePlan(workflowId, expectedVersion, input, actorInput) {
    const by = actor(actorInput, ["system", "model", "fixture"]); const current = this.get(workflowId); const timestamp = this.now().toISOString();
    if (!["draft", "pending-user", "rejected", "failed", "unknown"].includes(current.planHead.state)) throw new FlowPlanConflictError("approved or terminal plan cannot be revised");
    const plan = contextPlanContract({ ...input, schemaVersion: M5C_CONTRACT_VERSION, planRevisionId: this.id(), workflowId,
      documentId: current.workflow.documentId, sourceRevisionId: current.workflow.sourceRevisionId, targetLanguage: current.workflow.targetLanguage, revision: current.plan.revision + 1,
      state: "draft", createdBy: by, createdAt: timestamp });
    try {
      this.database.transaction(() => {
        this.#insertPlan(plan);
        const changed = this.database.prepare("UPDATE translation_context_plan_heads SET plan_revision_id = ?, revision = ?, version = version + 1, state = 'draft', updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND version = ?")
          .run(plan.planRevisionId, plan.revision, timestamp, this.workspaceId, workflowId, expectedVersion).changes;
        if (changed !== 1) throw new FlowPlanConflictError("plan version conflict");
        this.#event(workflowId, "plan-revised", by, { planRevisionId: plan.planRevisionId }, timestamp);
      }).immediate();
    } catch (error) { if (error instanceof FlowPlanConflictError) throw error; throw new FlowPlanConflictError(String(error?.message ?? error)); }
    return this.get(workflowId);
  }

  reviseApprovedForKnowledgeNeed(workflowId, expectedVersion, item, actorInput) {
    const by = actor(actorInput, ["system"]); const current = this.get(workflowId); const timestamp = this.now().toISOString();
    if (current.planHead.state !== "approved" || current.planHead.version !== expectedVersion) throw new FlowPlanConflictError("approved current plan is required");
    const plan = contextPlanContract({ ...current.plan, schemaVersion: M5C_CONTRACT_VERSION, planRevisionId: this.id(), revision: current.plan.revision + 1,
      state: "draft", items: [...current.plan.items.map((existing) => ({ ...existing, itemId: this.id() })), item], createdBy: by, createdAt: timestamp });
    this.database.transaction(() => {
      this.#insertPlan(plan);
      const changed = this.database.prepare("UPDATE translation_context_plan_heads SET plan_revision_id = ?, revision = ?, version = version + 1, state = 'draft', updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND version = ? AND state = 'approved'")
        .run(plan.planRevisionId, plan.revision, timestamp, this.workspaceId, workflowId, expectedVersion).changes;
      if (changed !== 1) throw new FlowPlanConflictError("knowledge need plan revision conflict");
      this.database.prepare("UPDATE temporary_context_heads SET state = 'stale', version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND state = 'approved'")
        .run(timestamp, this.workspaceId, workflowId);
      this.database.prepare("UPDATE translation_flow_controls SET flow_state = 'planning', outcome_state = 'none', version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ?")
        .run(timestamp, this.workspaceId, workflowId);
      this.#event(workflowId, "translation-knowledge-need-added", by, { planRevisionId: plan.planRevisionId, itemId: item.itemId }, timestamp);
    }).immediate();
    return this.get(workflowId);
  }

  submitPlan(workflowId, expectedVersion, actorInput) {
    const by = actor(actorInput, ["system"]); const timestamp = this.now().toISOString();
    const changed = this.database.transaction(() => {
      const result = this.database.prepare("UPDATE translation_context_plan_heads SET state = 'pending-user', version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND state = 'draft' AND version = ?")
        .run(timestamp, this.workspaceId, workflowId, expectedVersion).changes;
      if (result !== 1) throw new FlowPlanConflictError("plan submit conflict");
      this.database.prepare("UPDATE translation_flow_controls SET flow_state = 'plan-approval', version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND flow_state = 'planning'")
        .run(timestamp, this.workspaceId, workflowId);
      this.#event(workflowId, "plan-submitted", by, {}, timestamp); return result;
    }).immediate();
    if (changed !== 1) throw new FlowPlanConflictError(); return this.get(workflowId);
  }

  decidePlan(workflowId, expectedVersion, decision, actorInput) {
    const by = actor(actorInput, ["user"]); if (!new Set(["approved", "rejected", "canceled"]).has(decision)) throw new TypeError("invalid plan decision");
    const current = this.get(workflowId); if (current.planHead.state !== "pending-user" || current.planHead.version !== expectedVersion) throw new FlowPlanConflictError("plan decision conflict");
    const timestamp = this.now().toISOString();
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO translation_context_plan_decisions VALUES (?, ?, ?, ?, ?, 'user', ?, ?)")
        .run(this.workspaceId, this.id(), workflowId, current.plan.planRevisionId, decision, by.id, timestamp);
      const changed = this.database.prepare("UPDATE translation_context_plan_heads SET state = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND state = 'pending-user' AND version = ?")
        .run(decision, timestamp, this.workspaceId, workflowId, expectedVersion).changes;
      if (changed !== 1) throw new FlowPlanConflictError("plan decision conflict");
      const nextFlow = decision === "approved" ? "research" : decision === "canceled" ? "canceled" : "planning";
      this.database.prepare("UPDATE translation_flow_controls SET flow_state = ?, outcome_state = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND flow_state = 'plan-approval'")
        .run(nextFlow, decision === "canceled" ? "failed" : "none", timestamp, this.workspaceId, workflowId);
      this.#event(workflowId, `plan-${decision}`, by, { planRevisionId: current.plan.planRevisionId }, timestamp);
    }).immediate();
    return this.get(workflowId);
  }

  proposeGuidance(workflowId, rawText, interpretation, actorInput) {
    const by = actor(actorInput, ["system", "model", "fixture"]); this.#flow(workflowId); const timestamp = this.now().toISOString();
    const guidanceId = this.id(); const guidanceRevisionId = this.id();
    const guidance = userGuidanceContract({ schemaVersion: M5C_CONTRACT_VERSION, guidanceRevisionId, guidanceId, workflowId, revision: 1,
      rawText, interpretation, state: "pending-user", createdBy: by, createdAt: timestamp });
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO user_guidance_revisions VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 'pending-user', ?, ?, ?)")
        .run(this.workspaceId, guidanceRevisionId, guidanceId, workflowId, guidance.rawText, contentDigest(guidance.rawText), stableJson(guidance.interpretation), contentDigest(guidance.interpretation), by.type, by.id, timestamp);
      this.database.prepare("INSERT INTO user_guidance_heads VALUES (?, ?, ?, ?, 1, 0, 'pending-user', ?)")
        .run(this.workspaceId, guidanceId, workflowId, guidanceRevisionId, timestamp);
      this.#event(workflowId, "guidance-proposed", by, { guidanceId, guidanceRevisionId }, timestamp);
    }).immediate();
    return this.getGuidance(guidanceId);
  }

  interpretGuidance(workflowId, rawText, scopeHint, actorInput) {
    const by = actor(actorInput, ["system", "model", "fixture"]);
    return this.proposeGuidance(workflowId, rawText, this.guidanceInterpreter.interpret(rawText, scopeHint), by);
  }

  decideGuidance(guidanceId, expectedVersion, decision, actorInput) {
    const by = actor(actorInput, ["user"]); if (!new Set(["confirmed", "rejected", "canceled"]).has(decision)) throw new TypeError("invalid guidance decision");
    const current = this.getGuidance(guidanceId); if (current.version !== expectedVersion || current.state !== "pending-user") throw new FlowPlanConflictError("guidance decision conflict");
    if (decision === "confirmed" && current.guidance.interpretation.ambiguities.length) throw new FlowPlanConflictError("ambiguous guidance cannot be confirmed");
    const timestamp = this.now().toISOString();
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO user_guidance_decisions VALUES (?, ?, ?, ?, ?, 'user', ?, ?)")
        .run(this.workspaceId, this.id(), guidanceId, current.guidance.guidanceRevisionId, decision, by.id, timestamp);
      const changed = this.database.prepare("UPDATE user_guidance_heads SET state = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND guidance_id = ? AND state = 'pending-user' AND version = ?")
        .run(decision, timestamp, this.workspaceId, guidanceId, expectedVersion).changes;
      if (changed !== 1) throw new FlowPlanConflictError("guidance decision conflict");
      this.#event(current.guidance.workflowId, `guidance-${decision}`, by, { guidanceId }, timestamp);
    }).immediate();
    return this.getGuidance(guidanceId);
  }

  get(workflowId) {
    const workflow = this.database.prepare(`SELECT workflow_id AS workflowId, document_id AS documentId, source_revision_id AS sourceRevisionId,
      target_language AS targetLanguage FROM translation_workflows WHERE workspace_id = ? AND workflow_id = ?`).get(this.workspaceId, workflowId);
    const flow = this.#flow(workflowId);
    const head = this.database.prepare("SELECT plan_revision_id AS planRevisionId, revision, version, state FROM translation_context_plan_heads WHERE workspace_id = ? AND workflow_id = ?")
      .get(this.workspaceId, workflowId);
    if (!workflow || !head) throw new FlowPlanConflictError("M5C workflow is incomplete");
    const row = this.database.prepare("SELECT plan_json AS planJson FROM translation_context_plan_revisions WHERE workspace_id = ? AND plan_revision_id = ?")
      .get(this.workspaceId, head.planRevisionId);
    return Object.freeze({ workflow: Object.freeze(workflow), flow: Object.freeze(flow), planHead: Object.freeze(head), plan: contextPlanContract(JSON.parse(row.planJson)) });
  }

  list() {
    return Object.freeze(this.database.prepare(`
      SELECT workflow.workflow_id AS workflowId, workflow.document_id AS documentId,
             workflow.source_revision_id AS sourceRevisionId, workflow.target_language AS targetLanguage,
             workflow.state, workflow.version, workflow.updated_at AS updatedAt,
             flow.flow_state AS flowState, flow.outcome_state AS outcomeState,
             plan.state AS planState, context.state AS contextState
      FROM translation_workflows workflow
      JOIN translation_flow_controls flow
        ON flow.workspace_id = workflow.workspace_id AND flow.workflow_id = workflow.workflow_id
      LEFT JOIN translation_context_plan_heads plan
        ON plan.workspace_id = workflow.workspace_id AND plan.workflow_id = workflow.workflow_id
      LEFT JOIN temporary_context_heads context
        ON context.workspace_id = workflow.workspace_id AND context.workflow_id = workflow.workflow_id
      WHERE workflow.workspace_id = ?
      ORDER BY workflow.updated_at DESC, workflow.workflow_id DESC
    `).all(this.workspaceId).map(Object.freeze));
  }

  getGuidance(guidanceId) {
    const row = this.database.prepare(`SELECT head.version, head.state, revision.raw_text AS rawText, revision.interpretation_json AS interpretationJson,
      revision.guidance_revision_id AS guidanceRevisionId, revision.guidance_id AS guidanceId, revision.workflow_id AS workflowId,
      revision.revision, revision.actor_type AS actorType, revision.actor_id AS actorId, revision.created_at AS createdAt
      FROM user_guidance_heads head JOIN user_guidance_revisions revision ON revision.workspace_id = head.workspace_id AND revision.guidance_revision_id = head.guidance_revision_id
      WHERE head.workspace_id = ? AND head.guidance_id = ?`).get(this.workspaceId, guidanceId);
    if (!row) throw new FlowPlanConflictError("guidance not found");
    return Object.freeze({ version: row.version, state: row.state, guidance: userGuidanceContract({ schemaVersion: M5C_CONTRACT_VERSION,
      guidanceRevisionId: row.guidanceRevisionId, guidanceId: row.guidanceId, workflowId: row.workflowId, revision: row.revision,
      rawText: row.rawText, interpretation: JSON.parse(row.interpretationJson), state: row.state,
      createdBy: { type: row.actorType, id: row.actorId }, createdAt: row.createdAt }) });
  }

  #insertPlan(plan) {
    this.database.prepare("INSERT INTO translation_context_plan_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.workspaceId, plan.planRevisionId, plan.workflowId, plan.documentId, plan.sourceRevisionId, plan.targetLanguage, plan.revision, plan.plannerMode, plan.state,
        stableJson(plan), contentDigest(plan), plan.createdBy.type, plan.createdBy.id, plan.createdAt);
    for (const item of plan.items) this.database.prepare("INSERT INTO translation_context_plan_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.workspaceId, item.itemId, plan.workflowId, plan.planRevisionId, item.kind, item.coverage, item.instructionType, item.impact,
        stableJson(item.segmentIds), stableJson(item.dependencies), contentDigest(item.dependencies), stableJson(item.content), contentDigest(item));
  }

  #flow(workflowId) {
    const row = this.database.prepare("SELECT workflow_id AS workflowId, flow_state AS flowState, outcome_state AS outcomeState, pause_reason AS pauseReason, planner_enabled AS plannerEnabled, version, qa_cycles AS qaCycles, research_cycles AS researchCycles, retranslation_count AS retranslationCount FROM translation_flow_controls WHERE workspace_id = ? AND workflow_id = ?")
      .get(this.workspaceId, workflowId);
    if (!row) throw new FlowPlanConflictError("M5C flow not found"); return row;
  }

  #event(workflowId, type, by, details, timestamp) {
    this.database.prepare("INSERT INTO translation_flow_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.workspaceId, this.id(), workflowId, type, by.type, by.id, stableJson(details), timestamp);
  }
}
