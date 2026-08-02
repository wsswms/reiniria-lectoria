import assert from "node:assert/strict";
import test from "node:test";
import { detectM5CQAIssues } from "../../src/m5c/qa-service.mjs";
import { m5cQaEvaluationCorpus as cases } from "../fixtures/m5c-5/qa-evaluation-corpus.mjs";

test("fixed QA corpus spans three directions domains and short-medium-long articles", () => {
  assert.equal(cases.length, 12);
  assert.deepEqual([...new Set(cases.map((item) => item.direction))].sort(), ["en->zh-CN", "ja->zh-CN", "zh-CN->en"]);
  assert.deepEqual([...new Set(cases.map((item) => item.domain))].sort(), ["camera", "science", "software"]);
  assert.deepEqual([...new Set(cases.map((item) => item.length))].sort(), ["long", "medium", "short"]);
});

test("fixed invariant and heuristic QA reaches perfect labeled precision and recall with zero critical escape", () => {
  let truePositive = 0; let predictions = 0; let labels = 0; let falsePositiveCases = 0; let criticalEscapes = 0;
  for (const item of cases) {
    const predicted = new Set(detectM5CQAIssues([{ segmentId: item.id, sourceText: item.source, text: item.target }]).map((finding) => finding.code));
    const expected = new Set(item.labels); predictions += predicted.size; labels += expected.size;
    for (const code of predicted) if (expected.has(code)) truePositive += 1;
    if ([...predicted].some((code) => !expected.has(code))) falsePositiveCases += 1;
    if ([...expected].some((code) => !predicted.has(code))) criticalEscapes += 1;
  }
  const precision = truePositive / predictions; const recall = truePositive / labels;
  assert.equal(precision, 1); assert.equal(recall, 1); assert.equal(falsePositiveCases, 0); assert.equal(criticalEscapes, 0);
});
