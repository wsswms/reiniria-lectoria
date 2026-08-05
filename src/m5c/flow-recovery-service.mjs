import { randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { TranslationTaskOrchestrator } from "../provider/task-orchestrator.mjs";
import { contentDigest } from "./contracts.mjs";
import { TranslationFlowBudgetService } from "./flow-budget-service.mjs";
import { TemporaryContextService } from "./temporary-context-service.mjs";

export class FlowRecoveryConflictError extends Error {
  constructor(message = "M5C flow recovery conflict") {
    super(message); this.name = "FlowRecoveryConflictError"; this.code = "FLOW_RECOVERY_CONFLICT";
  }
}

function user(input) {
  if (!input || input.type !== "user" || typeof input.id !== "string" || !input.id) {
    throw new FlowRecoveryConflictError("only a user can resolve a paused flow");
  }
  return input;
}

const NEXT_STATE = Object.freeze({
  "planner-unknown-outcome": "planning",
  "research-unknown-outcome": "research",
  "translation-unknown-outcome": "translating",
  "translation-failed": "translating",
  "qa-unknown-outcome": "qa",
});

export class FlowRecoveryService {
  constructor(database, trustedWorkspaceId, { id = () => randomUUID(), now = () => new Date(), budgets = null, tasks = null, contexts = null } = {}) {
    this.database = database; this.workspaceId = trustedWorkspaceId; this.id = id; this.now = now;
    this.budgets = budgets ?? new TranslationFlowBudgetService(database, trustedWorkspaceId, { id, now });
    this.tasks = tasks ?? new TranslationTaskOrchestrator(database, trustedWorkspaceId, { id, now });
    this.contexts = contexts ?? new TemporaryContextService(database, trustedWorkspaceId, { id, now, budgets: this.budgets, tasks: this.tasks });
  }

  resolve(workflowId, expectedVersion, action, request, actorInput) {
    const by = user(actorInput);
    if (!new Set(["continue-local", "retry", "terminate"]).has(action)) throw new TypeError("invalid flow recovery action");
    const requestDigest = contentDigest({ action, request: request ?? null });
    return this.database.transaction(() => {
      const prior = this.database.prepare(`SELECT result_json AS resultJson, request_digest AS requestDigest
        FROM translation_flow_recovery_decisions WHERE workspace_id = ? AND workflow_id = ? AND paused_version = ?`)
        .get(this.workspaceId, workflowId, expectedVersion);
      if (prior) {
        if (prior.requestDigest !== requestDigest) throw new FlowRecoveryConflictError("recovery idempotency conflict");
        return Object.freeze(JSON.parse(prior.resultJson));
      }
      const flow = this.#flow(workflowId);
      if (flow.version !== expectedVersion || flow.flowState !== "paused" || !["unknown", "failed"].includes(flow.outcomeState)) {
        throw new FlowRecoveryConflictError("a matching paused unknown or failed flow is required");
      }
      if (action === "continue-local" && flow.pauseReason !== "planner-unknown-outcome") {
        throw new FlowRecoveryConflictError("continue-local only applies to an unknown Planner outcome");
      }
      if (action !== "terminate" && flow.outcomeState === "unknown") {
        const budget = this.budgets.get(workflowId);
        if (budget.unknownOutcomes >= budget.policy.maxUnknownOutcomes) {
          throw new FlowRecoveryConflictError("the user must expand the unknown outcome stop line before continuing");
        }
      }
      const nextState = action === "terminate" ? "canceled" : NEXT_STATE[flow.pauseReason];
      if (!nextState) throw new FlowRecoveryConflictError("pause reason has no recovery path");
      let retryTask = null;
      if (action === "retry" && (flow.pauseReason === "translation-unknown-outcome" || flow.pauseReason === "translation-failed")) {
        if (!request || typeof request.idempotencyKey !== "string" || !request.idempotencyKey) throw new FlowRecoveryConflictError("translation retry request is required");
        const segmentIds = this.#unresolvedTranslationSegments(workflowId);
        if (!segmentIds.length) throw new FlowRecoveryConflictError("no unresolved translation segments remain");
        retryTask = this.contexts.enqueueTranslation(workflowId, { ...request, segmentIds });
      } else if (action === "retry" && !["research-unknown-outcome", "qa-unknown-outcome"].includes(flow.pauseReason)) {
        throw new FlowRecoveryConflictError("retry is not valid for this pause reason");
      }
      const timestamp = this.now().toISOString();
      const result = Object.freeze({ workflowId, action, previousPauseReason: flow.pauseReason, flowState: nextState,
        outcomeState: action === "terminate" ? "failed" : "none", ...(retryTask ? { taskId: retryTask.task.task.task_id } : {}) });
      if (action === "terminate" || retryTask) {
        const oldTasks = this.database.prepare("SELECT task_id AS taskId FROM translation_tasks WHERE workspace_id = ? AND workflow_id = ? AND state IN ('queued','running','paused')")
          .all(this.workspaceId, workflowId);
        for (const item of oldTasks) if (!retryTask || item.taskId !== retryTask.task.task.task_id) this.tasks.cancel(item.taskId);
      }
      const changed = this.database.prepare(`UPDATE translation_flow_controls SET flow_state = ?, outcome_state = ?, pause_reason = NULL,
        version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND version = ? AND flow_state = 'paused'`)
        .run(result.flowState, result.outcomeState, timestamp, this.workspaceId, workflowId, expectedVersion).changes;
      if (changed !== 1) throw new FlowRecoveryConflictError("flow recovery version conflict");
      this.database.prepare("INSERT INTO translation_flow_recovery_decisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?)")
        .run(this.workspaceId, this.id(), workflowId, expectedVersion, action, flow.pauseReason, requestDigest, stableJson(result), by.id, timestamp);
      return result;
    }).immediate();
  }

  #unresolvedTranslationSegments(workflowId) {
    return this.database.prepare(`SELECT DISTINCT attempt.segment_id AS segmentId
      FROM translation_attempts attempt
      JOIN attempt_runtime_states runtime ON runtime.workspace_id = attempt.workspace_id AND runtime.attempt_id = attempt.attempt_id
      JOIN m5c_translation_attempt_bindings binding ON binding.workspace_id = attempt.workspace_id AND binding.attempt_id = attempt.attempt_id
      JOIN translation_tasks task ON task.workspace_id = attempt.workspace_id AND task.task_id = attempt.task_id
      WHERE attempt.workspace_id = ? AND attempt.workflow_id = ? AND task.state IN ('paused','failed')
        AND runtime.attempt_number = (SELECT max(other.attempt_number) FROM attempt_runtime_states other
          WHERE other.workspace_id = runtime.workspace_id AND other.task_id = runtime.task_id AND other.segment_id = runtime.segment_id)
        AND attempt.state <> 'completed' ORDER BY attempt.segment_id`).all(this.workspaceId, workflowId).map((row) => row.segmentId);
  }

  #flow(workflowId) {
    const row = this.database.prepare(`SELECT workflow_id AS workflowId, flow_state AS flowState, outcome_state AS outcomeState,
      pause_reason AS pauseReason, version FROM translation_flow_controls WHERE workspace_id = ? AND workflow_id = ?`)
      .get(this.workspaceId, workflowId);
    if (!row) throw new FlowRecoveryConflictError("M5C flow not found"); return row;
  }
}
