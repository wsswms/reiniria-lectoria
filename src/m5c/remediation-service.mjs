import { TemporaryContextService } from "./temporary-context-service.mjs";
import { TranslationFlowBudgetService } from "./flow-budget-service.mjs";

export class RemediationConflictError extends Error {
  constructor(message = "M5C remediation conflict") { super(message); this.name = "RemediationConflictError"; this.code = "REMEDIATION_CONFLICT"; }
}

export class M5CRemediationService {
  constructor(database, trustedWorkspaceId, { now = () => new Date(), contexts = null, budgets = null } = {}) {
    this.database = database; this.workspaceId = trustedWorkspaceId; this.now = now;
    this.budgets = budgets ?? new TranslationFlowBudgetService(database, trustedWorkspaceId, { now });
    this.contexts = contexts ?? new TemporaryContextService(database, trustedWorkspaceId, { now, budgets: this.budgets });
  }

  retranslate(qaRunId, findingIds, request, actor) {
    if (!actor || actor.type !== "user" || typeof actor.id !== "string" || !actor.id) throw new RemediationConflictError("only a user can request retranslation");
    if (!Array.isArray(findingIds) || findingIds.length === 0 || new Set(findingIds).size !== findingIds.length) throw new TypeError("findingIds must be a unique non-empty array");
    const run = this.database.prepare("SELECT workflow_id AS workflowId FROM m5c_qa_runs WHERE workspace_id = ? AND qa_run_id = ?")
      .get(this.workspaceId, qaRunId); if (!run) throw new RemediationConflictError("QA run not found");
    const rows = this.database.prepare(`SELECT finding.finding_id AS findingId, finding.segment_id AS segmentId, decision.decision
      FROM m5c_qa_findings finding LEFT JOIN m5c_qa_finding_decisions decision
        ON decision.workspace_id = finding.workspace_id AND decision.qa_run_id = finding.qa_run_id AND decision.finding_id = finding.finding_id
      WHERE finding.workspace_id = ? AND finding.qa_run_id = ? AND finding.finding_id IN (${findingIds.map(() => "?").join(",")})`)
      .all(this.workspaceId, qaRunId, ...findingIds);
    if (rows.length !== findingIds.length || rows.some((row) => row.decision !== "retranslate" || !row.segmentId)) throw new RemediationConflictError("every finding must have a user retranslate decision and segment scope");
    const flow = this.database.prepare("SELECT retranslation_count AS count FROM translation_flow_controls WHERE workspace_id = ? AND workflow_id = ?")
      .get(this.workspaceId, run.workflowId); const policy = this.budgets.get(run.workflowId).policy;
    if (flow.count >= policy.maxRetranslations) throw new RemediationConflictError("retranslation stop line reached");
    const reservationId = `retranslation:${request.idempotencyKey}`;
    const prior = this.database.prepare("SELECT task_id AS taskId FROM m5c_translation_attempt_bindings WHERE workspace_id = ? AND workflow_id = ? AND flow_budget_reservation_id = ? LIMIT 1")
      .get(this.workspaceId, run.workflowId, reservationId);
    if (prior) return Object.freeze({ reused: true, taskId: prior.taskId, flowBudgetReservationId: reservationId });
    const result = this.contexts.enqueueTranslation(run.workflowId, { ...request, segmentIds: [...new Set(rows.map((row) => row.segmentId))],
      budgetCategory: "retranslation", flowBudgetReservationId: reservationId });
    const changed = this.database.prepare("UPDATE translation_flow_controls SET flow_state = 'remediation', retranslation_count = retranslation_count + 1, version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND retranslation_count = ?")
      .run(this.now().toISOString(), this.workspaceId, run.workflowId, flow.count).changes;
    if (changed !== 1) throw new RemediationConflictError("retranslation concurrency conflict");
    return Object.freeze({ ...result, reused: false });
  }
}
