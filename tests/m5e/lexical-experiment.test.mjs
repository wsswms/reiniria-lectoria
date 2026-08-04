import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLexicalExperimentPlan,
  lexicalExperimentBudgetExposure,
  lexicalExperimentWaveAllowed,
  LEXICAL_EXPERIMENT_MAX_CALLS,
} from "../../src/m5e/lexical-experiment.mjs";

const documents = [1, 2, 3, 4].map((ordinal) => Object.freeze({ documentId: `document-${ordinal}`,
  language: ordinal % 2 ? "ja" : "zh-CN", targetLanguage: ordinal % 2 ? "zh-CN" : "ja" }));

test("lexical experiment freezes 32 A, 32 single B, 16 pair B and 20 union8 B tasks", () => {
  const tasks = buildLexicalExperimentPlan(documents);
  assert.equal(tasks.length, 100); assert.equal(LEXICAL_EXPERIMENT_MAX_CALLS, 100);
  assert.equal(new Set(tasks.map((item) => item.taskId)).size, 100);
  assert.deepEqual(Object.fromEntries(["stage-a", "stage-b-single", "stage-b-pair", "stage-b-union8"]
    .map((stage) => [stage, tasks.filter((item) => item.stage === stage).length])), {
    "stage-a": 32, "stage-b-single": 32, "stage-b-pair": 16, "stage-b-union8": 20,
  });
  assert.deepEqual(tasks.map((item) => item.sequence), Array.from({ length: 100 }, (_, index) => index + 1));
  assert.deepEqual(tasks.slice(32, 44).map((item) => item.stage), ["stage-b-single", "stage-b-pair", "stage-b-union8",
    "stage-b-single", "stage-b-pair", "stage-b-union8", "stage-b-single", "stage-b-pair", "stage-b-union8",
    "stage-b-single", "stage-b-pair", "stage-b-union8"]);
  for (const document of documents) {
    const stageA = tasks.filter((item) => item.stage === "stage-a" && item.documentId === document.documentId);
    assert.equal(stageA.length, 8); assert.deepEqual(stageA.map((item) => item.repeat), [1, 2, 3, 4, 5, 6, 7, 8]);
    const single = tasks.filter((item) => item.stage === "stage-b-single" && item.documentId === document.documentId);
    assert.deepEqual(single.map((item) => item.dependencyTaskIds), stageA.map((item) => [item.taskId]));
    const pair = tasks.filter((item) => item.stage === "stage-b-pair" && item.documentId === document.documentId);
    assert.deepEqual(pair.map((item) => item.dependencyTaskIds), [[stageA[0].taskId, stageA[1].taskId], [stageA[2].taskId, stageA[3].taskId],
      [stageA[4].taskId, stageA[5].taskId], [stageA[6].taskId, stageA[7].taskId]]);
    const union8 = tasks.filter((item) => item.stage === "stage-b-union8" && item.documentId === document.documentId);
    assert.equal(union8.length, 5); assert.ok(union8.every((item) => JSON.stringify(item.dependencyTaskIds) === JSON.stringify(stageA.map((value) => value.taskId))));
  }
  assert.deepEqual(buildLexicalExperimentPlan(documents).map((item) => item.taskId), tasks.map((item) => item.taskId));
});

test("lexical experiment budget reserves unknown exposure before a concurrent wave", () => {
  assert.equal(lexicalExperimentBudgetExposure({ knownCostMicrosCny: 10_000_000, unknownUsageCalls: 3 }), 11_500_000);
  assert.equal(lexicalExperimentWaveAllowed({ knownCostMicrosCny: 17_500_000, unknownUsageCalls: 1, pendingCalls: 4 }), true);
  assert.equal(lexicalExperimentWaveAllowed({ knownCostMicrosCny: 18_000_001, unknownUsageCalls: 0, pendingCalls: 4 }), false);
  assert.throws(() => lexicalExperimentWaveAllowed({ knownCostMicrosCny: 0, unknownUsageCalls: 0, pendingCalls: 5 }), /wave/);
});
