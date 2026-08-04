import assert from "node:assert/strict";
import test from "node:test";
import { assembleDetectorV3Coverage } from "../../src/m5e/detector-v3.mjs";
import {
  buildLexicalStageABody,
  buildLexicalStageAModelInput,
  buildLexicalStageBBody,
  buildLexicalStageBModelInput,
  mergeLexicalStageAResults,
  normalizeLexicalStageAPayload,
  normalizeLexicalStageBPayload,
} from "../../src/m5e/lexical-two-stage.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const document = Object.freeze({ schemaVersion: "m5e-detector-document-v1", documentId: "document-lexical",
  language: "ja", targetLanguage: "zh-CN", title: "重複段落", segments: Object.freeze([
    Object.freeze({ segmentId: "segment-a", sourceText: "😀倍率色収差と色収差。", structuralRole: "paragraph" }),
    Object.freeze({ segmentId: "segment-b", sourceText: "完全重複の球面収差。", structuralRole: "paragraph" }),
    Object.freeze({ segmentId: "segment-c", sourceText: "完全重複の球面収差。", structuralRole: "paragraph" }),
  ]) });
const retriever = Object.freeze({ manifest: () => ({ factSetDigest: digest("f"), retrieverVersion: "fts-v1" }), search: () => [] });
const approvedTerms = Object.freeze([
  Object.freeze({ factId: "fact-long", revisionId: "revision-long", contentDigest: digest("a"), retrieverVersion: "fts-v1",
    state: "active", kind: "term", language: "ja", targetLanguages: Object.freeze(["zh-CN"]), term: "倍率色収差",
    preferredTranslations: Object.freeze([Object.freeze({ language: "zh-CN", text: "倍率色差" })]), variants: Object.freeze([]) }),
  Object.freeze({ factId: "fact-short", revisionId: "revision-short", contentDigest: digest("b"), retrieverVersion: "fts-v1",
    state: "active", kind: "term", language: "ja", targetLanguages: Object.freeze(["zh-CN"]), term: "色収差",
    preferredTranslations: Object.freeze([Object.freeze({ language: "zh-CN", text: "色差" })]), variants: Object.freeze([]) }),
  Object.freeze({ factId: "fact-spherical", revisionId: "revision-spherical", contentDigest: digest("c"), retrieverVersion: "fts-v1",
    state: "active", kind: "term", language: "ja", targetLanguages: Object.freeze(["zh-CN"]), term: "球面収差",
    preferredTranslations: Object.freeze([]), variants: Object.freeze([]) }),
]);
const coverage = assembleDetectorV3Coverage({ document, approvedTerms, retriever });

test("lexical Stage A sends only article text and a minimal quote-only JSON contract", () => {
  const input = buildLexicalStageAModelInput(coverage);
  assert.deepEqual(Object.keys(input), ["sourceLanguage", "targetLanguage", "titleContext", "segments"]);
  assert.deepEqual(input.segments[0], { ref: "s001", text: document.segments[0].sourceText });
  const serialized = JSON.stringify(input);
  assert.equal(serialized.includes(document.documentId), false);
  assert.equal(serialized.includes("fact-long"), false);
  const body = buildLexicalStageABody({ coverage, modelId: "deepseek-v4-flash", maxOutputTokens: 8_192 });
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.temperature, 1);
  const pro = buildLexicalStageABody({ coverage, modelId: "deepseek-v4-pro", maxOutputTokens: 8_192, omitTemperature: true });
  assert.equal(Object.hasOwn(pro, "temperature"), false);
  assert.equal(body.response_format.type, "json_object");
  assert.match(body.messages[0].content, /titleContext is context only/u);
  assert.match(body.messages[0].content, /stable general bilingual and domain knowledge/u);
  assert.match(body.messages[0].content, /An empty items array is valid/u);
  assert.match(body.messages[0].content, /Precision is more important than producing a long glossary/u);
  assert.match(body.messages[0].content, /\{"items":\[\{"quotes":\["軸上色収差"\]\}\]\}/u);
  const legacy = buildLexicalStageABody({ coverage, modelId: "deepseek-v4-pro", maxOutputTokens: 8_192,
    omitTemperature: true, stageAPromptVersion: "recall-v1" });
  assert.match(legacy.messages[0].content, /Include technical terms, fixed domain expressions/u);
  assert.doesNotMatch(legacy.messages[0].content, /An empty items array is valid/u);
  assert.throws(() => buildLexicalStageABody({ coverage, modelId: "deepseek-v4-pro", maxOutputTokens: 8_192,
    stageAPromptVersion: "unknown" }), /prompt version/u);
});

