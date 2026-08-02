import assert from "node:assert/strict";
import test from "node:test";
import { buildDeepSeekThinkingComparisonRequest, summarizeDeepSeekRawResponse } from "../../src/pilot/deepseek-thinking-comparison.mjs";

const request = (thinkingMode) => ({ modelId: "deepseek-v4-flash", questions: ["Question?"],
  evidence: [{ observationId: "obs-1", url: "https://example.com/", title: "Title", content: "Exact evidence quote." }],
  maxOutputTokens: 2_048, thinkingMode });

test("thinking comparison changes only the thinking switch and sends an exact schema prompt", () => {
  const disabled = buildDeepSeekThinkingComparisonRequest(request("disabled"));
  const enabled = buildDeepSeekThinkingComparisonRequest(request("enabled"));
  assert.equal(disabled.url, "https://api.deepseek.com/chat/completions");
  assert.deepEqual({ ...disabled.body, thinking: undefined }, { ...enabled.body, thinking: undefined });
  assert.deepEqual(disabled.body.thinking, { type: "disabled" }); assert.deepEqual(enabled.body.thinking, { type: "enabled" });
  assert.match(disabled.body.messages[0].content, /Required shape:/); assert.match(disabled.body.messages[0].content, /byte-for-byte/);
});

test("raw comparison summary preserves measurable thinking and JSON output facts", () => {
  const responseText = JSON.stringify({ id: "r1", choices: [{ finish_reason: "stop", message: { reasoning_content: "reason", content: "{\"answers\":[],\"proposals\":[]}" } }],
    usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 } });
  const summary = summarizeDeepSeekRawResponse({ status: 200, responseText, durationMs: 123 });
  assert.equal(summary.reasoningBytes, 6); assert.equal(summary.contentIsJsonObject, true); assert.equal(summary.finishReason, "stop");
});
