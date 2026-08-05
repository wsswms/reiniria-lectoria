import assert from "node:assert/strict";
import test from "node:test";
import {
  LEXICAL_STAGE_A_V2_MAX_ATTEMPTS,
  LEXICAL_STAGE_A_V2_MAX_CONCURRENCY,
  LEXICAL_STAGE_A_V2_MAX_COST_MICROS_CNY,
  lexicalStageAV2BudgetExposure,
  lexicalStageAV2Plan,
  lexicalStageAV2WaveAllowed,
} from "../../src/m5e/lexical-stage-a-v2-experiment.mjs";

const documents = ["d1", "d2", "d3", "d4"].map((documentId) => Object.freeze({ documentId }));

test("Stage A v2 experiment freezes four documents by two repeats without Stage B", () => {
  const tasks = lexicalStageAV2Plan(documents);
  assert.equal(tasks.length, 8);
  assert.equal(new Set(tasks.map((item) => item.taskId)).size, 8);
  assert.ok(tasks.every((item) => item.stage === "stage-a" && item.stageAPromptVersion === "precision-v2"));
  assert.deepEqual(tasks.map((item) => item.taskId), [
    "pro-a-v2-d1-r1", "pro-a-v2-d2-r1", "pro-a-v2-d3-r1", "pro-a-v2-d4-r1",
    "pro-a-v2-d1-r2", "pro-a-v2-d2-r2", "pro-a-v2-d3-r2", "pro-a-v2-d4-r2",
  ]);
  assert.equal(LEXICAL_STAGE_A_V2_MAX_ATTEMPTS, 16);
  assert.equal(LEXICAL_STAGE_A_V2_MAX_CONCURRENCY, 8);
  assert.equal(LEXICAL_STAGE_A_V2_MAX_COST_MICROS_CNY, 20_000_000);
});

test("Stage A v2 budget reserves every unknown and pending attempt", () => {
  assert.equal(lexicalStageAV2BudgetExposure({ knownCostMicrosCny: 2_000_000, unknownUsageCalls: 2, pendingCalls: 8 }), 7_000_000);
  assert.equal(lexicalStageAV2WaveAllowed({ knownCostMicrosCny: 15_000_000, unknownUsageCalls: 2, pendingCalls: 8 }), true);
  assert.equal(lexicalStageAV2WaveAllowed({ knownCostMicrosCny: 15_000_001, unknownUsageCalls: 2, pendingCalls: 8 }), false);
  assert.throws(() => lexicalStageAV2WaveAllowed({ knownCostMicrosCny: 0, unknownUsageCalls: 0, pendingCalls: 9 }), /pending/u);
});
