import assert from "node:assert/strict";
import test from "node:test";
import { providerResponseContract } from "../../src/provider/contracts.mjs";
import { PricingBudgetService } from "../../src/provider/cost-budget.mjs";
import { buildContextManifest } from "../../src/provider/prompt-context.mjs";
import { TranslationExecutor } from "../../src/provider/translation-executor.mjs";
import { enqueueInput, orchestrator, seedWorkflow, workspace } from "../m4-3/helpers.mjs";

function configure(fixture, workflow, suffix = "executor") {
  const context = buildContextManifest(fixture.database, fixture.workspaceId, { workflowId: workflow.workflowId, segmentIds: [workflow.segmentId] });
  const tasks = orchestrator(fixture);
  const created = tasks.enqueue(enqueueInput(workflow, suffix, {
    providerId: "google-gemini", modelId: "gemini-fixture-flash",
    promptVersion: context.manifest.promptVersion, contextDigest: context.contextDigest,
  }));
  const budgets = new PricingBudgetService(fixture.database, fixture.workspaceId, { now: fixture.clock.now });
  budgets.addPricing({
    providerId: "google-gemini", modelId: "gemini-fixture-flash", pricingVersion: "gemini-fixture-price",
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
