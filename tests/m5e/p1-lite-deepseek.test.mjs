import assert from "node:assert/strict";
import test from "node:test";
import { invokeM5EP1LiteDeepSeek } from "../../scripts/m5e-p1-lite-deepseek.mjs";

const SEGMENT = "00000000-0000-4000-8000-000000000001";
const plannerRequest = { schemaVersion: "m5c-planner-request-v1", targetLanguage: "zh-CN", localItems: [{ kind: "term",
  coverage: "uncovered", instructionType: "warning-only", impact: "high", segmentIds: [SEGMENT], dependencies: {}, content: { value: "作例" } }] };
const payload = { items: [{ kind: "term", impact: "high", candidateIndexes: [0], subject: "作例",
  issue: "preferred-translation", question: "确认标准中文译法" }] };

function response(content, { reasoning = null } = {}) {
  const value = JSON.stringify({ id: "response-1", choices: [{ index: 0, finish_reason: "stop", message: { content, reasoning_content: reasoning } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, completion_tokens_details: { reasoning_tokens: reasoning ? 20 : 0 } } });
  return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode(value).buffer };
}

const configuration = (thinking = "disabled") => ({ plannerRequest, modelId: "deepseek-v4-flash", thinking, maxOutputTokens: 65_536, maximumAttempts: 2 });

test("P1-Lite DeepSeek adapter preserves thinking reasoning and strict normalized usage", async () => {
  const events = []; const result = await invokeM5EP1LiteDeepSeek(configuration("enabled"), { credential: "fixture-key",
    fetchImpl: async (_url, request) => { assert.deepEqual(JSON.parse(request.body).thinking, { type: "enabled" }); return response(JSON.stringify(payload), { reasoning: "private reasoning" }); },
    audit: (event) => events.push(event) });
  assert.equal(result.items.length, 1); assert.equal(result.usage.reasoningTokens, 20); assert.equal(result.usage.calls, 1);
  assert.equal(events.length, 2); assert.equal(events[1].response.reasoningContent, "private reasoning");
});

test("P1-Lite retries only a known billed malformed stop response", async () => {
  let calls = 0; const events = []; const result = await invokeM5EP1LiteDeepSeek(configuration(), { credential: "fixture-key",
    fetchImpl: async () => (++calls === 1 ? response("{") : response(JSON.stringify(payload))), audit: (event) => events.push(event) });
  assert.equal(calls, 2); assert.equal(result.usage.calls, 2); assert.equal(result.usage.inputTokens, 200);
  assert.equal(events[1].outcome.willRetry, true); assert.equal(events[3].outcome.normalized, true);
});

test("P1-Lite never retries unknown outcomes", async () => {
  let calls = 0;
  await assert.rejects(() => invokeM5EP1LiteDeepSeek(configuration(), { credential: "fixture-key", fetchImpl: async () => {
    calls += 1; throw Object.assign(new Error("socket"), { code: "ECONNRESET" }); } }), (error) => error.category === "unknown-outcome");
  assert.equal(calls, 1);
});
