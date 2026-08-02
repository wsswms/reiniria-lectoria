import { contentDigest, budgetUsageContract } from "./contracts.mjs";
import { M5CQAService } from "./qa-service.mjs";
import { TranslationFlowBudgetService } from "./flow-budget-service.mjs";
import { WorkCopyService } from "../translation/work-copy-service.mjs";
import { isUncertainProviderOutcome } from "./provider-outcome.mjs";

export class ModelQAExecutionError extends Error {
  constructor(message = "model QA execution failed", category = "provider", providerCode) { super(message); this.name = "ModelQAExecutionError"; this.code = "MODEL_QA_EXECUTION_FAILED"; this.category = category;
    if (providerCode !== undefined) this.providerCode = String(providerCode); }
}

export class M5CModelQAExecutor {
  constructor(database, trustedWorkspaceId, { invokeModelQa, now = () => new Date(), budgets = null, qa = null, workCopies = null } = {}) {
    if (typeof invokeModelQa !== "function") throw new TypeError("invokeModelQa is required");
    this.database = database; this.workspaceId = trustedWorkspaceId; this.invokeModelQa = invokeModelQa; this.now = now;
    this.workCopies = workCopies ?? new WorkCopyService(database, trustedWorkspaceId, { now });
    this.budgets = budgets ?? new TranslationFlowBudgetService(database, trustedWorkspaceId, { now });
    this.qa = qa ?? new M5CQAService(database, trustedWorkspaceId, { now, workCopies: this.workCopies, budgets: this.budgets });
  }

  async execute(workflowId, { providerId, modelId, idempotencyKey, segmentIds = null, estimatedUsage, scope = "full" }) {
    for (const [value, name] of [[providerId, "providerId"], [modelId, "modelId"], [idempotencyKey, "idempotencyKey"]])
      if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} is required`);
    const bundle = this.workCopies.getBundle(workflowId);
    const included = segmentIds === null ? bundle.segments : bundle.segments.filter((segment) => segmentIds.includes(segment.segmentId));
    if (!included.length || (segmentIds && included.length !== new Set(segmentIds).size)) throw new ModelQAExecutionError("model QA segment scope mismatch", "policy");
    const workflow = this.database.prepare("SELECT source_revision_id AS sourceRevisionId, target_language AS targetLanguage FROM translation_workflows WHERE workspace_id = ? AND workflow_id = ?")
      .get(this.workspaceId, workflowId);
    const request = Object.freeze({ schemaVersion: "m5c-model-qa-request-v1", workflowId, sourceRevisionId: workflow.sourceRevisionId,
      targetLanguage: workflow.targetLanguage, workingCopyDigest: bundle.digest, scope,
      segments: Object.freeze(included.map((segment) => Object.freeze({ segmentId: segment.segmentId, sourceText: segment.sourceText, targetText: segment.text,
        targetDigest: segment.textDigest }))) });
    const reservationId = `qa:${idempotencyKey}`; const estimate = budgetUsageContract(estimatedUsage);
    this.budgets.reserve(workflowId, "qa", reservationId, estimate, { providerId, modelId, requestDigest: contentDigest(request) });
    let response;
    try { response = await this.invokeModelQa(request, { providerId, modelId }); }
    catch (error) {
      const category = error?.category ?? "provider";
      if (isUncertainProviderOutcome(category)) this.budgets.unknown(workflowId, reservationId,
        { providerId, modelId, category, pauseReason: "qa-unknown-outcome" });
      else this.budgets.release(workflowId, reservationId, { providerId, modelId, category });
      throw new ModelQAExecutionError("model QA execution failed", category, error?.providerCode);
    }
    if (!response || typeof response !== "object" || Array.isArray(response) || !Array.isArray(response.findings)
      || typeof response.responseId !== "string" || response.responseId.length === 0) {
      this.budgets.unknown(workflowId, reservationId,
        { providerId, modelId, category: "malformed-response", pauseReason: "qa-unknown-outcome" });
      throw new ModelQAExecutionError("model QA response is malformed", "malformed-response");
    }
    try {
      const usage = budgetUsageContract(response.usage); let run; let settlement;
      this.database.transaction(() => {
        run = this.qa.run(workflowId, { layers: ["invariant", "heuristic", "model"], scope, segmentIds,
          modelFindings: response.findings, model: { providerId, modelId, responseId: response.responseId, requestDigest: contentDigest(request) } });
        settlement = this.budgets.settle(workflowId, reservationId, usage, { qaRunId: run.qaRunId, responseId: response.responseId });
      }).immediate();
      return Object.freeze({ run, requestDigest: contentDigest(request), settlement });
    } catch {
      this.budgets.unknown(workflowId, reservationId,
        { providerId, modelId, category: "malformed-response", pauseReason: "qa-unknown-outcome" });
      throw new ModelQAExecutionError("model QA response is malformed", "malformed-response");
    }
  }
}
