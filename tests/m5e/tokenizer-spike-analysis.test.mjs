import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTokenizerSpike, referenceCoverage, summarizeTokenizerResult } from "../../src/m5e/tokenizer-spike-analysis.mjs";

const segment = { segmentId: "s1", ja: "メニスカスレンズと球面収差", zh: "弯月形透镜与球面像差" };
const document = { articleId: "article", segments: [segment] };
const result = { documentId: "article", language: "ja", engine: "fixture", determinismDigests: ["same", "same"], tokenDigest: "digest",
  timing: { p50Ms: 1, p95Ms: 2 }, tokens: [
    { segmentId: "s1", value: "メニスカス", start: 0, end: 5 }, { segmentId: "s1", value: "レンズ", start: 5, end: 8 },
    { segmentId: "s1", value: "と", start: 8, end: 9 }, { segmentId: "s1", value: "球面", start: 9, end: 11 },
    { segmentId: "s1", value: "収差", start: 11, end: 13 },
  ] };

test("reference coverage distinguishes one token from lossless four-token composition", () => {
  const coverage = referenceCoverage(document, result, ["メニスカスレンズ", "球面収差"]);
  assert.deepEqual(coverage, [
    { phrase: "メニスカスレンズ", present: true, singleToken: false, composable: true },
    { phrase: "球面収差", present: true, singleToken: false, composable: true },
  ]);
});

test("tokenizer summary validates offsets and reports candidate and reference metrics", () => {
  const summary = summarizeTokenizerResult(document, result, ["メニスカスレンズ", "球面収差"]);
  assert.equal(summary.tokenOccurrences, 5); assert.equal(summary.referenceComposable, 2); assert.equal(summary.referenceSingleToken, 0);
  assert.throws(() => summarizeTokenizerResult(document, { ...result, determinismDigests: ["a", "b"] }, []), /non-deterministic/);
});

test("aggregate analysis keeps language engines and runtimes separate", () => {
  const corpus = { schemaVersion: "m5e-tokenizer-corpus-v1", documents: [document] };
  const references = { schemaVersion: "m5e-tokenizer-reference-v1", ja: ["球面収差"], zh: [] };
  const output = analyzeTokenizerSpike(corpus, references, [{ schemaVersion: "m5e-tokenizer-results-v1", runtime: { node: "fixture" }, results: [result] }]);
  assert.equal(output.engines[0].composableRecall, 1); assert.deepEqual(output.runtimes, [{ node: "fixture" }]);
});
