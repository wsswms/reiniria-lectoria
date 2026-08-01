import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { PricingBudgetService } from "../../src/provider/cost-budget.mjs";
import { enqueueInput, orchestrator, seedWorkflow, workspace } from "../m4-3/helpers.mjs";

function configure(service, { soft = 1_000_000, hard = 2_000_000 } = {}) {
  service.addPricing({
    providerId: "fake-primary", modelId: "fixture-model-v1", pricingVersion: "pricing-v1", currency: "USD",
    inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 4_000_000,
    cachedInputMicrosPerMillion: 500_000, source: "fixed-test-snapshot",
  });
  service.addPolicy({ policyVersion: "budget-v1", currency: "USD", softLimitMicros: soft, hardLimitMicros: hard, unknownPriceAction: "pause" });
}

test("one hundred usage fixtures match the fixed pricing snapshot exactly", async () => {
  const fixture = await workspace();
  try {
    const budgets = new PricingBudgetService(fixture.database, fixture.workspaceId, { now: fixture.clock.now });
    configure(budgets);
    for (let index = 0; index < 100; index += 1) {
      const usage = { inputTokens: index + 10, outputTokens: index + 3, cachedInputTokens: index % 5 };
      const quote = budgets.quote("fake-primary", "fixture-model-v1", "pricing-v1", usage);
      const numerator = (usage.inputTokens - usage.cachedInputTokens) * 2_000_000
        + usage.cachedInputTokens * 500_000 + usage.outputTokens * 4_000_000;
      assert.equal(quote.amountMicros, Math.ceil(numerator / 1_000_000));
      assert.equal(quote.currency, "USD");
    }
    const unknown = budgets.quote("fake-primary", "unknown-model", "pricing-v1", { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 });
    assert.equal(unknown.status, "unknown-price");
    assert.equal(unknown.amountMicros, null);
  } finally { await fixture.close(); }
});

test("soft limit pauses for user confirmation while hard limit and one hundred contenders cannot overspend", async () => {
  const fixture = await workspace();
  try {
    const budgets = new PricingBudgetService(fixture.database, fixture.workspaceId, { now: fixture.clock.now });
    budgets.addPricing({ providerId: "fake-primary", modelId: "fixture-model-v1", pricingVersion: "unit", currency: "USD", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cachedInputMicrosPerMillion: 1_000_000, source: "unit" });
    budgets.addPolicy({ policyVersion: "soft", currency: "USD", softLimitMicros: 1, hardLimitMicros: 10, unknownPriceAction: "pause" });
    const softTask = orchestrator(fixture).enqueue(enqueueInput(seedWorkflow(fixture), "soft")).task;
    budgets.assignTask(softTask.task_id, "soft");
    assert.equal(budgets.reserve(softTask.attempts?.[0]?.attempt_id ?? fixture.database.prepare("SELECT attempt_id FROM translation_attempts WHERE task_id = ?").get(softTask.task_id).attempt_id, "unit", { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }).decision, "paused-soft-limit");
    const authorizationId = budgets.authorizeSoftLimit(softTask.task_id, { type: "user", id: "owner" });
    const softAttempt = fixture.database.prepare("SELECT attempt_id FROM translation_attempts WHERE task_id = ?").get(softTask.task_id).attempt_id;
    assert.equal(budgets.reserve(softAttempt, "unit", { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, { authorizationId }).decision, "reserved");

    budgets.addPolicy({ policyVersion: "hard", currency: "USD", softLimitMicros: 10, hardLimitMicros: 10, unknownPriceAction: "block" });
    const attemptIds = [];
    for (let index = 0; index < 100; index += 1) {
      const task = orchestrator(fixture).enqueue(enqueueInput(seedWorkflow(fixture), `hard-${index}`)).task;
      budgets.assignTask(task.task_id, "hard");
      const attemptId = fixture.database.prepare("SELECT attempt_id FROM translation_attempts WHERE task_id = ?").get(task.task_id).attempt_id;
      attemptIds.push(attemptId);
    }
    const groups = Array.from({ length: 10 }, (_, workerIndex) => attemptIds.filter((_, index) => index % 10 === workerIndex));
    const results = await Promise.all(groups.map((ids) => new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./reserve-worker.mjs", import.meta.url), { workerData: {
        filename: `${fixture.root}/app.sqlite3`, workspaceId: fixture.workspaceId, attemptIds: ids,
      } });
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => { if (code !== 0) reject(new Error(`budget worker exited ${code}`)); });
    })));
    const decisions = results.flatMap((result) => result.decisions);
    assert.deepEqual(results.flatMap((result) => result.errors), []);
    assert.equal(decisions.filter((item) => item === "reserved").length, 8);
    assert.equal(decisions.filter((item) => item === "blocked-hard-limit").length, 92);
    const committed = fixture.database.prepare("SELECT sum(estimated_amount_micros) AS total FROM budget_reservations WHERE state = 'reserved'").get().total;
    assert.equal(committed, 10);
  } finally { await fixture.close(); }
});