test("lexical Stage A resolves every UTF-16 occurrence and retains identical segments", () => {
  const result = normalizeLexicalStageAPayload({ items: [
    { quotes: ["球面収差"] },
    { quotes: ["倍率色収差"] },
  ] }, coverage, approvedTerms);
  const spherical = result.candidates.find((item) => item.quotes[0].text === "球面収差");
  assert.deepEqual(spherical.quotes[0].occurrences, [
    { segmentId: "segment-b", start: 5, end: 9 },
    { segmentId: "segment-c", start: 5, end: 9 },
  ]);
  const chromatic = result.candidates.find((item) => item.quotes[0].text === "倍率色収差");
  assert.deepEqual(chromatic.quotes[0].occurrences, [{ segmentId: "segment-a", start: 2, end: 7 }]);
  assert.equal(chromatic.coverage.status, "covered");
  assert.equal(chromatic.coverage.preferredTranslation, "倍率色差");
  assert.equal(spherical.coverage.status, "uncovered");
  assert.equal(Object.isFrozen(result.candidates), true);
});

test("lexical coverage scans approved terms independently and preserves overlaps", () => {
  const result = normalizeLexicalStageAPayload({ items: [{ quotes: ["色収差"] }] }, coverage, approvedTerms);
  assert.deepEqual(result.candidates[0].quotes[0].occurrences, [
    { segmentId: "segment-a", start: 4, end: 7 },
    { segmentId: "segment-a", start: 8, end: 11 },
  ]);
  assert.equal(result.candidates[0].coverage.status, "covered");
  assert.equal(result.candidates[0].coverage.lineage.factId, "fact-short");
});

test("lexical coverage requires every occurrence to share one target-bearing lineage", () => {
  const conflicting = Object.freeze({ ...approvedTerms[1], factId: "fact-conflict", revisionId: "revision-conflict",
    contentDigest: digest("d"), term: "色収差", preferredTranslations: Object.freeze([
      Object.freeze({ language: "zh-CN", text: "色像差" }),
    ]) });
  const result = normalizeLexicalStageAPayload({ items: [{ quotes: ["色収差"] }] }, coverage, [...approvedTerms, conflicting]);
  assert.deepEqual(result.candidates[0].coverage, { status: "uncovered", preferredTranslation: null, lineage: null });
});

test("lexical Stage A is strict, source anchored, stable across item order and de-duplicates exact quote groups", () => {
  const first = normalizeLexicalStageAPayload({ items: [{ quotes: ["球面収差"] }, { quotes: ["倍率色収差"] }] }, coverage, approvedTerms);
  const second = normalizeLexicalStageAPayload({ items: [{ quotes: ["倍率色収差"] }, { quotes: ["球面収差"] },
    { quotes: ["球面収差"] }] }, coverage, approvedTerms);
  assert.deepEqual(first.candidates.map((item) => item.candidateId), second.candidates.map((item) => item.candidateId));
  assert.throws(() => normalizeLexicalStageAPayload({ items: [{ quotes: [] }] }, coverage, approvedTerms), /quotes/u);
  assert.throws(() => normalizeLexicalStageAPayload({ items: [{ quotes: ["不存在"] }] }, coverage, approvedTerms), /exact quote/u);
  assert.throws(() => normalizeLexicalStageAPayload({ items: [{ quotes: ["球面収差"], extra: true }] }, coverage, approvedTerms), /invalid keys/u);
});

