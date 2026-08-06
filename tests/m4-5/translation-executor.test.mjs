import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createCredentialResolver, createProviderBroker } from "../../src/provider/broker-contract.mjs";
import { providerResponseContract } from "../../src/provider/contracts.mjs";
import { PricingBudgetService } from "../../src/provider/cost-budget.mjs";
import { invokeBrokerWithCredentialFile } from "../../src/provider/credential-file.mjs";
import { DEEPSEEK_API_ORIGIN, DEEPSEEK_PROVIDER_ID } from "../../src/provider/deepseek-provider.mjs";
import { GEMINI_API_ORIGIN, GEMINI_PROVIDER_ID } from "../../src/provider/gemini-provider.mjs";
import { OPENAI_API_ORIGIN, OPENAI_PROVIDER_ID } from "../../src/provider/openai-provider.mjs";
import { buildContextManifest } from "../../src/provider/prompt-context.mjs";
import { createProviderRegistry } from "../../src/provider/provider-registry.mjs";
import { TranslationExecutor } from "../../src/provider/translation-executor.mjs";
import { enqueueInput, orchestrator, seedWorkflow, workspace } from "../m4-3/helpers.mjs";

function configure(fixture, workflow, suffix = "executor", {
  providerId = "google-gemini",
  modelId = "gemini-fixture-flash",
  pricingVersion = "gemini-fixture-price",
} = {}) {
  const context = buildContextManifest(fixture.database, fixture.workspaceId, { workflowId: workflow.workflowId, segmentIds: [workflow.segmentId] });
  const tasks = orchestrator(fixture);
  const created = tasks.enqueue(enqueueInput(workflow, suffix, {
    providerId, modelId,
    promptVersion: context.manifest.promptVersion, contextDigest: context.contextDigest,
  }));
  const budgets = new PricingBudgetService(fixture.database, fixture.workspaceId, { now: fixture.clock.now });
  budgets.addPricing({
    providerId, modelId, pricingVersion,
    currency: "USD", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000,
    cachedInputMicrosPerMillion: 500_000, source: "offline-fixture",
  });
  budgets.addPolicy({ policyVersion: "executor-budget", currency: "USD", softLimitMicros: 100_000, hardLimitMicros: 200_000, unknownPriceAction: "block" });
  budgets.assignTask(created.task.task_id, "executor-budget");
  return { context, tasks, budgets, created };
}

function responseFor(request) {
  return providerResponseContract({
    responseId: "gemini-executor-response",
    providerId: request.providerId,
    modelId: request.modelId,
    candidates: request.segments.map((segment) => ({ segmentId: segment.segmentId, text: `翻译:${segment.sourceText}` })),
    usage: { inputTokens: 20, outputTokens: 10, cachedInputTokens: 0, totalTokens: 30 },
  }, request);
}

function adapterSuccess(url, init) {
  const outbound = JSON.parse(init.body);
  const origin = new URL(url).origin;
  const requestData = JSON.parse(origin === GEMINI_API_ORIGIN
    ? outbound.contents[0].parts[0].text
    : origin === OPENAI_API_ORIGIN ? outbound.input : outbound.messages[1].content);
  const candidates = requestData.segments.map((segment) => ({ segmentId: segment.segmentId, text: `translated:${segment.sourceText}`, knowledgeNeeds: [] }));
  if (origin === GEMINI_API_ORIGIN) return new Response(JSON.stringify({
    responseId: "gemini-chain-response",
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ candidates }) }] } }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 },
  }), { status: 200 });
  if (origin === OPENAI_API_ORIGIN) return new Response(JSON.stringify({
    id: "openai-chain-response", status: "completed", incomplete_details: null,
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ candidates }) }] }],
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 } },
  }), { status: 200 });
  if (origin === DEEPSEEK_API_ORIGIN) return new Response(JSON.stringify({
    id: "deepseek-chain-response",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ candidates }) } }],
    usage: { prompt_tokens: 20, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  }), { status: 200 });
  throw new Error("unexpected Provider origin");
}

test("budget-assigned attempts cannot lease before a reservation exists", async () => {
  const fixture = await workspace();
  try {
    const setup = configure(fixture, seedWorkflow(fixture));
    assert.equal(setup.tasks.leaseNext("worker"), null);
    setup.budgets.reserve(setup.created.attempts[0].attempt_id, "gemini-fixture-price", { inputTokens: 20, outputTokens: 10, cachedInputTokens: 0 });
    assert.ok(setup.tasks.leaseNext("worker"));
  } finally { await fixture.close(); }
});

test("executor completes task, normalized usage, budget reconciliation and immutable machine candidate atomically", async () => {
  const fixture = await workspace();
  try {
    const setup = configure(fixture, seedWorkflow(fixture, { sourceText: "Public source" }));
    let invocation;
    const executor = new TranslationExecutor(fixture.database, fixture.workspaceId, {
      pricingVersion: "gemini-fixture-price", credentialRef: "local:gemini/m4", workerId: "executor-1",
      now: fixture.clock.now, orchestrator: setup.tasks, budgets: setup.budgets,
      invokeProvider: async (request, options) => { invocation = { request, options }; return responseFor(request); },
    });
    const result = await executor.executeNext();
    assert.equal(result.status, "completed");
    assert.equal(invocation.request.maxOutputTokens, 1_024);
    assert.equal(invocation.options.credentialRef, "local:gemini/m4");
    assert.equal("credential" in invocation.options, false);
    assert.equal(setup.tasks.getTask(setup.created.task.task_id).task.state, "completed");
    assert.equal(fixture.database.prepare("SELECT state FROM budget_reservations").get().state, "consumed");
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM usage_cost_records").get().total, 1);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM machine_candidate_provenance").get().total, 1);
    assert.equal(fixture.database.prepare("SELECT text FROM translation_candidates").get().text, "翻译:Public source");
  } finally { await fixture.close(); }
});

