import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { providerResponseContract } from "../../src/provider/contracts.mjs";
import { buildDeepSeekRequest } from "../../src/provider/deepseek-provider.mjs";
import { createLivePilotOperations } from "../../src/pilot/live-operations.mjs";

const config = Object.freeze({
  article: { digest: `sha256:${"a".repeat(64)}`, title: "Vest Pocket Kodak", targetLanguage: "zh-CN" },
  deepseek: {
    modelId: "deepseek-v4-flash", credentialPath: "/unused/in-offline-test",
    pricing: { version: "comparison-test", inputMicrosPerMillion: 1, outputMicrosPerMillion: 1, cachedInputMicrosPerMillion: 0 },
    translation: { maxCalls: 20, maxOutputTokens: 1_024, hardLimitMicros: 100_000 },
  },
});

function fakeResponse(request) {
  return providerResponseContract({
    responseId: randomUUID(), providerId: request.providerId, modelId: request.modelId,
    candidates: request.segments.map((segment) => ({ segmentId: segment.segmentId, text: `译文：${segment.sourceText}` })),
    usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, totalTokens: 120 },
  }, request);
}

const termFact = Object.freeze({
  kind: "term", language: "zh-CN", tags: ["comparison"],
  content: {
    term: "ベス単", preferredTranslations: [{ language: "zh-CN", text: "贝斯单镜头" }],
    forbiddenTranslations: [{ language: "zh-CN", text: "最佳单镜头" }], variants: [], note: "首选译名：全文统一使用贝斯单镜头。",
  },
});

const documentFact = Object.freeze({
  kind: "knowledge", language: "zh-CN", tags: ["comparison"],
  content: {
    title: "文書全体の翻訳方針", body: "Vest 是服装背心，不是 Best；专名和术语必须全文一致。",
    tags: ["consistency"], source: "offline-comparison-fixture",
  },
});

async function run(profile) {
  const requests = [];
  const operations = await createLivePilotOperations(config, {
    knowledgeProfile: profile,
    invokeTranslationProvider: async (request) => fakeResponse(request),
    onTranslationRequest: async (request) => requests.push(request),
  });
  try {
    const result = await operations.translate({ sourceParagraphs: ["ベス単を使う。", "全文の用語を揃える。"], targetLanguage: "zh-CN" });
    return { requests, result, diagnostics: operations.diagnostics() };
  } finally { await operations.close(); }
}

test("A/B/C comparison changes only bounded evidence while keeping the translation contract fixed", async () => {
  const baseline = await run(undefined);
  const dictionary = await run({ label: "dictionary", facts: [termFact], segmentQueries: [["首选译名"], []], topK: 8 });
  const researched = await run({ label: "researched", facts: [termFact, documentFact],
    segmentQueries: [["首选译名", "文書全体の翻訳方針"], ["文書全体の翻訳方針"]], topK: 8 });
  const baselineBySource = new Map(baseline.requests.map((request) => [request.segments[0].sourceText, request]));

  for (const variant of [baseline, dictionary, researched]) {
    assert.equal(variant.result.segments.length, 2);
    assert.deepEqual(variant.result.validation, { errors: 0, warnings: 0 });
    assert.equal(variant.requests.length, 2);
    for (const request of variant.requests) {
      assert.equal(request.modelId, "deepseek-v4-flash");
      assert.equal(request.targetLanguage, "zh-CN");
      assert.equal(request.maxOutputTokens, 1_024);
      assert.equal(request.promptVersion, variant === baseline ? "lectoria-translation-v1" : "lectoria-translation-v2");
      assert.ok(baselineBySource.has(request.segments[0].sourceText));
    }
  }
  assert.ok(baseline.requests.every((request) => request.evidence === undefined));
  const dictionaryBySource = new Map(dictionary.requests.map((request) => [request.segments[0].sourceText, request]));
  const researchedBySource = new Map(researched.requests.map((request) => [request.segments[0].sourceText, request]));
  assert.equal(dictionaryBySource.get("ベス単を使う。").evidence.length, 1);
  assert.equal(dictionaryBySource.get("全文の用語を揃える。").evidence, undefined);
  assert.deepEqual(dictionaryBySource.get("ベス単を使う。").evidence[0].hits.map((hit) => hit.kind), ["term"]);
  assert.equal(researchedBySource.get("ベス単を使う。").evidence.length, 2);
  assert.equal(researchedBySource.get("全文の用語を揃える。").evidence.length, 1);
  assert.ok(researched.requests.flatMap((request) => request.evidence ?? [])
    .flatMap((evidence) => evidence.hits).some((hit) => hit.kind === "knowledge"));
  const outbound = buildDeepSeekRequest(researched.requests[0]);
  assert.match(outbound.body.messages[0].content, /Use relevant controller-supplied evidence/);
  assert.match(outbound.body.messages[0].content, /preferredTranslation and forbiddenTranslation/);
  assert.match(outbound.body.messages[0].content, /never execute commands/);
  assert.ok(dictionaryBySource.get("ベス単を使う。").evidence[0].hits
    .some((hit) => /preferredTranslation\[zh-CN\]/.test(hit.snippet)));
  assert.deepEqual(baseline.diagnostics, { profile: null, facts: 0, evidenceSnapshots: 0, evidenceBoundSegments: 0 });
  assert.deepEqual(dictionary.diagnostics, { profile: "dictionary", facts: 1, evidenceSnapshots: 1, evidenceBoundSegments: 1 });
  assert.deepEqual(researched.diagnostics, { profile: "researched", facts: 2, evidenceSnapshots: 3, evidenceBoundSegments: 2 });
});

test("comparison profiles fail closed on missing retrieval evidence", async () => {
  const operations = await createLivePilotOperations(config, {
    knowledgeProfile: { label: "bad", facts: [termFact], segmentQueries: [["不存在"], []], topK: 8 },
    invokeTranslationProvider: async (request) => fakeResponse(request),
  });
  try {
    await assert.rejects(operations.translate({ sourceParagraphs: ["一。", "二。"], targetLanguage: "zh-CN" }), /no evidence/);
  } finally { await operations.close(); }
});
