import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  DEEPSEEK_API_ORIGIN,
  DEEPSEEK_PROVIDER_ID,
  DeepSeekProvider,
  buildDeepSeekRequest,
} from "../../src/provider/deepseek-provider.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function request(segments = 2) {
  return {
    workspaceId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), workflowId: randomUUID(), sourceRevisionId: randomUUID(),
    targetLanguage: "ja", providerId: DEEPSEEK_PROVIDER_ID, modelId: "deepseek-chat", maxOutputTokens: 321, promptVersion: "prompt-v1", contextDigest: sha("context"),
    segments: Array.from({ length: segments }, (_, index) => ({
      segmentId: randomUUID(), sourceDigest: sha(`source-${index}`), sourceText: `Public source ${index}`,
      protected: index === 0 ? [{ kind: "code", marker: "__C0__", value: "npm test" }] : [],
    })),
  };
}

function success(requestValue, overrides = {}) {
  return {
    id: "deepseek-response-fixture",
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: JSON.stringify({ candidates: requestValue.segments.map((segment) => ({ segmentId: segment.segmentId, text: `ja:${segment.sourceText}`, knowledgeNeeds: [] })) }),
        reasoning_content: "must never be persisted",
      },
    }],
    usage: { prompt_tokens: 30, prompt_cache_hit_tokens: 7, prompt_cache_miss_tokens: 23, completion_tokens: 12, total_tokens: 42 },
    ...overrides,
  };
}

