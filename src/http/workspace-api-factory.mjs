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
import { KnowledgeProposalService } from "../search/knowledge-proposal-service.mjs";
import { KnowledgeIterationService } from "../knowledge/iteration-service.mjs";
import { randomBytes } from "node:crypto";
import { CapabilityAuthority } from "../runner/capability.mjs";
import { invokeProviderThroughRunner } from "../runner/provider-runner.mjs";

/**
 * Build the application facade for one trusted workspace. The HTTP layer only
 * supplies the workspace id; the manager resolves and verifies the filesystem
 * and database identity before any domain service is constructed.
 */
export function createWorkspaceApiFactory(workspaceManager, {
  providerConfiguration = null,
  translationMode = "fake",
  realProviderTimeoutMs = 120_000,
  realMaxOutputTokens = 4_096,
  realPricingVersion = "m6-real-pricing-v1",
  realInputMicrosPerMillion = 2_800_000,
  realOutputMicrosPerMillion = 5_600_000,
  realCachedInputMicrosPerMillion = 56_000,
  realSoftLimitMicros = 5_000_000,
  realHardLimitMicros = 10_000_000,
  realRunnerUid = 65_532,
  realRunnerGid = 65_532,
} = {}) {
  if (!workspaceManager || typeof workspaceManager.open !== "function") throw new TypeError("workspace manager is required");
  if (!new Set(["fake", "real"]).has(translationMode)) throw new TypeError("translation mode is invalid");
  if (translationMode === "real" && (!providerConfiguration || typeof providerConfiguration.resolveExecutionSource !== "function" || typeof providerConfiguration.invokeSource !== "function")) throw new TypeError("real translation provider configuration is required");
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
    const knowledgeProposals = new KnowledgeProposalService(handle.database, handle.record.workspaceId);
    const knowledgeIterations = new KnowledgeIterationService(handle.root, handle.database, handle.record.workspaceId, { facts: manualKnowledge.facts, retriever, proposals: knowledgeProposals });
    const offlineBudgets = new PricingBudgetService(handle.database, handle.record.workspaceId);
    const pricingVersion = translationMode === "real" ? realPricingVersion : "m6-fake-v1";
    const policyVersion = translationMode === "real" ? "m6-real-policy" : "m6-fake-policy";
    if (translationMode === "fake" && !handle.database.prepare("SELECT 1 FROM pricing_snapshots WHERE workspace_id = ? AND provider_id = 'deepseek' AND model_id = 'deepseek-v4-flash' AND pricing_version = 'm6-fake-v1'").get(handle.record.workspaceId)) offlineBudgets.addPricing({ providerId: "deepseek", modelId: "deepseek-v4-flash", pricingVersion: "m6-fake-v1", currency: "CNY", inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0, source: "m6-offline-fixture" });
    if (!handle.database.prepare("SELECT 1 FROM budget_policy_snapshots WHERE workspace_id = ? AND policy_version = ?").get(handle.record.workspaceId, policyVersion)) offlineBudgets.addPolicy({ policyVersion, currency: "CNY", softLimitMicros: translationMode === "real" ? realSoftLimitMicros : 100_000_000, hardLimitMicros: translationMode === "real" ? realHardLimitMicros : 100_000_000, unknownPriceAction: "block" });
    const capabilityAuthority = translationMode === "real" ? new CapabilityAuthority(randomBytes(32)) : null;
    const realInvoke = async (request, { signal } = {}) => {
      const source = await providerConfiguration.resolveExecutionSource(request.providerId, request.modelId);
      const adapterRequest = { ...request, providerId: source.adapterId };
      const response = await invokeProviderThroughRunner({ request: adapterRequest,
        invokeProvider: (brokerRequest, options) => providerConfiguration.invokeSource(source, brokerRequest, { signal: options.signal, timeoutMs: realProviderTimeoutMs }),
        providerOptions: { credentialRef: source.credentialRef }, capabilityAuthority, signal,
        runnerIdentity: { uid: realRunnerUid, gid: realRunnerGid }, limits: { runtimeMs: realProviderTimeoutMs } });
      return Object.freeze({ ...response, providerId: request.providerId });
    };
    const baseExecutor = new TranslationExecutor(handle.database, handle.record.workspaceId, {
      invokeProvider: translationMode === "real" ? realInvoke : (request) => new DeterministicFakeProvider({ id: request.providerId }).invoke(request),
      credentialRef: translationMode === "real" ? "file:provider/selected" : "fixture:m6-offline", pricingVersion, estimatedOutputTokens: translationMode === "real" ? realMaxOutputTokens : 1_024,
      workerId: translationMode === "real" ? "m6-real-runner" : "m6-fake-runner", budgets: offlineBudgets,
    });
    const translationExecutor = { executeNext: async () => {
      const pending = handle.database.prepare("SELECT task.task_id AS taskId, attempt.provider_id AS providerId, attempt.model_id AS modelId FROM translation_tasks task JOIN translation_attempts attempt ON attempt.workspace_id = task.workspace_id AND attempt.task_id = task.task_id WHERE task.workspace_id = ? AND task.state IN ('queued','running') AND attempt.state IN ('queued','leased','running') AND NOT EXISTS (SELECT 1 FROM task_budget_assignments WHERE workspace_id = task.workspace_id AND task_id = task.task_id) ORDER BY task.created_at, attempt.created_at LIMIT 1").get(handle.record.workspaceId);
      if (pending) {
        if (translationMode === "real") {
          if (!handle.database.prepare("SELECT 1 FROM pricing_snapshots WHERE workspace_id = ? AND provider_id = ? AND model_id = ? AND pricing_version = ?").get(handle.record.workspaceId, pending.providerId, pending.modelId, pricingVersion)) offlineBudgets.addPricing({ providerId: pending.providerId, modelId: pending.modelId, pricingVersion, currency: "CNY", inputMicrosPerMillion: realInputMicrosPerMillion, outputMicrosPerMillion: realOutputMicrosPerMillion, cachedInputMicrosPerMillion: realCachedInputMicrosPerMillion, source: "configured-real-provider-pricing" });
        } else if (!handle.database.prepare("SELECT 1 FROM pricing_snapshots WHERE workspace_id = ? AND provider_id = ? AND model_id = ? AND pricing_version = 'm6-fake-v1'").get(handle.record.workspaceId, pending.providerId, pending.modelId)) offlineBudgets.addPricing({ providerId: pending.providerId, modelId: pending.modelId, pricingVersion: "m6-fake-v1", currency: "CNY", inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0, source: "m6-offline-fixture" });
        offlineBudgets.assignTask(pending.taskId, policyVersion);
      }
      return baseExecutor.executeNext();
    } };
    const api = new WorkflowApi({ imports, reimports, flowPlans, contexts, translationExecutor, recovery, m5cQa, remediation, workCopies, validation, quality, reviews, exports, retriever, manualKnowledge, knowledgeProposals, knowledgeIterations });
    return Object.freeze({ api, close: () => handle.database.close() });
  };
}
