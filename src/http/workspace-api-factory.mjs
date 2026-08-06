import { DocumentImportService } from "../document/import-service.mjs";
import { ReimportService } from "../document/reimport-service.mjs";
import { WorkflowApi } from "../application/workflow-api.mjs";
import { FlowPlanService } from "../m5c/flow-plan-service.mjs";
import { WorkCopyService } from "../translation/work-copy-service.mjs";
import { ValidationService } from "../translation/validator.mjs";
import { QualityService } from "../quality/quality-service.mjs";
import { ReviewService } from "../translation/review-service.mjs";
import { ExportService } from "../export/export-service.mjs";
import { TemporaryContextService } from "../m5c/temporary-context-service.mjs";
import { FlowRecoveryService } from "../m5c/flow-recovery-service.mjs";
import { M5CQAService } from "../m5c/qa-service.mjs";
import { M5CRemediationService } from "../m5c/remediation-service.mjs";
import { TranslationExecutor } from "../provider/translation-executor.mjs";
import { DeterministicFakeProvider } from "../provider/fake-provider.mjs";
import { PricingBudgetService } from "../provider/cost-budget.mjs";
import { FtsRetriever } from "../knowledge/fts-retriever.mjs";
import { ManualKnowledgeService } from "../knowledge/manual-knowledge-service.mjs";

/**
 * Build the application facade for one trusted workspace. The HTTP layer only
 * supplies the workspace id; the manager resolves and verifies the filesystem
 * and database identity before any domain service is constructed.
 */
export function createWorkspaceApiFactory(workspaceManager) {
  if (!workspaceManager || typeof workspaceManager.open !== "function") throw new TypeError("workspace manager is required");
  return (workspaceId) => {
    const handle = workspaceManager.open(workspaceId);
    const options = { database: handle.database, root: handle.root, trustedWorkspaceId: handle.record.workspaceId };
    const imports = new DocumentImportService(options);
    const reimports = new ReimportService(options);
    const flowPlans = new FlowPlanService(handle.database, handle.record.workspaceId);
    const workCopies = new WorkCopyService(handle.database, handle.record.workspaceId);
    const validation = new ValidationService(handle.database, handle.record.workspaceId, { workCopies });
    const quality = new QualityService(handle.database, handle.record.workspaceId, { workCopies, validation });
    const reviews = new ReviewService(handle.database, handle.record.workspaceId, { validation, quality });
    const exports = new ExportService({ ...options, workCopies, validation, quality });
    const contexts = new TemporaryContextService(handle.database, handle.record.workspaceId);
    const recovery = new FlowRecoveryService(handle.database, handle.record.workspaceId, { contexts, tasks: contexts.tasks, budgets: contexts.budgets });
    const m5cQa = new M5CQAService(handle.database, handle.record.workspaceId, { workCopies });
    const remediation = new M5CRemediationService(handle.database, handle.record.workspaceId, { contexts, budgets: contexts.budgets });
    const fts = new FtsRetriever(handle.root, handle.database, handle.record.workspaceId);
    const retriever = { search: async (request) => { try { fts.manifest(); } catch { await fts.rebuild(); } return fts.search(request); }, rebuild: () => fts.rebuild(), manifest: () => fts.manifest() };
    const manualKnowledge = new ManualKnowledgeService({ root: handle.root, database: handle.database, workspaceId: handle.record.workspaceId, retriever });
    const offlineBudgets = new PricingBudgetService(handle.database, handle.record.workspaceId);
    if (!handle.database.prepare("SELECT 1 FROM pricing_snapshots WHERE workspace_id = ? AND provider_id = 'deepseek' AND model_id = 'deepseek-v4-flash' AND pricing_version = 'm6-fake-v1'").get(handle.record.workspaceId)) offlineBudgets.addPricing({ providerId: "deepseek", modelId: "deepseek-v4-flash", pricingVersion: "m6-fake-v1", currency: "CNY", inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0, source: "m6-offline-fixture" });
    if (!handle.database.prepare("SELECT 1 FROM budget_policy_snapshots WHERE workspace_id = ? AND policy_version = 'm6-fake-policy'").get(handle.record.workspaceId)) offlineBudgets.addPolicy({ policyVersion: "m6-fake-policy", currency: "CNY", softLimitMicros: 100_000_000, hardLimitMicros: 100_000_000, unknownPriceAction: "block" });
    const baseExecutor = new TranslationExecutor(handle.database, handle.record.workspaceId, {
      invokeProvider: (request) => new DeterministicFakeProvider({ id: request.providerId }).invoke(request), credentialRef: "fixture:m6-offline", pricingVersion: "m6-fake-v1", workerId: "m6-fake-runner", budgets: offlineBudgets,
    });
    const translationExecutor = { executeNext: async () => {
      const pending = handle.database.prepare("SELECT task.task_id AS taskId, attempt.provider_id AS providerId, attempt.model_id AS modelId FROM translation_tasks task JOIN translation_attempts attempt ON attempt.workspace_id = task.workspace_id AND attempt.task_id = task.task_id WHERE task.workspace_id = ? AND task.state IN ('queued','running') AND attempt.state IN ('queued','leased','running') AND NOT EXISTS (SELECT 1 FROM task_budget_assignments WHERE workspace_id = task.workspace_id AND task_id = task.task_id) ORDER BY task.created_at, attempt.created_at LIMIT 1").get(handle.record.workspaceId);
      if (pending) {
        if (!handle.database.prepare("SELECT 1 FROM pricing_snapshots WHERE workspace_id = ? AND provider_id = ? AND model_id = ? AND pricing_version = 'm6-fake-v1'").get(handle.record.workspaceId, pending.providerId, pending.modelId)) offlineBudgets.addPricing({ providerId: pending.providerId, modelId: pending.modelId, pricingVersion: "m6-fake-v1", currency: "CNY", inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0, source: "m6-offline-fixture" });
        offlineBudgets.assignTask(pending.taskId, "m6-fake-policy");
      }
      return baseExecutor.executeNext();
    } };
    const api = new WorkflowApi({ imports, reimports, flowPlans, contexts, translationExecutor, recovery, m5cQa, remediation, workCopies, validation, quality, reviews, exports, retriever, manualKnowledge });
    return Object.freeze({ api, close: () => handle.database.close() });
  };
}