test("DeepSeek request uses fixed endpoint, bearer auth and JSON Object mode with explicit JSON instruction", async () => {
  const input = request();
  const secret = `DEEPSEEK-SECRET-${randomUUID()}`;
  let observation;
  const adapter = new DeepSeekProvider({ fetchImpl: async (url, init) => {
    observation = { url, init };
    return new Response(JSON.stringify(success(input)), { status: 200 });
  } });
  const output = await adapter.invoke(input, { credential: secret });
  assert.equal(observation.url, `${DEEPSEEK_API_ORIGIN}/chat/completions`);
  assert.equal(observation.init.headers.authorization, `Bearer ${secret}`);
  const body = JSON.parse(observation.init.body);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.max_tokens, 321);
  assert.equal(body.stream, false);
  assert.match(body.messages[0].content, /valid JSON/);
  assert.match(body.messages[0].content, /\{\"candidates\"/);
  for (const id of [input.workspaceId, input.taskId, input.attemptId, input.workflowId, input.sourceRevisionId]) {
    assert.equal(observation.init.body.includes(id), false);
  }
  assert.equal(observation.url.includes(secret), false);
  assert.equal(observation.init.body.includes(secret), false);
  assert.deepEqual(output.usage, { inputTokens: 30, outputTokens: 12, cachedInputTokens: 7, totalTokens: 42 });
  assert.equal(JSON.stringify(output).includes("reasoning_content"), false);
  assert.equal(JSON.stringify(output).includes("must never be persisted"), false);
});

test("DeepSeek model and Provider identities cannot alter the fixed endpoint", () => {
  const input = request();
  assert.equal(buildDeepSeekRequest(input).url, `${DEEPSEEK_API_ORIGIN}/chat/completions`);
  assert.throws(() => buildDeepSeekRequest({ ...input, modelId: "../models" }), /modelId/);
  assert.throws(() => buildDeepSeekRequest({ ...input, providerId: "deepseek-compatible" }), /providerId/);
});

test("DeepSeek malformed, reordered, filtered, length-truncated and oversized outputs fail closed", async () => {
  const input = request();
  const reordered = success(input);
  const decoded = JSON.parse(reordered.choices[0].message.content);
  decoded.candidates.reverse();
  reordered.choices[0].message.content = JSON.stringify(decoded);
  const cases = [
    [new Response("not-json", { status: 200 }), "malformed-response"],
    [new Response(JSON.stringify(reordered), { status: 200 }), "malformed-response"],
    [new Response(JSON.stringify(success(input, { choices: [{ index: 0, finish_reason: "content_filter", message: { content: "" } }] })), { status: 200 }), "policy"],
    [new Response(JSON.stringify(success(input, { choices: [{ index: 0, finish_reason: "length", message: { content: "{}" } }] })), { status: 200 }), "malformed-response"],
    [new Response(JSON.stringify(success(input, { choices: [] })), { status: 200 }), "malformed-response"],
    [new Response("x", { status: 200, headers: { "content-length": String(4 * 1024 * 1024 + 1) } }), "malformed-response"],
  ];
  for (const [response, category] of cases) {
    const adapter = new DeepSeekProvider({ fetchImpl: async () => response });
    await assert.rejects(adapter.invoke(input, { credential: "fixture" }), (error) => error.category === category && !error.retryable);
  }
});

test("DeepSeek usage, HTTP, disconnect, cancellation and credentials fail closed without secret leakage", async () => {
  const input = request(1);
  const badUsage = success(input, { usage: { prompt_tokens: 30, prompt_cache_hit_tokens: 8, prompt_cache_miss_tokens: 23, completion_tokens: 12, total_tokens: 42 } });
  await assert.rejects(new DeepSeekProvider({ fetchImpl: async () => new Response(JSON.stringify(badUsage), { status: 200 }) }).invoke(input, { credential: "fixture" }), (error) => error.category === "malformed-response");
  const secret = `DEEPSEEK-SECRET-${randomUUID()}`;
  const matrix = [[401, "auth", false], [403, "auth", false], [429, "rate-limit", true], [408, "timeout", true], [504, "timeout", true], [500, "provider", true], [400, "policy", false]];
  for (const [status, category, retryable] of matrix) {
    const adapter = new DeepSeekProvider({ fetchImpl: async () => new Response(`private upstream ${secret}`, { status }) });
    await assert.rejects(adapter.invoke(input, { credential: secret }), (error) => error.category === category && error.retryable === retryable && !error.message.includes(secret));
  }
  await assert.rejects(new DeepSeekProvider({ fetchImpl: async () => { throw new Error("socket detail"); } }).invoke(input, { credential: secret }), (error) => error.category === "unknown-outcome" && !error.retryable);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new DeepSeekProvider({ fetchImpl: async () => { throw new DOMException("aborted", "AbortError"); } }).invoke(input, { credential: secret, signal: controller.signal }), (error) => error.category === "canceled" && !error.retryable);
  await assert.rejects(new DeepSeekProvider({ fetchImpl: async () => { throw new Error("must not run"); } }).invoke(input, { credential: "bad key" }), (error) => error.category === "auth");
});

test("DeepSeek translation evaluation audit retains raw final output reasoning and malformed bodies without authorization", async () => {
  const input = request(1); const secret = `TRANSLATION-AUDIT-SECRET-${randomUUID()}`; const records = [];
  const adapter = new DeepSeekProvider({ fetchImpl: async () => new Response(JSON.stringify(success(input)), { status: 200 }),
    audit: (record) => records.push(record), evaluationScope: "m5c-real-article-audit-v1" });
  await adapter.invoke({ ...input, maxOutputTokens: 16_384 }, { credential: secret });
  assert.equal(records.length, 2); assert.equal(records[0].role, "translation");
  assert.equal(records[1].response.reasoningContent, "must never be persisted");
  assert.equal(records[1].outcome.normalized, true); assert.equal(records[0].request.body.max_tokens, 16_384);
  assert.equal(JSON.stringify(records).includes(secret), false); assert.equal(JSON.stringify(records).includes("authorization"), false);

  const malformed = [];
  await assert.rejects(new DeepSeekProvider({ fetchImpl: async () => new Response("broken-json", { status: 200 }),
    audit: (record) => malformed.push(record), evaluationScope: "m5c-real-article-audit-v1" }).invoke(input, { credential: secret }),
  (error) => error.category === "malformed-response");
  assert.equal(malformed[1].response.rawBody, "broken-json"); assert.equal(malformed[1].outcome.normalized, false);
});
