import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleDetectorV3Coverage,
  buildDetectorV3DeepSeekBody,
  buildDetectorV3ModelInput,
  buildDetectorV3Plan,
  normalizeDetectorV3Payload,
  detectorV3ApprovedTermFromFact,
} from "../../src/m5e/detector-v3.mjs";
import {
  buildDetectorV3LiteDeepSeekBody,
  buildDetectorV3LiteModelInput,
  normalizeDetectorV3LitePayload,
} from "../../src/m5e/detector-v3-lite.mjs";
import { buildPlannerExperimentMatrix, plannerExperimentPromptMetrics } from "../../src/m5e/planner-prompt-experiment.mjs";
import { invokeM5EDetectorV3DeepSeek } from "../../scripts/m5e-detector-v3-deepseek.mjs";
import { KnowledgeFactService } from "../../src/knowledge/fact-service.mjs";
import { FtsRetriever } from "../../src/knowledge/fts-retriever.mjs";
import { termInput, workspace } from "../m5-1/helpers.mjs";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const FACT_SET = `sha256:${"c".repeat(64)}`;
const IDS = Object.freeze({
  document: "10000000-0000-4000-8000-000000000001",
  first: "10000000-0000-4000-8000-000000000002",
  second: "10000000-0000-4000-8000-000000000003",
  termFact: "10000000-0000-4000-8000-000000000004",
  termRevision: "10000000-0000-4000-8000-000000000005",
  knowledgeFact: "10000000-0000-4000-8000-000000000006",
  knowledgeRevision: "10000000-0000-4000-8000-000000000007",
});

const document = Object.freeze({ schemaVersion: "m5e-detector-document-v1", documentId: IDS.document,
  language: "ja", targetLanguage: "zh-CN", title: "光学設計", segments: Object.freeze([
    Object.freeze({ segmentId: IDS.first, sourceText: "倍率色収差と色収差を補正する。", structuralRole: "paragraph" }),
    Object.freeze({ segmentId: IDS.second, sourceText: "第2レンズが球面収差を補正する。", structuralRole: "paragraph" }),
  ]) });

const approvedTerms = Object.freeze([
  Object.freeze({ factId: IDS.termFact, revisionId: IDS.termRevision, contentDigest: DIGEST_A, retrieverVersion: "fts-v1",
    state: "active", kind: "term", language: "ja", targetLanguages: Object.freeze(["zh-CN"]), term: "倍率色収差",
    preferredTranslations: Object.freeze([Object.freeze({ language: "zh-CN", text: "倍率色差" })]), variants: Object.freeze(["倍率の色収差"]) }),
  Object.freeze({ factId: "10000000-0000-4000-8000-000000000008", revisionId: "10000000-0000-4000-8000-000000000009",
    contentDigest: DIGEST_B, retrieverVersion: "fts-v1", state: "active", kind: "term", language: "ja",
    targetLanguages: Object.freeze(["zh-CN"]), term: "色収差",
    preferredTranslations: Object.freeze([Object.freeze({ language: "zh-CN", text: "色差" })]), variants: Object.freeze([]) }),
]);

const retriever = Object.freeze({
  manifest: () => Object.freeze({ factSetDigest: FACT_SET, retrieverVersion: "fts-v1" }),
  search: ({ query }) => query.includes("球面収差") ? Object.freeze([Object.freeze({ factId: IDS.knowledgeFact,
    revisionId: IDS.knowledgeRevision, kind: "knowledge", language: "ja", matchedField: "body",
    snippet: "第2レンズの像側面は球面収差の補正に寄与する。", contentDigest: DIGEST_B,
    retrieverVersion: "fts-v1", score: -3, rank: 1 })]) : Object.freeze([]),
});

test("Detector v3 longest-matches approved knowledge and assembles revision-bound FTS coverage", () => {
  const coverage = assembleDetectorV3Coverage({ document, approvedTerms, retriever });
  assert.equal(coverage.exactBindings.length, 2);
  assert.equal(coverage.exactBindings[0].surface, "倍率色収差");
  assert.equal(coverage.exactBindings[0].start, 0);
  assert.equal(coverage.exactBindings[1].surface, "色収差");
  assert.equal(coverage.exactBindings[1].start, 6);
  assert.equal(coverage.knowledgeHits.length, 1);
  assert.deepEqual(coverage.knowledgeHits[0].segmentIds, [IDS.second]);
  assert.equal(coverage.knowledgeSnapshot.factSetDigest, FACT_SET);
});