test("lexical Stage B exposes short refs and bounded contexts only for uncovered candidates", () => {
  const stageAResult = normalizeLexicalStageAPayload({ items: [{ quotes: ["倍率色収差"] }, { quotes: ["球面収差"] },
    { quotes: ["完全重複"] }] }, coverage, approvedTerms);
  const input = buildLexicalStageBModelInput(stageAResult);
  assert.equal(input.candidates.length, 2);
  assert.deepEqual(input.candidates.map((item) => item.ref), ["c001", "c002"]);
  assert.ok(input.candidates.every((item) => item.contexts.length <= 4));
  assert.ok(input.candidates.flatMap((item) => item.contexts).every((item) => item.length <= 320));
  assert.equal(JSON.stringify(input).includes("segment-b"), false);
  const body = buildLexicalStageBBody({ stageAResult, modelId: "deepseek-v4-flash", maxOutputTokens: 8_192 });
  assert.equal(body.temperature, 1); assert.equal(body.thinking.type, "enabled");
  assert.match(body.messages[0].content, /researchGoal/u);
});

test("lexical Stage A merge forms a stable union without changing candidate identity", () => {
  const first = normalizeLexicalStageAPayload({ items: [{ quotes: ["球面収差"] }] }, coverage, approvedTerms);
  const second = normalizeLexicalStageAPayload({ items: [{ quotes: ["完全重複"] }, { quotes: ["球面収差"] }] }, coverage, approvedTerms);
  const union = mergeLexicalStageAResults([first, second]);
  assert.equal(union.candidates.length, 2);
  assert.deepEqual(union.candidates.map((item) => item.candidateId), mergeLexicalStageAResults([second, first]).candidates.map((item) => item.candidateId));
  assert.throws(() => mergeLexicalStageAResults([{ ...first, documentId: "other" }]), /result is invalid/u);
});

test("lexical Stage B requires an exact partition and validates 0..N batch-level needs", () => {
  const stageAResult = normalizeLexicalStageAPayload({ items: [{ quotes: ["球面収差"] }, { quotes: ["完全重複"] }] },
    coverage, approvedTerms);
  const normalized = normalizeLexicalStageBPayload({ groups: [
    { memberIds: ["c001"], decision: "research", priority: "high", needs: [
      { researchGoal: "确认球面像差术语的规范中文译法" },
      { researchGoal: "确认该术语在光学资料中的使用范围" },
    ] },
    { memberIds: ["c002"], decision: "translate-directly", priority: "normal", needs: [] },
  ] }, stageAResult);
  assert.equal(normalized.groups[0].memberCandidateIds.length, 1);
  assert.equal(normalized.groups[0].needs.length, 2);
  assert.match(normalized.groups[0].needs[0].researchBatchId, /^sha256:[0-9a-f]{64}$/u);
  assert.throws(() => normalizeLexicalStageBPayload({ groups: [
    { memberIds: ["c001"], decision: "translate-directly", priority: "normal", needs: [] },
  ] }, stageAResult), /partition/u);
  assert.throws(() => normalizeLexicalStageBPayload({ groups: [
    { memberIds: ["c001", "c002"], decision: "research", priority: "high", needs: [] },
  ] }, stageAResult), /needs/u);
  assert.throws(() => normalizeLexicalStageBPayload({ groups: [
    { memberIds: ["c001"], decision: "research", priority: "high", needs: [{ researchGoal: "确认译法" }] },
    { memberIds: ["c001", "c002"], decision: "research", priority: "normal", needs: [{ researchGoal: "确认范围" }] },
  ] }, stageAResult), /partition/u);
});
