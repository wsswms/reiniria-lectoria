import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  contextPlanItemContract,
  DEFAULT_FLOW_BUDGET,
  flowBudgetPolicyContract,
  guidanceInterpretationContract,
  M5C_CONTRACT_VERSION,
} from "../../src/m5c/contracts.mjs";

test("M5C budget contract fixes exhaustive article-level and category hard limits", () => {
  const value = flowBudgetPolicyContract({ schemaVersion: M5C_CONTRACT_VERSION, workflowId: randomUUID(), revision: 1,
    ...DEFAULT_FLOW_BUDGET, authorizedBy: { type: "user", id: "fixture-user" }, createdAt: new Date(0).toISOString() });
  assert.equal(value.maxCostMicrosCny, 100_000_000);
  assert.equal(value.maxCostMicrosUsd, 4_000_000);
  assert.equal(value.categories.qa.maxCostMicrosCny, 25_000_000);
  assert.equal(Object.isFrozen(value.categories), true);
  assert.throws(() => flowBudgetPolicyContract({ ...value, unexpected: true }), TypeError);
  assert.throws(() => flowBudgetPolicyContract({ ...value, authorizedBy: { type: "system", id: "forged" } }), TypeError);
});

test("context types fail closed when disputed or stale material would become affirmative fact", () => {
  const base = { itemId: randomUUID(), kind: "fact", coverage: "conflicted", instructionType: "disputed", impact: "high",
    segmentIds: [randomUUID()], dependencies: {}, content: { text: "conflict" } };
  assert.equal(contextPlanItemContract(base).instructionType, "disputed");
  assert.throws(() => contextPlanItemContract({ ...base, instructionType: "preferred" }), /affirmative/);
  assert.throws(() => contextPlanItemContract({ ...base, coverage: "covered" }), /must be conflicted/);
});

test("guidance interpretation is structured but remains non-authorizing data", () => {
  const value = guidanceInterpretationContract({ scope: "segment", instructionType: "preferred", action: "retranslation",
    affectedSegmentIds: [randomUUID()], budgetDelta: {}, stateDiff: { preview: "one segment" }, ambiguities: [] });
  assert.equal(value.action, "retranslation");
  assert.throws(() => guidanceInterpretationContract({ ...value, action: "approve-export" }), TypeError);
});