test("Detector v3 consumes an active persisted term revision and the rebuilt workspace FTS snapshot", async () => {
  const fixture = await workspace();
  try {
    const facts = new KnowledgeFactService(fixture.root, fixture.database, fixture.workspaceId, { now: () => new Date(0) });
    const source = termInput({ language: "ja", scope: { targetLanguages: ["zh-CN"], tags: ["optics"] },
      content: { term: "倍率色収差", preferredTranslations: [{ language: "zh-CN", text: "倍率色差" }],
        forbiddenTranslations: [], variants: ["倍率の色収差"], note: "合成批准知识" } });
    await facts.create(source, { type: "fixture", id: "detector-v3" });
    const retriever = new FtsRetriever(fixture.root, fixture.database, fixture.workspaceId, { now: () => new Date(0) });
    const manifest = await retriever.rebuild();
    const approved = detectorV3ApprovedTermFromFact(facts.get(source.factId), manifest.retrieverVersion);
    const coverage = assembleDetectorV3Coverage({ document, approvedTerms: [approved], retriever });
    assert.equal(coverage.exactBindings[0].factId, source.factId);
    assert.equal(coverage.exactBindings[0].revisionId, source.revisionId);
    assert.equal(coverage.exactBindings[0].contentDigest, facts.get(source.factId).revision.contentDigest);
    assert.equal(coverage.knowledgeSnapshot.factSetDigest, manifest.factSetDigest);
  } finally { await fixture.close(); }
});

test("Detector v3 rejects conflicting active aliases instead of guessing a knowledge binding", () => {
  const conflict = Object.freeze({ ...approvedTerms[1], term: "倍率色収差" });
  assert.throws(() => assembleDetectorV3Coverage({ document, approvedTerms: [...approvedTerms, conflict], retriever }), /conflicting approved surface/);
});

test("thinking Planner input contains source text and bounded coverage without local n-gram candidates", () => {
  const coverage = assembleDetectorV3Coverage({ document, approvedTerms, retriever });
  const input = buildDetectorV3ModelInput(coverage);
  assert.equal(input.segments.length, 2);
  assert.equal(input.segments[0].sourceText, document.segments[0].sourceText);
  assert.equal(input.exactBindings.length, 2);
  assert.equal(Object.hasOwn(input, "candidates"), false);
  const body = buildDetectorV3DeepSeekBody({ coverage, modelId: "deepseek-v4-flash", maxOutputTokens: 65_536 });
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.response_format.type, "json_object");
  assert.equal(buildDetectorV3DeepSeekBody({ coverage, modelId: "deepseek-v4-flash", maxOutputTokens: 65_536, temperature: 1 }).temperature, 1);
});

test("Planner Lite sends short references and approved answers while retaining lineage only in the control plane", () => {
  const coverage = assembleDetectorV3Coverage({ document, approvedTerms, retriever });
  const input = buildDetectorV3LiteModelInput(coverage);
  assert.deepEqual(input.segments.map((item) => item.ref), ["s001", "s002"]);
  assert.equal(input.knownAnswers[0].preferredTranslation, "倍率色差");
  assert.equal(input.knownAnswers[0].segmentRef, "s001");
  assert.equal(input.knowledgeHints[0].ref, "h001");
  const serialized = JSON.stringify(input);
  for (const hidden of [IDS.document, IDS.termFact, IDS.termRevision, coverage.exactBindings[0].bindingId,
    coverage.knowledgeHits[0].hitId, "contentDigest", "retrieverVersion", "start", "end"]) assert.equal(serialized.includes(hidden), false);
  const body = buildDetectorV3LiteDeepSeekBody({ coverage, modelId: "deepseek-v4-flash", maxOutputTokens: 65_536, temperature: 1 });
  assert.equal(body.temperature, 1); assert.equal(body.thinking.type, "enabled");
  assert.match(body.messages[0].content, /Complete valid example/);
  assert.match(body.messages[0].content, /knownAnswers/);
});

