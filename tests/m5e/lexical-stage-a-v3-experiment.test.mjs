import assert from "node:assert/strict";
import test from "node:test";
import {
  LEXICAL_STAGE_A_V3_MAX_ATTEMPTS,
  LEXICAL_STAGE_A_V3_MAX_CONCURRENCY,
  LEXICAL_STAGE_A_V3_MAX_COST_MICROS_CNY,
  lexicalStageAV3BudgetExposure,
  lexicalStageAV3Plan,
  lexicalStageAV3WaveAllowed,
} from "../../src/m5e/lexical-stage-a-v3-experiment.mjs";

const documents = ["d1", "d2", "d3", "d4"].map((documentId) => Object.freeze({ documentId }));

test("Stage A v3 experiment freezes four documents by four repeats without Stage B", () => {
  const tasks = lexicalStageAV3Plan(documents);
  assert.equal(tasks.length, 16);
  assert.equal(new Set(tasks.map((item) => item.taskId)).size, 16);
  assert.ok(tasks.every((item) => item.stage === "stage-a" && item.stageAPromptVersion === "balanced-v3"));
  assert.deepEqual(tasks.map((item) => item.taskId), [
    "pro-a-v3-d1-r1", "pro-a-v3-d2-r1", "pro-a-v3-d3-r1", "pro-a-v3-d4-r1",
    "pro-a-v3-d1-r2", "pro-a-v3-d2-r2", "pro-a-v3-d3-r2", "pro-a-v3-d4-r2",
    "pro-a-v3-d1-r3", "pro-a-v3-d2-r3", "pro-a-v3-d3-r3", "pro-a-v3-d4-r3",
    "pro-a-v3-d1-r4", "pro-a-v3-d2-r4", "pro-a-v3-d3-r4", "pro-a-v3-d4-r4",
  ]);
  assert.equal(LEXICAL_STAGE_A_V3_MAX_ATTEMPTS, 32);
  assert.equal(LEXICAL_STAGE_A_V3_MAX_CONCURRENCY, 16);
  assert.equal(LEXICAL_STAGE_A_V3_MAX_COST_MICROS_CNY, 20_000_000);
});

test("Stage A v3 budget reserves every unknown and pending attempt", () => {
  assert.equal(lexicalStageAV3BudgetExposure({ knownCostMicrosCny: 2_000_000, unknownUsageCalls: 2, pendingCalls: 16 }), 11_000_000);
  assert.equal(lexicalStageAV3WaveAllowed({ knownCostMicrosCny: 11_000_000, unknownUsageCalls: 2, pendingCalls: 16 }), true);
  assert.equal(lexicalStageAV3WaveAllowed({ knownCostMicrosCny: 11_000_001, unknownUsageCalls: 2, pendingCalls: 16 }), false);
  assert.throws(() => lexicalStageAV3WaveAllowed({ knownCostMicrosCny: 0, unknownUsageCalls: 0, pendingCalls: 17 }), /pending/u);
});
