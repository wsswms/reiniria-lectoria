import assert from "node:assert/strict";
import test from "node:test";
import { createAgentTranslationInvoker } from "../../src/agent/translation-agent-runtime.mjs";
import { PricingBudgetService } from "../../src/provider/cost-budget.mjs";
import { providerResponseContract } from "../../src/provider/contracts.mjs";
import { buildContextManifest } from "../../src/provider/prompt-context.mjs";
import { TranslationExecutor } from "../../src/provider/translation-executor.mjs";
import { TranslationToolConfigurationService } from "../../src/tools/translation-tool-configuration-service.mjs";
import { enqueueInput, orchestrator, seedWorkflow, workspace } from "../m4-3/helpers.mjs";
import { researchWorkspace } from "../m5r-2/helpers.mjs";

const sha = (value) => `sha256:${"a".repeat(64 - value.length)}${value}`;
const configuration = (enabled = true) => ({ schemaVersion: "translation-tool-configuration-v1",
  dictionary: enabled ? { providerId: "deepseek-flash", providerVersion: "flash-v1", maxCalls: 2, maxCostMicrosUsd: 100, allowedDomains: ["dictionary.cambridge.org"] } : null,
  entity: null, number: enabled ? { providerId: "local-number", providerVersion: "local-number-v1", maxCalls: 2 } : null });

async function fixture() {
  const value = await researchWorkspace(); const segment = value.setup.fixture.database.prepare("SELECT segment_id AS segmentId, source_digest AS sourceDigest, source_text AS sourceText, protected_json AS protectedJson FROM source_segment_versions WHERE workspace_id = ? AND source_revision_id = ? ORDER BY ordinal LIMIT 1")
    .get(value.setup.fixture.workspaceId, value.setup.workflow.sourceRevisionId);
  const attempt = value.bound.task.attempts[0];
  const request = { workspaceId: value.setup.fixture.workspaceId, taskId: attempt.task_id, attemptId: attempt.attempt_id, workflowId: value.setup.workflow.workflowId,
    sourceRevisionId: value.setup.workflow.sourceRevisionId, targetLanguage: "zh-CN", providerId: "deepseek", modelId: "deepseek-chat", maxOutputTokens: 1024,
    promptVersion: attempt.prompt_version, contextDigest: attempt.context_digest, segments: [{ segmentId: segment.segmentId, sourceDigest: segment.sourceDigest,
      sourceText: segment.sourceText, protected: JSON.parse(segment.protectedJson) }] };
  return { value, request, taskId: attempt.task_id, configurations: new TranslationToolConfigurationService(value.setup.fixture.database, value.setup.fixture.workspaceId) };
}

test("Agent runtime freezes enabled tools, binds final to Host output, and leaves tool results out of approved knowledge", async () => {
  const f = await fixture(); try {
    f.configurations.bind(f.taskId, configuration()); let hostAttempt;
    const invoke = createAgentTranslationInvoker(f.value.setup.fixture.database, f.value.setup.fixture.workspaceId, {
      invokeRound: async () => { throw new Error("round should be owned by Host"); }, ledger: { recover: () => ({ action: "start-host" }) },
      runHost: async (input) => { hostAttempt = input.attempt; return { status: "completed", final: { translation: "工作区" }, providerUsage: { calls: 1, inputTokens: 10, outputTokens: 4, costMicrosCny: 10, costMicrosUsd: 0, durationMs: 1 }, toolReceiptDigests: [], checkpoints: [] }; },
      toolGateway: { enabledTools: () => ["lookup_dictionary", "calculate_number"], execute: async () => { throw new Error("not called"); }, estimate: () => ({ calls: 1, inputTokens: 1, outputTokens: 1, costMicrosCny: 1, costMicrosUsd: 0, durationMs: 1 }) },
    });
    const response = await invoke(f.request); assert.deepEqual(hostAttempt.toolNames, ["lookup_dictionary", "calculate_number"]);
    assert.equal(response.candidates[0].text, "工作区"); assert.deepEqual(response.candidates[0].knowledgeNeeds, []);
  } finally { await f.value.close(); }
});

