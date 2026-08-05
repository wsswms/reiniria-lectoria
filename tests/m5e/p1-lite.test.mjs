import assert from "node:assert/strict";
import test from "node:test";
import { buildP1LiteDeepSeekBody, buildP1LiteModelInput, compareP1LiteModes, normalizeP1LitePayload,
  p1LiteCanonicalKey, summarizeP1LiteResult } from "../../src/m5e/p1-lite.mjs";

const S1 = "00000000-0000-4000-8000-000000000001";
const S2 = "00000000-0000-4000-8000-000000000002";
const request = Object.freeze({ schemaVersion: "m5c-planner-request-v1", targetLanguage: "zh-CN", localItems: Object.freeze([
  Object.freeze({ kind: "term", coverage: "uncovered", instructionType: "warning-only", impact: "high", segmentIds: [S1], dependencies: {}, content: { value: "ネガカラー" } }),
  Object.freeze({ kind: "term", coverage: "uncovered", instructionType: "warning-only", impact: "high", segmentIds: [S2], dependencies: {}, content: { value: "ネガカラー" } }),
  Object.freeze({ kind: "term", coverage: "uncovered", instructionType: "warning-only", impact: "high", segmentIds: [S2], dependencies: {}, content: { value: "カラーネガ" } }),
  Object.freeze({ kind: "measurement", coverage: "covered", instructionType: "hard-constraint", impact: "critical", segmentIds: [S2], dependencies: {}, content: { value: "20mm" } }),
  Object.freeze({ kind: "relation", coverage: "uncovered", instructionType: "warning-only", impact: "high", segmentIds: [S1], dependencies: {}, content: { sourceText: "引用「镜头名」\n第二行" } }),
]) });

const modelItem = (overrides = {}) => ({ kind: "term", impact: "high", candidateIndexes: [0], subject: "ネガカラー",
  issue: "preferred-translation", question: "确认标准中文摄影术语", ...overrides });
const payload = (items = [modelItem()]) => ({ items });

test("P1-Lite locally removes covered measurements and exact-deduplicates candidate occurrences", () => {
  const input = buildP1LiteModelInput(request);
  assert.equal(input.schemaVersion, "m5e-p1-lite-model-input-v2"); assert.equal(input.candidates.length, 3);
  assert.deepEqual(input.candidates[0].memberLocalItemIndexes, [0, 1]); assert.deepEqual(input.candidates[0].segmentIds, [S1, S2]);
  assert.equal(input.candidates.some((candidate) => candidate.subject === "20mm"), false);
  assert.deepEqual(input.sourceContexts, [{ segmentId: S1, sourceText: "引用「镜头名」\n第二行" }]);
});

test("P1-Lite expands model candidate selections into deterministic plan lineage and research fields", () => {
  const result = normalizeP1LitePayload(payload(), request); const output = result.items[0];
  assert.deepEqual(output.dependencies, { localItemIndexes: [0, 1], candidateIndexes: [0] }); assert.deepEqual(output.segmentIds, [S1, S2]);
  assert.equal(output.coverage, "uncovered"); assert.equal(output.instructionType, "warning-only");
  assert.deepEqual(result.researchScope, { suggestedItemIndexes: [0], approvedItemIds: [] });
  assert.equal(p1LiteCanonicalKey(output), '["term","ネガカラー","preferred-translation"]');
  const summary = summarizeP1LiteResult(result, request); assert.equal(summary.inputLocalItems, 5); assert.equal(summary.outputItems, 1);
  assert.equal(summary.referencedLocalItems, 2); assert.equal(summary.compressionRatio, 0.8);
});

test("P1-Lite permits explicit term alias grouping but forbids duplicate output identities", () => {
  const grouped = modelItem({ candidateIndexes: [0, 1] });
  assert.deepEqual(normalizeP1LitePayload(payload([grouped]), request).items[0].dependencies.localItemIndexes, [0, 1, 2]);
  assert.throws(() => normalizeP1LitePayload(payload([modelItem(), modelItem()]), request), /duplicate canonical identity/);
});

test("P1-Lite allows bounded heuristic reclassification and rejects invalid kinds or impact downgrades", () => {
  assert.throws(() => normalizeP1LitePayload(payload([modelItem({ subject: "彩色负片" })]), request), /copy one cited candidate subject/);
  assert.throws(() => normalizeP1LitePayload(payload([modelItem({ candidateIndexes: [9] })]), request), /candidate index/);
  assert.doesNotThrow(() => normalizeP1LitePayload(payload([modelItem({ kind: "entity", issue: "official-name" })]), request));
  assert.throws(() => normalizeP1LitePayload(payload([modelItem({ kind: "measurement" })]), request), /invalid kind reclassification/);
  assert.throws(() => normalizeP1LitePayload(payload([modelItem({ impact: "low" })]), request), /downgrades local impact/);
});

test("P1-Lite exact source handling accepts quotes and newlines", () => {
  const relation = modelItem({ kind: "relation", candidateIndexes: [2], subject: "引用「镜头名」\n第二行",
    issue: "relation-preservation", question: "确认关系" });
  assert.doesNotThrow(() => normalizeP1LitePayload(payload([relation]), request));
});

test("DeepSeek request fixes every variable except thinking and exposes explicit candidates", () => {
  const disabled = buildP1LiteDeepSeekBody({ plannerRequest: request, modelId: "deepseek-v4-flash", thinking: "disabled", maxOutputTokens: 65_536 });
  const enabled = buildP1LiteDeepSeekBody({ plannerRequest: request, modelId: "deepseek-v4-flash", thinking: "enabled", maxOutputTokens: 65_536 });
  assert.deepEqual({ ...disabled, thinking: undefined }, { ...enabled, thinking: undefined });
  assert.deepEqual(disabled.thinking, { type: "disabled" }); assert.deepEqual(enabled.thinking, { type: "enabled" });
  const modelInput = JSON.parse(disabled.messages[1].content); assert.equal(modelInput.schemaVersion, "m5e-p1-lite-model-input-v2");
  assert.deepEqual(modelInput.candidates.map((value) => value.candidateIndex), [0, 1, 2]);
});

test("thinking comparison reports canonical overlap", () => {
  const disabled = normalizeP1LitePayload(payload(), request);
  const enabled = normalizeP1LitePayload(payload([modelItem(), modelItem({ candidateIndexes: [1], subject: "カラーネガ", issue: "technical-meaning" })]), request);
  const comparison = compareP1LiteModes(disabled, enabled); assert.equal(comparison.intersection, 1); assert.equal(comparison.union, 2); assert.equal(comparison.jaccard, 0.5);
  assert.equal(comparison.disabledOnly.length, 0); assert.equal(comparison.enabledOnly.length, 1);
});