test("executor classifies unknown outcomes, pauses task and retains an unknown budget without a candidate", async () => {
  const fixture = await workspace();
  try {
    const setup = configure(fixture, seedWorkflow(fixture), "unknown");
    const executor = new TranslationExecutor(fixture.database, fixture.workspaceId, {
      pricingVersion: "gemini-fixture-price", credentialRef: "local:gemini/m4", workerId: "executor-2",
      now: fixture.clock.now, orchestrator: setup.tasks, budgets: setup.budgets,
      invokeProvider: async () => { throw Object.assign(new Error("private disconnect"), { category: "unknown-outcome", retryable: false }); },
    });
    const result = await executor.executeNext();
    assert.equal(result.status, "failed");
    assert.equal(result.error.category, "unknown-outcome");
    assert.equal(setup.tasks.getTask(setup.created.task.task_id).task.state, "paused");
    assert.equal(fixture.database.prepare("SELECT state FROM budget_reservations").get().state, "unknown");
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM translation_candidates").get().total, 0);
  } finally { await fixture.close(); }
});

test("executor revalidates forged Broker identities before completing or creating a candidate", async () => {
  const fixture = await workspace();
  try {
    const setup = configure(fixture, seedWorkflow(fixture), "forged");
    const executor = new TranslationExecutor(fixture.database, fixture.workspaceId, {
      pricingVersion: "gemini-fixture-price", credentialRef: "local:gemini/m4", workerId: "executor-3",
      now: fixture.clock.now, orchestrator: setup.tasks, budgets: setup.budgets,
      invokeProvider: async (request) => ({ ...responseFor(request), modelId: "forged-model" }),
    });
    const result = await executor.executeNext();
    assert.equal(result.status, "failed");
    assert.equal(result.error.category, "malformed-response");
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM usage_cost_records").get().total, 0);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM translation_candidates").get().total, 0);
  } finally { await fixture.close(); }
});

test("independent Broker preserves retryable failures through secure credential fd into task recovery", async () => {
  const fixture = await workspace();
  try {
    const workflow = seedWorkflow(fixture, { sourceText: "Public source" });
    const setup = configure(fixture, workflow, "broker-rate-limit", {
      providerId: "fake-fault", modelId: "fixture-model-v1", pricingVersion: "fault-fixture-price",
    });
    const credentialPath = join(fixture.root, "provider.key");
    await writeFile(credentialPath, "fixture-only-credential", { mode: 0o600 });
    const executor = new TranslationExecutor(fixture.database, fixture.workspaceId, {
      pricingVersion: "fault-fixture-price", credentialRef: "file:provider/fake-fault", workerId: "executor-broker",
      now: fixture.clock.now, orchestrator: setup.tasks, budgets: setup.budgets,
      invokeProvider: (providerRequest, { credentialRef }) => invokeBrokerWithCredentialFile({
        request: providerRequest, credentialRef, credentialPath, faultMode: "rate-limit",
      }),
    });
    const result = await executor.executeNext();
    assert.equal(result.status, "failed");
    assert.equal(result.error.category, "rate-limit");
    assert.equal(result.error.retryable, true);
    assert.deepEqual(fixture.database.prepare("SELECT state FROM translation_attempts ORDER BY created_at, attempt_id").all().map((row) => row.state).sort(), ["failed", "retry-wait"]);
    assert.equal(fixture.database.prepare("SELECT state FROM budget_reservations").get().state, "released");
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM translation_candidates").get().total, 0);
  } finally { await fixture.close(); }
});

test("Gemini OpenAI and DeepSeek each complete the Broker to budget to immutable candidate chain", async () => {
  for (const [providerId, modelId] of [
    [GEMINI_PROVIDER_ID, "gemini-fixture-flash"],
    [OPENAI_PROVIDER_ID, "gpt-fixture"],
    [DEEPSEEK_PROVIDER_ID, "deepseek-chat"],
  ]) {
    const fixture = await workspace();
    try {
      const workflow = seedWorkflow(fixture, { sourceText: "Public source" });
      const pricingVersion = `${providerId}-chain-price`;
      const setup = configure(fixture, workflow, `${providerId}-chain`, { providerId, modelId, pricingVersion });
      const broker = createProviderBroker({
        adapters: createProviderRegistry({ fetchImpl: adapterSuccess }),
        credentialResolver: createCredentialResolver(async () => "fixture-credential"),
      });
      const executor = new TranslationExecutor(fixture.database, fixture.workspaceId, {
        pricingVersion, credentialRef: `local:provider/${providerId}`, workerId: `${providerId}-worker`,
        now: fixture.clock.now, orchestrator: setup.tasks, budgets: setup.budgets,
        invokeProvider: (providerRequest, options) => broker.invoke({ request: providerRequest, ...options }),
      });
      const result = await executor.executeNext();
      assert.equal(result.status, "completed");
      assert.equal(result.usage.providerId, providerId);
      assert.equal(result.usage.modelId, modelId);
      assert.equal(result.budget.state, "consumed");
      assert.equal(fixture.database.prepare("SELECT text FROM translation_candidates").get().text, "translated:Public source");
      assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM machine_candidate_provenance").get().total, 1);
    } finally { await fixture.close(); }
  }
});
