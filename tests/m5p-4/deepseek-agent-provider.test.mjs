import assert from "node:assert/strict";
import test from "node:test";
import {
  DeepSeekAgentProvider,
  buildDeepSeekAgentRequest,
  normalizeDeepSeekAgentResponse,
} from "../../src/agent/deepseek-agent-provider.mjs";

const context = Object.freeze({
  systemPrompt: "Translate and return JSON only.",
  messages: [
    { role: "user", content: [{ type: "text", text: "source" }], timestamp: 0 },
    { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "calculate_number",
      arguments: { schemaVersion: "number-calculation-request-v1", operation: "convert-unit", value: "50", from: "mm", to: "cm", precision: 2, rounding: "half-even" } }],
      api: "openai-completions", provider: "deepseek", model: "deepseek-chat", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0,
        totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1 },
    { role: "toolResult", toolCallId: "tool-1", toolName: "calculate_number", content: [{ type: "text", text: "{\"formattedValue\":\"5.00\"}" }],
      details: { receiptDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, isError: false, timestamp: 2 },
  ],
  tools: [],
});

const request = (overrides = {}) => ({ modelId: "deepseek-chat", mode: "normal", context,
  toolNames: ["lookup_dictionary", "lookup_entity", "calculate_number"], maxOutputTokens: 1024, ...overrides });

test("DeepSeek Agent request preserves Pi tool history and exposes only the three fixed strict tools", () => {
  const outbound = buildDeepSeekAgentRequest(request());
  assert.equal(outbound.url, "https://api.deepseek.com/chat/completions");
  assert.deepEqual(outbound.body.messages.slice(0, 2), [
    { role: "system", content: context.systemPrompt },
    { role: "user", content: "source" },
  ]);
  assert.equal(outbound.body.messages[2].tool_calls[0].function.name, "calculate_number");
  assert.deepEqual(JSON.parse(outbound.body.messages[2].tool_calls[0].function.arguments), context.messages[1].content[0].arguments);
  assert.deepEqual(outbound.body.messages[3], { role: "tool", tool_call_id: "tool-1", content: "{\"formattedValue\":\"5.00\"}" });
  assert.deepEqual(outbound.body.tools.map((tool) => tool.function.name), ["lookup_dictionary", "lookup_entity", "calculate_number"]);
  assert.ok(outbound.body.tools.every((tool) => tool.function.strict === true && tool.function.parameters.additionalProperties === false));
  assert.equal(outbound.body.stream, false);
  assert.deepEqual(outbound.body.thinking, { type: "disabled" });
});

test("DeepSeek tool and final responses normalize into lossless Pi assistant messages with bounded usage", () => {
  const toolRaw = { id: "resp-tool", choices: [{ index: 0, finish_reason: "tool_calls", message: { content: null, tool_calls: [
    { id: "call-dict", type: "function", function: { name: "lookup_dictionary", arguments: "{\"schemaVersion\":\"dictionary-lookup-request-v1\",\"term\":\"lens\",\"sourceLanguage\":\"en\",\"targetLanguage\":\"zh-CN\",\"context\":\"lens\",\"partOfSpeech\":null,\"requestedFields\":[\"translation\"]}" } },
  ] } }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_cache_hit_tokens: 3 } };
  const tool = normalizeDeepSeekAgentResponse(toolRaw, request(), { now: () => 7 });
  assert.equal(tool.assistantMessage.stopReason, "toolUse");
  assert.equal(tool.assistantMessage.content[0].id, "call-dict");
  assert.equal(tool.assistantMessage.content[0].name, "lookup_dictionary");
  assert.equal(tool.usage.calls, 1);
  assert.equal(tool.usage.inputTokens, 20);
  assert.equal(tool.usage.outputTokens, 5);

  const finalRaw = { id: "resp-final", choices: [{ index: 0, finish_reason: "stop", message: { content: "{\"translation\":\"镜头\"}" } }],
    usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 } };
  const final = normalizeDeepSeekAgentResponse(finalRaw, request({ mode: "final-only", toolNames: [] }), { now: () => 8 });
  assert.equal(final.assistantMessage.stopReason, "stop");
  assert.deepEqual(final.assistantMessage.content, [{ type: "text", text: "{\"translation\":\"镜头\"}" }]);
});

test("DeepSeek Agent adapter rejects undeclared tools, malformed arguments, reasoning and tool use in final-only mode", () => {
  const base = { id: "bad", choices: [{ index: 0, finish_reason: "tool_calls", message: { content: null, tool_calls: [
    { id: "bad-call", type: "function", function: { name: "shell", arguments: "{}" } },
  ] } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  assert.throws(() => normalizeDeepSeekAgentResponse(base, request()), (error) => ["malformed-response", "policy"].includes(error.category));
  assert.throws(() => normalizeDeepSeekAgentResponse({ ...base, choices: [{ ...base.choices[0], message: { ...base.choices[0].message,
    tool_calls: [{ id: "bad-call", type: "function", function: { name: "lookup_dictionary", arguments: "not-json" } }] } }] }, request()), /malformed/);
  assert.throws(() => normalizeDeepSeekAgentResponse({ ...base, choices: [{ ...base.choices[0], message: { ...base.choices[0].message,
    reasoning_content: "hidden", tool_calls: [{ id: "bad-call", type: "function", function: { name: "lookup_dictionary", arguments: "{}" } }] } }] },
  request()), (error) => error.category === "policy" && error.providerCode === "reasoning-content");
  assert.throws(() => normalizeDeepSeekAgentResponse({ ...base, choices: [{ ...base.choices[0], message: { ...base.choices[0].message,
    tool_calls: [{ id: "bad-call", type: "function", function: { name: "lookup_dictionary", arguments: "{}" } }] } }] },
  request({ mode: "final-only", toolNames: [] })), /final-only|policy/);
  assert.throws(() => buildDeepSeekAgentRequest(request({ toolNames: ["shell"] })), (error) => error.category === "policy");
});

test("DeepSeek Agent provider maps network uncertainty and never retries", async () => {
  let calls = 0;
  const provider = new DeepSeekAgentProvider({ fetchImpl: async () => { calls += 1; throw new Error("network"); } });
  await assert.rejects(() => provider.invoke(request(), { credential: "fixture-key" }), (error) => error.category === "unknown-outcome");
  assert.equal(calls, 1);
});
