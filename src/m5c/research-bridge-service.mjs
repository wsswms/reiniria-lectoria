import { randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { ResearchFoundationService } from "../research/foundation-service.mjs";
import { ResearchBudgetService } from "../research/budget-service.mjs";
import { ResearchRunService } from "../research/run-service.mjs";
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
  constructor(database, trustedWorkspaceId, { id = () => randomUUID(), now = () => new Date(), foundation = null, budgets = null,
    runs = null, researchBudgets = null } = {}) {
    this.database = database; this.workspaceId = trustedWorkspaceId; this.id = id; this.now = now;
    this.foundation = foundation ?? new ResearchFoundationService(database, trustedWorkspaceId, { id, now });
    this.budgets = budgets ?? new TranslationFlowBudgetService(database, trustedWorkspaceId, { id, now });
    this.runs = runs ?? new ResearchRunService(database, trustedWorkspaceId, { id, now });
    this.researchBudgets = researchBudgets ?? new ResearchBudgetService(database, trustedWorkspaceId, { id, now });
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

  createRun(requestId, requestDigest, actorInput) {
    const by = actor(actorInput, ["user", "system", "fixture"]); const binding = this.#binding(requestId);
    const grants = this.database.prepare("SELECT grant_id AS grantId FROM research_grants WHERE workspace_id = ? AND request_id = ? ORDER BY approved_at DESC")
      .all(this.workspaceId, requestId).filter(({ grantId }) => this.foundation.getGrant(grantId).status === "active");
    if (grants.length !== 1) throw new M5CResearchConflictError("one active bound ResearchGrant is required");
    const run = this.runs.create(grants[0].grantId, requestDigest, by);
    return Object.freeze({ binding: Object.freeze(binding), run });
  }

  startRun(requestId, runId, actorInput) {
    const by = actor(actorInput, ["system", "fixture"]); const binding = this.#binding(requestId); const run = this.runs.get(runId);
    if (this.foundation.getGrant(run.grantId).grant.requestId !== requestId) throw new M5CResearchConflictError("research run is not bound to the request");
    return Object.freeze({ binding: Object.freeze(binding), run: this.runs.transition(runId, "running", { actor: by }) });
  }

  retryUnknownRun(requestId, runId, actorInput) {
    const by = actor(actorInput, ["user"]); const binding = this.#binding(requestId); const run = this.runs.get(runId);
    if (this.foundation.getGrant(run.grantId).grant.requestId !== requestId) throw new M5CResearchConflictError("research run is not bound to the request");
    return Object.freeze({ binding: Object.freeze(binding), run: this.runs.retryUnknown(runId, by) });
  }

  getRun(requestId, runId) {
    const binding = this.#binding(requestId); const run = this.runs.get(runId);
    if (this.foundation.getGrant(run.grantId).grant.requestId !== requestId) throw new M5CResearchConflictError("research run is not bound to the request");
    return Object.freeze({ binding: Object.freeze(binding), run });
  }

  reserveOperation(requestId, grantId, category, reservationId, usage, details = {}) {
    const binding = this.#binding(requestId); const grant = this.foundation.getGrant(grantId);
    if (grant.status !== "active" || grant.grant.requestId !== requestId || !new Set(["search", "fetch", "research"]).has(category)) {
      throw new M5CResearchConflictError("active bound ResearchGrant is required");
    }
    const capability = { search: "search", fetch: "extract", research: "research-model" }[category];
    const required = ["runId", "providerId", "round", "query", "language", "country", "idempotencyKey"];
    if (!details || required.some((key) => details[key] === undefined)) throw new M5CResearchConflictError("research operation scope is incomplete");
    const operationDigest = contentDigest({ requestId, grantId, category, reservationId, usage, details });
    const prior = this.#operation(reservationId, false);
    if (prior) {
      if (prior.operationDigest !== operationDigest) throw new M5CResearchConflictError("research operation idempotency conflict");
      return Object.freeze({ article: this.budgets.reserve(binding.workflowId, category, reservationId, usage),
        research: this.researchBudgets.get(prior.queryId), reused: true });
    }
    const run = this.runs.get(details.runId);
    if (run.grantId !== grantId || run.state !== "running") throw new M5CResearchConflictError("a running bound ResearchRun is required");
    try {
      return this.database.transaction(() => {
        const article = this.budgets.reserve(binding.workflowId, category, reservationId, usage, { requestId, grantId, ...details });
        const research = this.researchBudgets.reserve(details.runId, { round: details.round, capability, providerId: details.providerId,
          query: details.query, language: details.language, country: details.country, idempotencyKey: details.idempotencyKey,
          estimate: this.#researchUsage(category, usage) });
        this.database.prepare("INSERT INTO m5c_research_operations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(this.workspaceId, reservationId, requestId, binding.workflowId, grantId, details.runId, research.queryId, category,
            operationDigest, this.now().toISOString());
        return Object.freeze({ article, research, reused: false });
      }).immediate();
    } catch (error) { throw error instanceof M5CResearchConflictError ? error : new M5CResearchConflictError(String(error?.message ?? error)); }
  }

  settleOperation(requestId, reservationId, usage, details = {}) {
    const binding = this.#binding(requestId); const operation = this.#operation(reservationId);
    if (operation.requestId !== requestId) throw new M5CResearchConflictError("research operation request mismatch");
    return this.database.transaction(() => {
      const expected = this.#researchUsage(operation.category, usage); const current = this.researchBudgets.get(operation.queryId);
      const terminal = current.entries.find((entry) => entry.entryType !== "reserved");
      if (terminal && (terminal.entryType !== "settled" || !this.#sameResearchUsage(terminal, expected))) {
        throw new M5CResearchConflictError("research settlement idempotency conflict");
      }
      return Object.freeze({
        article: this.budgets.settle(binding.workflowId, reservationId, usage, { requestId, ...details }),
        research: terminal ? current : this.researchBudgets.settle(operation.queryId, expected, details),
      });
    }).immediate();
  }

  unknownOperation(requestId, reservationId, details = {}) {
    const binding = this.#binding(requestId); const operation = this.#operation(reservationId);
    if (operation.requestId !== requestId) throw new M5CResearchConflictError("research operation request mismatch");
    return this.database.transaction(() => {
      const current = this.researchBudgets.get(operation.queryId);
      const terminal = current.entries.find((entry) => entry.entryType !== "reserved");
      if (terminal && terminal.entryType !== "unknown") throw new M5CResearchConflictError("research operation already finalized differently");
      const research = terminal ? current : this.researchBudgets.unknown(operation.queryId,
        this.#entryUsage(current.entries.find((entry) => entry.entryType === "reserved")), details);
      const article = this.budgets.unknown(binding.workflowId, reservationId,
        { requestId, ...details, pauseReason: "research-unknown-outcome" });
      let run = this.runs.get(operation.runId);
      if (run.state === "running") run = this.runs.transition(operation.runId, "paused", { reason: "unknown-outcome",
        details: { requestId, reservationId }, actor: { type: "system", id: "m5c-research-bridge" } });
      if (run.state !== "paused" || run.reason !== "unknown-outcome") throw new M5CResearchConflictError("research run is not paused for an unknown outcome");
      return Object.freeze({ research, article, run });
    }).immediate();
  }

  get(requestId) {
    const binding = this.#binding(requestId); return Object.freeze({ binding: Object.freeze(binding), ...this.foundation.getRequest(requestId) });
  }

  #binding(requestId) {
    const row = this.database.prepare("SELECT request_id AS requestId, workflow_id AS workflowId, plan_revision_id AS planRevisionId, anchor_task_id AS anchorTaskId, origin_type AS originType, origin_id AS originId, created_at AS createdAt FROM m5c_research_bindings WHERE workspace_id = ? AND request_id = ?")
      .get(this.workspaceId, requestId);
    if (!row) throw new M5CResearchConflictError("M5C research request not found"); return row;
  }

  #operation(reservationId, required = true) {
    const row = this.database.prepare(`SELECT reservation_id AS reservationId, request_id AS requestId, workflow_id AS workflowId,
      grant_id AS grantId, run_id AS runId, query_id AS queryId, category, operation_digest AS operationDigest, created_at AS createdAt
      FROM m5c_research_operations WHERE workspace_id = ? AND reservation_id = ?`).get(this.workspaceId, reservationId);
    if (!row && required) throw new M5CResearchConflictError("M5C research operation not found"); return row ?? null;
  }

  #researchUsage(category, usage) {
    return Object.freeze({ searchCalls: category === "search" ? usage.calls : 0,
      contentUrls: category === "fetch" ? usage.calls : 0,
      modelTokens: category === "research" ? usage.inputTokens + usage.outputTokens : 0,
      costMicrosUsd: usage.costMicrosUsd });
  }

  #entryUsage(entry) {
    return Object.freeze({ searchCalls: entry.searchCalls, contentUrls: entry.contentUrls,
      modelTokens: entry.modelTokens, costMicrosUsd: entry.costMicrosUsd });
  }

  #sameResearchUsage(left, right) {
    return ["searchCalls", "contentUrls", "modelTokens", "costMicrosUsd"].every((key) => left[key] === right[key]);
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
