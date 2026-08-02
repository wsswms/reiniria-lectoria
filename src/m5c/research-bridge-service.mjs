import { randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { ResearchFoundationService } from "../research/foundation-service.mjs";
import { contentDigest } from "./contracts.mjs";
import { TranslationFlowBudgetService } from "./flow-budget-service.mjs";

export class M5CResearchConflictError extends Error {
  constructor(message = "M5C research conflict") { super(message); this.name = "M5CResearchConflictError"; this.code = "M5C_RESEARCH_CONFLICT"; }
}

function actor(input, allowed) {
  if (!input || !allowed.includes(input.type) || typeof input.id !== "string" || input.id.length === 0) throw new M5CResearchConflictError("actor is not authorized");
  return input;
}

export class M5CResearchBridgeService {
  constructor(database, trustedWorkspaceId, { id = () => randomUUID(), now = () => new Date(), foundation = null, budgets = null } = {}) {
    this.database = database; this.workspaceId = trustedWorkspaceId; this.id = id; this.now = now;
    this.foundation = foundation ?? new ResearchFoundationService(database, trustedWorkspaceId, { id, now });
    this.budgets = budgets ?? new TranslationFlowBudgetService(database, trustedWorkspaceId, { id, now });
  }

  propose(workflowId, { originType, originId, questions, gapKinds = ["background-fact"] }, actorInput) {
    const by = actor(actorInput, ["system", "model", "fixture"]);
    if (!new Set(["plan-item", "qa-finding"]).has(originType)) throw new TypeError("invalid M5C research origin");
    const scope = this.#scope(workflowId); const plan = this.database.prepare("SELECT plan_revision_id AS planRevisionId, state FROM translation_context_plan_heads WHERE workspace_id = ? AND workflow_id = ?")
      .get(this.workspaceId, workflowId);
    if (!plan || plan.state !== "approved") throw new M5CResearchConflictError("approved current ContextPlan is required");
    const segmentIds = this.#originSegments(workflowId, plan.planRevisionId, originType, originId);
    const existing = this.database.prepare("SELECT request_id AS requestId FROM m5c_research_bindings WHERE workspace_id = ? AND workflow_id = ? AND plan_revision_id = ? AND origin_type = ? AND origin_id = ?")
      .get(this.workspaceId, workflowId, plan.planRevisionId, originType, originId);
    if (existing) return this.get(existing.requestId);
    const policy = this.budgets.get(workflowId).policy;
    const flow = this.database.prepare("SELECT research_cycles AS researchCycles FROM translation_flow_controls WHERE workspace_id = ? AND workflow_id = ?")
      .get(this.workspaceId, workflowId);
    if (flow.researchCycles >= policy.maxResearchCycles) throw new M5CResearchConflictError("research cycle stop line reached");
    const requestId = this.id(); const revisionId = this.id(); const taskId = this.id(); const timestamp = this.now().toISOString();
    const request = { schemaVersion: "1.0", requestId, revisionId, taskId, workflowId, documentId: scope.documentId,
      sourceRevisionId: scope.sourceRevisionId, targetLanguage: scope.targetLanguage, segmentIds, gapKinds, questions,
      localEvidenceDigest: contentDigest({ planRevisionId: plan.planRevisionId, originType, originId }), origin: by, createdAt: timestamp };
    const anchorDigest = contentDigest({ requestId, workflowId, planRevisionId: plan.planRevisionId, originType, originId });
    try {
      this.database.transaction(() => {
        this.database.prepare("INSERT INTO translation_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'm5c-research-anchor-v1', 'canceled', 0, ?, ?)")
          .run(this.workspaceId, taskId, workflowId, scope.documentId, scope.sourceRevisionId, scope.targetLanguage,
            `m5c-research:${plan.planRevisionId}:${originType}:${originId}`, anchorDigest, timestamp, timestamp);
        this.foundation.createRequest(request, by);
        this.database.prepare("INSERT INTO m5c_research_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(this.workspaceId, requestId, workflowId, plan.planRevisionId, taskId, originType, originId, timestamp);
        this.database.prepare("UPDATE translation_flow_controls SET flow_state = 'research', research_cycles = research_cycles + 1, version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND research_cycles = ?")
          .run(timestamp, this.workspaceId, workflowId, flow.researchCycles);
      }).immediate();
    } catch (error) { throw error instanceof M5CResearchConflictError ? error : new M5CResearchConflictError(String(error?.message ?? error)); }
    return this.get(requestId);
  }

  submit(requestId, expectedVersion, actorInput) {
    const by = actor(actorInput, ["system", "model", "fixture"]); this.#binding(requestId);
    this.foundation.submitRequest(requestId, expectedVersion, by); return this.get(requestId);
  }

  decide(requestId, expectedVersion, decision, actorInput) {
    const by = actor(actorInput, ["user"]); this.#binding(requestId);
    this.foundation.decideRequest(requestId, expectedVersion, decision, by); return this.get(requestId);
  }

  issueGrant(requestId, grant, actorInput) {
    const by = actor(actorInput, ["user"]); this.#binding(requestId);
    return Object.freeze({ ...this.get(requestId), grant: this.foundation.issueGrant(requestId, grant, by) });
  }

  reserveOperation(requestId, grantId, category, reservationId, usage, details = {}) {
    const binding = this.#binding(requestId); const grant = this.foundation.getGrant(grantId);
    if (grant.status !== "active" || grant.grant.requestId !== requestId || !new Set(["search", "fetch", "research"]).has(category)) {
      throw new M5CResearchConflictError("active bound ResearchGrant is required");
    }
    return this.budgets.reserve(binding.workflowId, category, reservationId, usage, { requestId, grantId, ...details });
  }

  settleOperation(requestId, reservationId, usage, details = {}) {
    const binding = this.#binding(requestId); return this.budgets.settle(binding.workflowId, reservationId, usage, { requestId, ...details });
  }

  unknownOperation(requestId, reservationId, details = {}) {
    const binding = this.#binding(requestId);
    const result = this.budgets.unknown(binding.workflowId, reservationId, { requestId, ...details });
    this.database.prepare("UPDATE translation_flow_controls SET flow_state = 'paused', outcome_state = 'unknown', pause_reason = 'research-unknown-outcome', version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ?")
      .run(this.now().toISOString(), this.workspaceId, binding.workflowId);
    return result;
  }

  get(requestId) {
    const binding = this.#binding(requestId); return Object.freeze({ binding: Object.freeze(binding), ...this.foundation.getRequest(requestId) });
  }

  #binding(requestId) {
    const row = this.database.prepare("SELECT request_id AS requestId, workflow_id AS workflowId, plan_revision_id AS planRevisionId, anchor_task_id AS anchorTaskId, origin_type AS originType, origin_id AS originId, created_at AS createdAt FROM m5c_research_bindings WHERE workspace_id = ? AND request_id = ?")
      .get(this.workspaceId, requestId);
    if (!row) throw new M5CResearchConflictError("M5C research request not found"); return row;
  }

  #scope(workflowId) {
    const row = this.database.prepare("SELECT document_id AS documentId, source_revision_id AS sourceRevisionId, target_language AS targetLanguage FROM translation_workflows WHERE workspace_id = ? AND workflow_id = ?")
      .get(this.workspaceId, workflowId);
    if (!row) throw new M5CResearchConflictError("workflow not found"); return row;
  }

  #originSegments(workflowId, planRevisionId, originType, originId) {
    if (originType === "plan-item") {
      const row = this.database.prepare("SELECT segment_ids_json AS segmentIdsJson FROM translation_context_plan_items WHERE workspace_id = ? AND workflow_id = ? AND plan_revision_id = ? AND item_id = ? AND coverage IN ('partially-covered','conflicted','stale','uncovered')")
        .get(this.workspaceId, workflowId, planRevisionId, originId);
      if (!row) throw new M5CResearchConflictError("researchable current Plan item is required"); return JSON.parse(row.segmentIdsJson);
    }
    const row = this.database.prepare(`SELECT finding.segment_id AS segmentId FROM m5c_qa_findings finding
      JOIN m5c_qa_runs run ON run.workspace_id = finding.workspace_id AND run.qa_run_id = finding.qa_run_id
      JOIN m5c_qa_finding_decisions decision ON decision.workspace_id = finding.workspace_id AND decision.qa_run_id = finding.qa_run_id AND decision.finding_id = finding.finding_id
      WHERE finding.workspace_id = ? AND finding.workflow_id = ? AND finding.finding_id = ? AND decision.decision = 'continue-research'`)
      .get(this.workspaceId, workflowId, originId);
    if (!row?.segmentId) throw new M5CResearchConflictError("a user-approved QA research finding is required"); return [row.segmentId];
  }
}
