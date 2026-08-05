import assert from "node:assert/strict";
import test from "node:test";
import { buildLexicalReferenceBenchmark, scoreLexicalReferenceBenchmark } from "../../src/m5e/lexical-reference-benchmark.mjs";

const documents = [{ documentId: "d1", language: "ja", segments: [
  { segmentId: "s1", sourceText: "軸上色収差とコマフレアを確認する。" },
  { segmentId: "s2", sourceText: "沈胴機構を採用した。" },
  { segmentId: "s3", sourceText: "ニコン D700 とレンズを使う。" },
] }];
const proposal = { status: "pending-user-confirmation", proposedFamilies: [
  { familyId: "f1", kind: "term", impact: "critical", segmentIds: ["s1"], description: "「軸上色収差」の標準訳は何か" },
  { familyId: "f2", kind: "entity", impact: "high", segmentIds: ["s2"], description: "“沈胴機構”の名称" },
  { familyId: "f3", kind: "fact", impact: "high", segmentIds: ["s1"], description: "「コマフレア」の事実" },
  { familyId: "f4", kind: "term", impact: "high", segmentIds: ["s1"], description: "引用なし" },
  { familyId: "f5", kind: "entity", impact: "high", segmentIds: ["s3"], description: "how should brand 「ニコン」 and model “d700” be rendered?" },
  { familyId: "f6", kind: "term", impact: "high", segmentIds: ["s1"], description: "中文解释中的色収差不应被当作日文锚点" },
] };

test("lexical reference benchmark remains provisional and anchors only exact term/entity subjects", () => {
  const benchmark = buildLexicalReferenceBenchmark(proposal, documents);
  assert.equal(benchmark.status, "provisional"); assert.equal(benchmark.lexicalFamilies, 5);
  assert.equal(benchmark.anchoredFamilies.length, 3); assert.equal(benchmark.unanchoredFamilyIds.length, 2);
  assert.deepEqual(benchmark.exactSurfaces, ["D700", "ニコン", "沈胴機構", "軸上色収差"]);
});

test("lexical reference score requires same segment and permits a longer candidate quote", () => {
  const benchmark = buildLexicalReferenceBenchmark(proposal, documents);
  const score = scoreLexicalReferenceBenchmark(benchmark, [{ quotes: [{ text: "軸上色収差とコマフレア",
    occurrences: [{ segmentId: "s1", start: 0, end: 12 }] }] }]);
  assert.equal(score.coveredFamilies, 1); assert.equal(score.criticalCovered, 1); assert.equal(score.highCovered, 0);
  assert.equal(score.capturedExactSurfaces, 1); assert.deepEqual(score.missedExactSurfaces, ["D700", "ニコン", "沈胴機構"]);
  assert.deepEqual(score.missedFamilyIds, ["f2", "f5"]);
  const wrongSegment = scoreLexicalReferenceBenchmark(benchmark, [{ quotes: [{ text: "沈胴機構",
    occurrences: [{ segmentId: "s1", start: 0, end: 4 }] }] }]);
  assert.equal(wrongSegment.coveredFamilies, 0);
});