test("OpenAI/Gemini tool tasks reject before any external provider call, while disabled tools retain no-tool compatibility", async () => {
  const f = await fixture(); try {
    f.configurations.bind(f.taskId, configuration()); let calls = 0;
    const invoke = createAgentTranslationInvoker(f.value.setup.fixture.database, f.value.setup.fixture.workspaceId, {
      invokeRound: async () => { calls += 1; throw new Error("unexpected"); }, invokeNoToolProvider: async () => { calls += 1; return null; },
      toolGateway: { enabledTools: () => ["lookup_dictionary"], execute: async () => null, estimate: () => ({}) }, ledger: { recover: () => ({ action: "start-host" }) }, runHost: async () => null,
    });
    await assert.rejects(() => invoke({ ...f.request, providerId: "openai" }), (error) => error.category === "policy"); assert.equal(calls, 0);
    const disabled = createAgentTranslationInvoker(f.value.setup.fixture.database, f.value.setup.fixture.workspaceId, {
      invokeRound: async () => { calls += 1; return { assistantMessage: {}, usage: {} }; }, invokeNoToolProvider: async (request) => { calls += 1; return {
        responseId: "gemini-no-tool", providerId: request.providerId, modelId: request.modelId,
        candidates: [{ segmentId: request.segments[0].segmentId, text: "无工具兼容译文", knowledgeNeeds: [] }],
        usage: { inputTokens: 2, outputTokens: 2, cachedInputTokens: 0, totalTokens: 4 } }; },
      toolGateway: { enabledTools: () => [], execute: async () => null, estimate: () => ({}) }, ledger: { recover: () => ({ action: "start-host" }) }, runHost: async () => null,
    });
    const compatible = await disabled({ ...f.request, providerId: "gemini" }); assert.equal(compatible.candidates[0].text, "无工具兼容译文"); assert.equal(calls, 1);
  } finally { await f.value.close(); }
});

test("Agent final enters the existing strict Validator and immutable machine-candidate chain", async () => {
  const value = await workspace(); try {
    const workflow = seedWorkflow(value, { sourceText: "Focal length is 50mm." });
    const context = buildContextManifest(value.database, value.workspaceId, { workflowId: workflow.workflowId, segmentIds: [workflow.segmentId] });
    const tasks = orchestrator(value); const created = tasks.enqueue(enqueueInput(workflow, "m5p-agent-chain", { providerId: "deepseek", modelId: "deepseek-chat",
      promptVersion: context.manifest.promptVersion, contextDigest: context.contextDigest, maxAttempts: 1 }));
    const budgets = new PricingBudgetService(value.database, value.workspaceId, { now: value.clock.now });
    budgets.addPricing({ providerId: "deepseek", modelId: "deepseek-chat", pricingVersion: "m5p-price", currency: "CNY",
      inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, cachedInputMicrosPerMillion: 0, source: "offline-fixture" });
    budgets.addPolicy({ policyVersion: "m5p-budget", currency: "CNY", softLimitMicros: 100_000, hardLimitMicros: 200_000, unknownPriceAction: "block" });
    budgets.assignTask(created.task.task_id, "m5p-budget");
    const invoke = async (request) => providerResponseContract({ responseId: "agent-final", providerId: request.providerId, modelId: request.modelId,
      candidates: [{ segmentId: request.segments[0].segmentId, text: "焦距为50mm。", knowledgeNeeds: [] }],
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, totalTokens: 15 } }, request);
    Object.defineProperty(invoke, "managesFlowBudget", { value: true });
    const result = await new TranslationExecutor(value.database, value.workspaceId, { invokeProvider: invoke, credentialRef: "external-file:deepseek/m5p-agent",
      pricingVersion: "m5p-price", workerId: "m5p-agent", now: value.clock.now, orchestrator: tasks, budgets }).executeNext();
    assert.equal(result.status, "completed"); assert.equal(value.database.prepare("SELECT text FROM translation_candidates").get().text, "焦距为50mm。");
    assert.equal(value.database.prepare("SELECT count(*) AS total FROM machine_candidate_provenance").get().total, 1);
    assert.equal(value.database.prepare("SELECT state FROM translation_tasks WHERE task_id = ?").get(created.task.task_id).state, "completed");
  } finally { await value.close(); }
});