test("unknown price and unknown usage remain explicit instead of becoming zero", async () => {
  const fixture = await workspace();
  try {
    const budgets = new PricingBudgetService(fixture.database, fixture.workspaceId, { now: fixture.clock.now });
    budgets.addPolicy({ policyVersion: "unknown", currency: "USD", softLimitMicros: 100, hardLimitMicros: 200, unknownPriceAction: "pause" });
    const task = orchestrator(fixture).enqueue(enqueueInput(seedWorkflow(fixture), "unknown-price")).task;
    budgets.assignTask(task.task_id, "unknown");
    const attemptId = fixture.database.prepare("SELECT attempt_id FROM translation_attempts WHERE task_id = ?").get(task.task_id).attempt_id;
    const decision = budgets.reserve(attemptId, "missing", { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 });
    assert.equal(decision.amountMicros, null);
    assert.equal(budgets.getTaskBudget(task.task_id).state, "unknown-paused");
    assert.throws(() => budgets.acknowledgeUnknown(task.task_id, { type: "runner", id: "runner" }), /only a user/);
    assert.equal(budgets.acknowledgeUnknown(task.task_id, { type: "user", id: "owner" }).state, "active");

    configure(new PricingBudgetService(fixture.database, fixture.workspaceId, { now: fixture.clock.now }), { soft: 1_000, hard: 2_000 });
    const second = orchestrator(fixture).enqueue(enqueueInput(seedWorkflow(fixture), "unknown-usage")).task;
    budgets.assignTask(second.task_id, "budget-v1");
    const secondAttempt = fixture.database.prepare("SELECT attempt_id FROM translation_attempts WHERE task_id = ?").get(second.task_id).attempt_id;
    const reservation = budgets.reserve(secondAttempt, "pricing-v1", { inputTokens: 2, outputTokens: 1, cachedInputTokens: 0 });
    const result = budgets.finalize(reservation.reservationId, null);
    assert.equal(result.state, "unknown");
    assert.equal(result.actualAmountMicros, null);
    assert.equal(fixture.database.prepare("SELECT actual_amount_micros AS amount FROM budget_reservations WHERE reservation_id = ?").get(reservation.reservationId).amount, null);
  } finally { await fixture.close(); }
});

test("actual usage records reconcile against reservations without duplication", async () => {
  const fixture = await workspace();
  try {
    const budgets = new PricingBudgetService(fixture.database, fixture.workspaceId, { now: fixture.clock.now });
    configure(budgets);
    const tasks = orchestrator(fixture);
    const task = tasks.enqueue(enqueueInput(seedWorkflow(fixture), "reconcile")).task;
    budgets.assignTask(task.task_id, "budget-v1");
    const attemptId = fixture.database.prepare("SELECT attempt_id FROM translation_attempts WHERE task_id = ?").get(task.task_id).attempt_id;
    const reservation = budgets.reserve(attemptId, "pricing-v1", { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 });
    const lease = tasks.leaseNext("worker", 1_000);
    const running = tasks.startProvider(lease.attempt_id, lease.version, "worker");
    const usage = budgets.pricedUsage("fake-primary", "fixture-model-v1", "pricing-v1", { providerId: "fake-primary", modelId: "fixture-model-v1", providerResponseId: "response", inputTokens: 8, outputTokens: 4, cachedInputTokens: 2, totalTokens: 12 });
    tasks.complete(attemptId, running.version, "worker", "sha256:0000000000000000000000000000000000000000000000000000000000000000", { usage });
    const record = fixture.database.prepare("SELECT usage_record_id FROM usage_cost_records WHERE attempt_id = ?").get(attemptId);
    const reconciled = budgets.finalize(reservation.reservationId, record.usage_record_id);
    assert.equal(reconciled.state, "consumed");
    assert.equal(reconciled.actualAmountMicros, usage.amountMicros);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM budget_reservations WHERE attempt_id = ?").get(attemptId).total, 1);
  } finally { await fixture.close(); }
});