test("Planner Lite binds short references strictly and derives issue and batch identity locally", () => {
  const coverage = assembleDetectorV3Coverage({ document, approvedTerms, retriever });
  const normalized = normalizeDetectorV3LitePayload({ items: [{ kind: "fact", impact: "high",
    spans: [{ segmentRef: "s002", quote: "球面収差を補正する" }], question: "确认补偿关系是否准确",
    knowledgeHintRefs: ["h001"], batch: "镜头像差关系" }] }, coverage);
  assert.equal(normalized.items[0].issue, "fact-verification");
  assert.equal(normalized.items[0].sourceSpans[0].segmentId, IDS.second);
  assert.equal(normalized.items[0].suggestedKnowledgeHitIds[0], coverage.knowledgeHits[0].hitId);
  assert.match(normalized.items[0].researchBatchHint, /^lite-[0-9a-f]{16}$/u);
  const item = { kind: "term", impact: "high", spans: [{ segmentRef: "s999", quote: "球面収差" }],
    question: "确认译法", knowledgeHintRefs: [], batch: null };
  assert.throws(() => normalizeDetectorV3LitePayload({ items: [item] }, coverage), /segment reference/);
  assert.throws(() => normalizeDetectorV3LitePayload({ items: [{ ...item, spans: [{ segmentRef: "s002", quote: "不存在" }] }] }, coverage), /source quote/);
  assert.throws(() => normalizeDetectorV3LitePayload({ items: [{ ...item, spans: [{ segmentRef: "s002", quote: "球面収差" }],
    knowledgeHintRefs: ["h999"] }] }, coverage), /hint reference/);
});

test("Planner prompt experiment fixes a balanced 48-call initial matrix and 12-call confirmation matrix", () => {
  const coverages = [1, 2, 3, 4].map((ordinal) => ({ document: { documentId: `document-${ordinal}`, language: ordinal % 2 ? "ja" : "zh-CN",
    targetLanguage: ordinal % 2 ? "zh-CN" : "ja" } }));
  const initial = buildPlannerExperimentMatrix(coverages);
  assert.equal(initial.length, 48); assert.equal(new Set(initial.map((item) => item.taskId)).size, 48);
  for (const variant of ["current-v1", "lite-v1"]) for (const temperature of [0, 1]) for (const coverage of coverages) {
    assert.equal(initial.filter((item) => item.promptVariant === variant && item.temperature === temperature
      && item.documentId === coverage.document.documentId).length, 3);
  }
  const confirmation = buildPlannerExperimentMatrix(coverages, { phase: "confirmation", promptVariant: "lite-v1", temperature: 1 });
  assert.equal(confirmation.length, 12); assert.ok(confirmation.every((item) => item.promptVariant === "lite-v1" && item.temperature === 1));
});

test("Planner prompt metrics show Lite removes model-facing control-plane overhead", () => {
  const coverage = assembleDetectorV3Coverage({ document, approvedTerms, retriever });
  const metrics = plannerExperimentPromptMetrics([coverage, coverage, coverage, coverage]);
  const current = metrics.find((item) => item.promptVariant === "current-v1" && item.temperature === 0);
  const lite = metrics.find((item) => item.promptVariant === "lite-v1" && item.temperature === 0);
  assert.ok(lite.systemCharacters < current.systemCharacters);
  assert.ok(lite.userCharacters < current.userCharacters);
  assert.notEqual(lite.bodyDigest, current.bodyDigest);
});

