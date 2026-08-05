import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_FLOW_BUDGET, flowBudgetPolicyContract, M5C_CONTRACT_VERSION } from "../../src/m5c/contracts.mjs";
import { documentSizeTier, productionFlowBudget, PRODUCTION_PROVIDER_OUTPUT_CEILING, PRODUCTION_RESPONSE_BYTES_CEILING,
  roleOutputReservation } from "../../src/m5c/role-policy.mjs";
import { randomUUID } from "node:crypto";

test("document sizing selects bounded production role reservations", () => {
  assert.equal(documentSizeTier(16), "short"); assert.equal(documentSizeTier(17), "medium"); assert.equal(documentSizeTier(49), "long");
  assert.equal(roleOutputReservation({ role: "planner", segmentCount: 54 }).maxOutputTokens, 65_536);
  assert.equal(roleOutputReservation({ role: "qa", segmentCount: 62 }).maxOutputTokens, 65_536);
  assert.equal(roleOutputReservation({ role: "qa", segmentCount: 62, qaMode: "disabled" }).maxOutputTokens, 49_152);
  assert.equal(PRODUCTION_PROVIDER_OUTPUT_CEILING, 65_536); assert.equal(PRODUCTION_RESPONSE_BYTES_CEILING, 4 * 1024 * 1024);
  assert.throws(() => documentSizeTier(129), /out of bounds/);
});

test("dynamic article budget reserves every configured QA cycle and recomputes the total", () => {
  const value = productionFlowBudget(DEFAULT_FLOW_BUDGET, 62);
  assert.equal(value.categories.planner.maxOutputTokens, 65_536);
  assert.equal(value.categories.qa.maxOutputTokens, 65_536 * value.maxQaCycles);
  assert.equal(value.maxOutputTokens, Object.values(value.categories).reduce((sum, category) => sum + category.maxOutputTokens, 0));
  const { roleReservations: _roleReservations, ...limits } = value;
  assert.doesNotThrow(() => flowBudgetPolicyContract({ schemaVersion: M5C_CONTRACT_VERSION, workflowId: randomUUID(), revision: 1, ...limits,
    authorizedBy: { type: "user", id: "fixture" }, createdAt: new Date(0).toISOString() }));
});

test("production and evaluation ceilings stay separate", () => {
  assert.ok(PRODUCTION_PROVIDER_OUTPUT_CEILING < 384_000);
  const production = productionFlowBudget(DEFAULT_FLOW_BUDGET, 54);
  assert.equal("evaluationScope" in production, false); assert.equal("roleReservations" in DEFAULT_FLOW_BUDGET, false);
});
