import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertDatabaseIntegrity } from "../../src/db/connection.mjs";
import { DEFAULT_FLOW_BUDGET } from "../../src/m5c/contracts.mjs";
import { TranslationFlowBudgetService } from "../../src/m5c/flow-budget-service.mjs";
import { FlowPlanConflictError, FlowPlanService } from "../../src/m5c/flow-plan-service.mjs";
import { setup } from "./helpers.mjs";

const user = { type: "user", id: "fixture-user" };
const system = { type: "system", id: "fixture-system" };
const usage = (overrides = {}) => ({ calls: 1, inputTokens: 10, outputTokens: 5, costMicrosCny: 10, costMicrosUsd: 0, durationMs: 10, ...overrides });

test("every M5C flow starts with a local ContextPlan and a user-authorized article budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-flow-"));
  const fixture = setup(join(root, "app.sqlite3"));
  try {
    const service = new FlowPlanService(fixture.database, fixture.workspaceId);
    const result = service.create({ workflowId: fixture.workflowId, documentId: fixture.documentId, sourceRevisionId: fixture.sourceRevisionId,
      targetLanguage: "zh-CN", plannerEnabled: false }, user);
    assert.equal(result.flow.flowState, "planning"); assert.equal(result.flow.plannerEnabled, 0);
    assert.equal(result.plan.plannerMode, "local"); assert.ok(result.plan.items.some((item) => item.kind === "measurement"));
    assert.ok(result.plan.items.some((item) => item.kind === "relation"));
    assert.equal(new TranslationFlowBudgetService(fixture.database, fixture.workspaceId).get(fixture.workflowId).policy.maxCostMicrosCny, 100_000_000);
    assertDatabaseIntegrity(fixture.database);
  } finally { fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});

test("plan approval is user-only and natural-language guidance cannot mutate state before explicit confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-plan-")); const fixture = setup(join(root, "app.sqlite3"));
  try {
    const service = new FlowPlanService(fixture.database, fixture.workspaceId);
    let flow = service.create({ workflowId: fixture.workflowId, documentId: fixture.documentId, sourceRevisionId: fixture.sourceRevisionId, targetLanguage: "en", plannerEnabled: true }, user);
    flow = service.submitPlan(fixture.workflowId, flow.planHead.version, system);
    assert.throws(() => service.decidePlan(fixture.workflowId, flow.planHead.version, "approved", system), FlowPlanConflictError);
    flow = service.decidePlan(fixture.workflowId, flow.planHead.version, "approved", user); assert.equal(flow.flow.flowState, "research");
    const guidance = service.proposeGuidance(fixture.workflowId, "不限量，继续吧", { scope: "document", instructionType: "warning-only", action: "budget-change",
      affectedSegmentIds: [], budgetDelta: {}, stateDiff: {}, ambiguities: ["unbounded budget", "unspecified action"] }, system);
    assert.equal(guidance.state, "pending-user");
    assert.throws(() => service.decideGuidance(guidance.guidance.guidanceId, guidance.version, "confirmed", user), /ambiguous/);
    assert.equal(service.get(fixture.workflowId).flow.flowState, "research");
  } finally { fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});

test("flow budget atomically enforces category total idempotency unknown and no-reduction rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-budget-")); const fixture = setup(join(root, "app.sqlite3"));
  try {
    new FlowPlanService(fixture.database, fixture.workspaceId).create({ workflowId: fixture.workflowId, documentId: fixture.documentId,
      sourceRevisionId: fixture.sourceRevisionId, targetLanguage: "zh-CN", budget: DEFAULT_FLOW_BUDGET }, user);
    const budgets = new TranslationFlowBudgetService(fixture.database, fixture.workspaceId);
    assert.equal(budgets.reserve(fixture.workflowId, "translation", "translate-1", usage()).decision, "reserved");
    assert.equal(budgets.reserve(fixture.workflowId, "translation", "translate-1", usage()).reused, true);
    assert.throws(() => budgets.reserve(fixture.workflowId, "qa", "translate-1", usage()), /idempotency/);
    const settledUsage = usage({ inputTokens: 8 });
    assert.equal(budgets.settle(fixture.workflowId, "translate-1", settledUsage).decision, "settled");
    assert.equal(budgets.settle(fixture.workflowId, "translate-1", settledUsage).reused, true);
    assert.throws(() => budgets.settle(fixture.workflowId, "translate-1", usage({ inputTokens: 7 })), /terminal budget idempotency conflict/);
    budgets.reserve(fixture.workflowId, "qa", "qa-unknown", usage()); budgets.unknown(fixture.workflowId, "qa-unknown");
    assert.deepEqual(fixture.database.prepare(`SELECT flow_state AS flowState, outcome_state AS outcomeState, pause_reason AS pauseReason
      FROM translation_flow_controls WHERE workspace_id = ? AND workflow_id = ?`).get(fixture.workspaceId, fixture.workflowId),
    { flowState: "paused", outcomeState: "unknown", pauseReason: "qa-unknown-outcome" });
    assert.throws(() => budgets.reserve(fixture.workflowId, "qa", "qa-2", usage()), /unknown outcome stop line/);
    const current = budgets.get(fixture.workflowId);
    assert.throws(() => budgets.expand(fixture.workflowId, current.version, { ...current.policy, maxCalls: current.policy.maxCalls - 1 }, user), /unknown or missing fields|cannot reduce/);
    assertDatabaseIntegrity(fixture.database);
  } finally { fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});
