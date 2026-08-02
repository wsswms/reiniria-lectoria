import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeepSeekResearchRequest,
  DeepSeekResearchAdapter,
  normalizeDeepSeekResearchResponse,
} from "../../src/pilot/deepseek-research-adapter.mjs";

const request = () => ({
  modelId: "deepseek-v4-flash",
  questions: ["Is the minimum focus distance 65 cm?"],
  evidence: [{ observationId: "source-1", url: "https://example.com/reference", title: "Reference", content: "The minimum focus distance is 0.65 m." }],
  maxOutputTokens: 384_000,
  thinkingMode: "enabled",
});
const payload = () => ({
  id: "research-response-1",
  choices: [{ index: 0, finish_reason: "stop", message: { content: JSON.stringify({
    answers: [{ question: request().questions[0], answer: "The source states 0.65 m.", status: "supported", claims: [{
      text: "The stated minimum focus distance is 0.65 m.", evidence: [{ observationId: "source-1", quote: "The minimum focus distance is 0.65 m." }],
      inference: false, disputed: false, insufficient: false, narrowOfficial: false,
    }] }],
    proposals: [{ kind: "term", sourceLanguage: "ja", sourceText: "最短撮影距離", targetLanguage: "zh-CN", targetText: "最近对焦距离", note: "Photography terminology." }],
  }) } }],
  usage: { prompt_tokens: 300, completion_tokens: 120, total_tokens: 420, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 300 },
});

test("DeepSeek research request isolates untrusted evidence and honors the actual thinking contract", () => {
  const outbound = buildDeepSeekResearchRequest(request());
  assert.equal(outbound.url, "https://api.deepseek.com/chat/completions");
  assert.deepEqual(outbound.body.thinking, { type: "enabled" });
  assert.equal(outbound.body.max_tokens, 384_000);
  assert.match(outbound.body.messages[0].content, /exact contiguous substring/);
  assert.match(outbound.body.messages[0].content, /Required shape:/);
  assert.match(outbound.body.messages[0].content, /byte-for-byte/);
});

test("DeepSeek research response is strict, cited and usage-normalized", () => {
  const result = normalizeDeepSeekResearchResponse(payload(), request());
  assert.equal(result.answers[0].claims[0].evidence[0].observationId, "source-1");
  assert.equal(result.proposals[0].targetText, "最近对焦距离");
  assert.deepEqual(result.usage, { inputTokens: 300, outputTokens: 120, cachedInputTokens: 0, totalTokens: 420 });
  const unknownEvidence = payload();
  unknownEvidence.choices[0].message.content = unknownEvidence.choices[0].message.content.replace("source-1", "source-2");
  assert.throws(() => normalizeDeepSeekResearchResponse(unknownEvidence, request()), (error) => error?.category === "malformed-response");
});

test("DeepSeek research adapter sends only the fixed origin and rejects whitespace credentials", async () => {
  let observed;
  const adapter = new DeepSeekResearchAdapter({ fetchImpl: async (url, init) => {
    observed = { url, init }; return new Response(JSON.stringify(payload()), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const result = await adapter.reason(request(), { credential: "fixture-key" });
  assert.equal(result.responseId, "research-response-1");
  assert.equal(observed.url, "https://api.deepseek.com/chat/completions");
  assert.equal(JSON.parse(observed.init.body).model, "deepseek-v4-flash");
  await assert.rejects(() => adapter.reason(request(), { credential: "bad key" }), /failed/);
});