test("Planner output is source-anchored and keeps KnowledgeIdentity separate from ResearchBatch", () => {
  const coverage = assembleDetectorV3Coverage({ document, approvedTerms, retriever });
  const hitId = coverage.knowledgeHits[0].hitId;
  const normalized = normalizeDetectorV3Payload({ items: [
    { kind: "term", impact: "high", issue: "preferred-translation",
      sourceSpans: [{ segmentId: IDS.first, text: "倍率色収差" }], question: "确认标准译法", suggestedKnowledgeHitIds: [], researchBatchHint: null },
    { kind: "fact", impact: "high", issue: "fact-verification",
      sourceSpans: [{ segmentId: IDS.second, text: "第2レンズが球面収差を補正する" }], question: "确认补偿事实",
      suggestedKnowledgeHitIds: [hitId], researchBatchHint: "aberration-correction" },
    { kind: "relation", impact: "high", issue: "relation-preservation",
      sourceSpans: [{ segmentId: IDS.second, text: "球面収差を補正する" }], question: "确认镜片和像差的关系",
      suggestedKnowledgeHitIds: [hitId], researchBatchHint: "aberration-correction" },
  ] }, coverage);
  const plan = buildDetectorV3Plan(normalized, coverage);
  assert.equal(plan.knowledgeIdentities.length, 3);
  assert.equal(plan.knowledgeIdentities[0].resolution, "exact-binding");
  assert.equal(plan.knowledgeIdentities[1].resolution, "possible-binding");
  assert.equal(plan.researchBatches.length, 1);
  assert.equal(plan.researchBatches[0].memberKnowledgeIdentityIds.length, 2);
});

test("model-proposed term variants remain one auditable identity but cannot forge an exact fact binding", () => {
  const coverage = assembleDetectorV3Coverage({ document, approvedTerms, retriever });
  const normalized = normalizeDetectorV3Payload({ items: [{ kind: "term", impact: "high", issue: "consistency",
    sourceSpans: [{ segmentId: IDS.first, text: "倍率色収差" }, { segmentId: IDS.second, text: "球面収差" }],
    question: "确认两种词面是否应保持区分", suggestedKnowledgeHitIds: [], researchBatchHint: "chromatic-aberration" }] }, coverage);
  const plan = buildDetectorV3Plan(normalized, coverage);
  assert.equal(plan.knowledgeIdentities.length, 1);
  assert.equal(plan.knowledgeIdentities[0].resolution, "uncovered");
  assert.equal(plan.knowledgeIdentities[0].exactBinding, null);
});

test("a measurement uncertainty may compare distinct source values without merging its knowledge identity", () => {
  const coverage = assembleDetectorV3Coverage({ document, approvedTerms, retriever });
  const normalized = normalizeDetectorV3Payload({ items: [{ kind: "measurement", impact: "high", issue: "measurement-ambiguity",
    sourceSpans: [{ segmentId: IDS.first, text: "倍率色収差" }, { segmentId: IDS.second, text: "第2レンズ" }],
    question: "确认两个跨段数值是否使用同一倍率口径", suggestedKnowledgeHitIds: [], researchBatchHint: "measurement-comparison" }] }, coverage);
  const plan = buildDetectorV3Plan(normalized, coverage);
  assert.equal(plan.knowledgeIdentities.length, 1);
  assert.equal(plan.knowledgeIdentities[0].sourceSpans.length, 2);
  assert.equal(plan.knowledgeIdentities[0].resolution, "uncovered");
  assert.equal(plan.researchBatches.length, 1);
});

test("a repeated source quote anchors every occurrence and remains uncovered when only one occurrence has an exact binding", () => {
  const coverage = assembleDetectorV3Coverage({ document, approvedTerms, retriever });
  const normalized = normalizeDetectorV3Payload({ items: [{ kind: "term", impact: "medium", issue: "consistency",
    sourceSpans: [{ segmentId: IDS.first, text: "色収差" }], question: "确认重复词面的范围",
    suggestedKnowledgeHitIds: [], researchBatchHint: null }] }, coverage);
  assert.equal(normalized.items[0].sourceSpans[0].occurrences.length, 2);
  assert.equal(buildDetectorV3Plan(normalized, coverage).knowledgeIdentities[0].resolution, "uncovered");
});

