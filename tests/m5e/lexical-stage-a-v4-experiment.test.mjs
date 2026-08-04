import assert from "node:assert/strict";
import test from "node:test";
import {
  LEXICAL_STAGE_A_V4_MAX_ATTEMPTS,
  LEXICAL_STAGE_A_V4_MAX_CONCURRENCY,
  LEXICAL_STAGE_A_V4_MAX_COST_MICROS_CNY,
  lexicalStageAV4BudgetExposure,
  lexicalStageAV4Plan,
  lexicalStageAV4WaveAllowed,
} from "../../src/m5e/lexical-stage-a-v4-experiment.mjs";

const documents = ["d1", "d2", "d3", "d4"].map((documentId) => Object.freeze({ documentId }));

test("Stage A v4 freezes four documents by four repeats without Stage B", () => {
  const tasks = lexicalStageAV4Plan(documents);
  assert.equal(tasks.length, 16);
  assert.equal(new Set(tasks.map((item) => item.taskId)).size, 16);
  assert.ok(tasks.every((item) => item.stage === "stage-a" && item.stageAPromptVersion === "risk-balanced-v4"));
  assert.deepEqual(tasks.map((item) => item.taskId), [
    "pro-a-v4-d1-r1", "pro-a-v4-d2-r1", "pro-a-v4-d3-r1", "pro-a-v4-d4-r1",
    "pro-a-v4-d1-r2", "pro-a-v4-d2-r2", "pro-a-v4-d3-r2", "pro-a-v4-d4-r2",
    "pro-a-v4-d1-r3", "pro-a-v4-d2-r3", "pro-a-v4-d3-r3", "pro-a-v4-d4-r3",
    "pro-a-v4-d1-r4", "pro-a-v4-d2-r4", "pro-a-v4-d3-r4", "pro-a-v4-d4-r4",
  ]);
  assert.equal(LEXICAL_STAGE_A_V4_MAX_ATTEMPTS, 32);
  assert.equal(LEXICAL_STAGE_A_V4_MAX_CONCURRENCY, 16);
  assert.equal(LEXICAL_STAGE_A_V4_MAX_COST_MICROS_CNY, 20_000_000);
});

test("Stage A v4 budget reserves every unknown and pending attempt", () => {
  assert.equal(lexicalStageAV4BudgetExposure({ knownCostMicrosCny: 2_000_000, unknownUsageCalls: 2, pendingCalls: 16 }), 11_000_000);
  assert.equal(lexicalStageAV4WaveAllowed({ knownCostMicrosCny: 11_000_000, unknownUsageCalls: 2, pendingCalls: 16 }), true);
  assert.equal(lexicalStageAV4WaveAllowed({ knownCostMicrosCny: 11_000_001, unknownUsageCalls: 2, pendingCalls: 16 }), false);
  assert.throws(() => lexicalStageAV4WaveAllowed({ knownCostMicrosCny: 0, unknownUsageCalls: 0, pendingCalls: 17 }), /pending/u);
});
