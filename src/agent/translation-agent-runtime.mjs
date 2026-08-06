import { createHash } from "node:crypto";
import { providerRequestContract, providerResponseContract } from "../provider/contracts.mjs";
import { TranslationFlowBudgetService } from "../m5c/flow-budget-service.mjs";
import { AgentRuntimeLedgerService } from "./runtime-ledger-service.mjs";
import { runAgentHostProcess } from "./host-process.mjs";
import { AgentTranslationToolGateway } from "./translation-tool-gateway.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export function createAgentTranslationInvoker(database, workspaceId, { invokeRound, invokeNoToolProvider, toolGateway, runHost = runAgentHostProcess,
  ledger, flowBudgets, runnerIdentity, estimateProvider } = {}) {
  if (typeof invokeRound !== "function") throw new TypeError("Agent model round invoker is required");
  const budgets = flowBudgets ?? new TranslationFlowBudgetService(database, workspaceId);
  const facts = ledger ?? new AgentRuntimeLedgerService(database, workspaceId, { flowBudgets: budgets });
  const gateway = toolGateway ?? new AgentTranslationToolGateway(database, workspaceId);

  const invoke = async (input, { signal } = {}) => {
    const request = providerRequestContract(input); if (request.segments.length !== 1) throw Object.assign(new Error("Agent translation requires one segment"), { category: "policy", retryable: false });
    const toolNames = gateway.enabledTools(request.taskId);
    if (request.providerId !== "deepseek") {
      if (toolNames.length) throw Object.assign(new Error("Provider does not support translation tools"), { category: "policy", retryable: false });
      if (typeof invokeNoToolProvider !== "function") throw Object.assign(new Error("Provider is unavailable"), { category: "policy", retryable: false });
      return providerResponseContract(await invokeNoToolProvider(request, { signal }), request);
    }
    const parent = database.prepare("SELECT workflow_id AS workflowId, flow_budget_reservation_id AS reservationId FROM m5c_translation_attempt_bindings WHERE workspace_id = ? AND attempt_id = ?")
      .get(workspaceId, request.attemptId);
    if (parent) { const terminal = database.prepare("SELECT entry_type AS entryType FROM flow_budget_ledger WHERE workspace_id = ? AND workflow_id = ? AND reservation_id = ? AND entry_type <> 'reserved'")
      .get(workspaceId, parent.workflowId, parent.reservationId); if (!terminal) budgets.release(parent.workflowId, parent.reservationId, { reason: "replaced-by-agent-call-ledger" }); }
    const recovery = facts.recover(request.attemptId);
    if (recovery.action === "paused-unknown") throw Object.assign(new Error("Agent runtime has unknown work"), { category: "unknown-outcome", retryable: false });
    if (recovery.action === "paused-local-replay") throw Object.assign(new Error("Agent local tool requires manual resume"), { category: "manual-resume", retryable: false });
    if (recovery.action === "persist-candidate") {
      return providerResponseContract({ responseId: `agent-final-${recovery.final.translation.length}-${recovery.checkpoint.transcriptDigest.slice(-16)}`,
        providerId: request.providerId, modelId: request.modelId, candidates: [{ segmentId: request.segments[0].segmentId, text: recovery.final.translation, knowledgeNeeds: [] }],
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 } }, request);
    }
    const result = await runHost({ attempt: { attemptId: request.attemptId, taskId: request.taskId, providerId: request.providerId, modelId: request.modelId,
      targetLanguage: request.targetLanguage, sourceText: request.segments[0].sourceText, protected: request.segments[0].protected,
      toolNames, maxOutputTokens: request.maxOutputTokens }, ledger: facts, invokeRound,
      executeTool: (toolRequest, options) => gateway.execute(request.taskId, toolRequest, options),
      estimateTool: (_attempt, toolRequest) => gateway.estimate(request.taskId, toolRequest.toolName),
      ...(recovery.checkpoint ? { resumeCheckpoint: recovery.checkpoint } : {}), signal, ...(runnerIdentity ?? {}), ...(estimateProvider ? { estimateProvider } : {}) });
    const usage = result.providerUsage; const response = { responseId: `agent-${sha(JSON.stringify(result.final)).slice(7, 31)}`,
      providerId: request.providerId, modelId: request.modelId, candidates: [{ segmentId: request.segments[0].segmentId, text: result.final.translation, knowledgeNeeds: [] }],
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: 0, totalTokens: usage.inputTokens + usage.outputTokens } };
    return providerResponseContract(response, request);
  };
  Object.defineProperty(invoke, "managesFlowBudget", { value: true }); return invoke;
}