test("Planner output fails closed on forged spans, hit ids and duplicate identities", () => {
  const coverage = assembleDetectorV3Coverage({ document, approvedTerms, retriever });
  const item = { kind: "term", impact: "high", issue: "technical-meaning",
    sourceSpans: [{ segmentId: IDS.first, text: "倍率色収差" }], question: "确认含义", suggestedKnowledgeHitIds: [], researchBatchHint: null };
  assert.throws(() => normalizeDetectorV3Payload({ items: [{ ...item, sourceSpans: [{ segmentId: IDS.first, text: "不存在" }] }] }, coverage), /source span/);
  assert.throws(() => normalizeDetectorV3Payload({ items: [{ ...item, suggestedKnowledgeHitIds: ["sha256:forged"] }] }, coverage), /knowledge hit/);
  assert.throws(() => normalizeDetectorV3Payload({ items: [item, item] }, coverage), /duplicate knowledge identity/);
  assert.throws(() => normalizeDetectorV3Payload({ items: [{ ...item, kind: "style", issue: "style" }] }, coverage), /issue is invalid/);
});

test("Detector v3 DeepSeek adapter keeps thinking enabled and retries one known billed malformed stop response", async () => {
  const coverage = assembleDetectorV3Coverage({ document, approvedTerms, retriever });
  const payload = { items: [{ kind: "relation", impact: "high", issue: "relation-preservation",
    sourceSpans: [{ segmentId: IDS.second, text: "球面収差を補正する" }], question: "确认关系",
    suggestedKnowledgeHitIds: [coverage.knowledgeHits[0].hitId], researchBatchHint: "aberration-correction" }] };
  const bodies = ["{", JSON.stringify(payload)]; const requests = []; let calls = 0;
  const fetchImpl = async (_url, request) => {
    calls += 1; requests.push(JSON.parse(request.body)); assert.equal(requests.at(-1).thinking.type, "enabled"); const content = bodies.shift();
    const raw = JSON.stringify({ id: `response-${calls}`, choices: [{ index: 0, finish_reason: "stop",
      message: { content, reasoning_content: "private reasoning" } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, completion_tokens_details: { reasoning_tokens: 8 } } });
    return { ok: true, status: 200, headers: { get: () => null, entries: () => [] }, arrayBuffer: async () => Buffer.from(raw) };
  };
  const result = await invokeM5EDetectorV3DeepSeek({ coverage, modelId: "deepseek-v4-flash", maxOutputTokens: 65_536, maximumAttempts: 2 },
    { credential: "fixture-key", fetchImpl });
  assert.equal(calls, 2); assert.equal(result.items.length, 1); assert.equal(result.usage.calls, 2);
  assert.equal(result.usage.totalTokens, 60); assert.equal(result.usage.reasoningTokens, 16);
  assert.equal(requests[0].messages.length, 2);
  assert.equal(requests[1].messages.length, 3);
  assert.match(requests[1].messages[2].content, /payload-json/);
  assert.match(requests[1].messages[2].content, /byte-for-byte substring/);
  assert.match(requests[1].messages[2].content, /issue is never style/);
});

test("Detector v3 DeepSeek adapter applies Lite payload validation and temperature without retry", async () => {
  const coverage = assembleDetectorV3Coverage({ document, approvedTerms, retriever }); const requests = [];
  const content = JSON.stringify({ items: [{ kind: "term", impact: "high", spans: [{ segmentRef: "s002", quote: "球面収差" }],
    question: "确认标准译法", knowledgeHintRefs: ["h001"], batch: "像差术语" }] });
  const fetchImpl = async (_url, request) => { requests.push(JSON.parse(request.body)); const raw = JSON.stringify({ id: "lite-response",
    choices: [{ index: 0, finish_reason: "stop", message: { content, reasoning_content: "private reasoning" } }],
    usage: { prompt_tokens: 12, completion_tokens: 22, total_tokens: 34, completion_tokens_details: { reasoning_tokens: 9 } } });
    return { ok: true, status: 200, headers: { get: () => null, entries: () => [] }, arrayBuffer: async () => Buffer.from(raw) }; };
  const result = await invokeM5EDetectorV3DeepSeek({ coverage, modelId: "deepseek-v4-flash", maxOutputTokens: 65_536,
    maximumAttempts: 1, promptVariant: "lite-v1", temperature: 1 }, { credential: "fixture-key", fetchImpl });
  assert.equal(requests.length, 1); assert.equal(requests[0].temperature, 1); assert.match(requests[0].messages[0].content, /Complete valid example/);
  assert.equal(result.items[0].issue, "preferred-translation"); assert.equal(result.usage.calls, 1);
});
