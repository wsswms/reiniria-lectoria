import assert from "node:assert/strict";
import test from "node:test";
import {
  DeepSeekServerResearchAdapter,
  buildDeepSeekServerResearchRequest,
  normalizeDeepSeekServerResearchResponse,
} from "../../src/research/deepseek-server-research-adapter.mjs";

const researchCase = {
  schemaVersion: "deepseek-server-research-case-v1",
  caseId: "case-a",
  question: "Find the documented meaning of penultimate.",
  responseLanguage: "zh-CN",
  maxOutputTokens: 6000,
  reasoningEffort: "medium",
};

function payload({ status = "resolved", sources, includeMessage = true, text } = {}) {
  const result = {
    status,
    answer: status === "resolved" ? "倒数第二" : "",
    explanation: status === "resolved" ? "词典释义支持该结论。" : "没有足够证据。",
    sources: sources ?? [{ url: "https://dictionary.example/entry", title: "Entry", quote: "next to the last", sourceClass: "dictionary", supports: true }],
  };
  return {
    id: "resp-1",
    model: "deepseek-v4-flash",
    status: "completed",
    output: [
      { type: "web_search_call", status: "completed", action: { type: "search", queries: ["penultimate dictionary"] } },
      { type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://dictionary.example/entry" } },
      ...(includeMessage ? [{ type: "message", content: [{ type: "output_text", text: text ?? JSON.stringify(result) }] }] : []),
    ],
    usage: {
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 20 },
      output_tokens: 80,
      output_tokens_details: { reasoning_tokens: 30 },
      total_tokens: 200,
    },
  };
}

test("request forces Flash web search and minimal JSON object output", () => {
  const request = buildDeepSeekServerResearchRequest(researchCase);
  assert.equal(request.url, "https://api.deepseek.com/responses");
  assert.equal(request.body.model, "deepseek-v4-flash");
  assert.deepEqual(request.body.tools, [{ type: "web_search" }]);
  assert.deepEqual(request.body.tool_choice, { type: "web_search" });
  assert.deepEqual(request.body.text, { format: { type: "json_object" } });
  assert.equal(request.body.input.includes(researchCase.question), true);
  assert.equal("max_tool_calls" in request.body, false);
});

test("normalizer retains only completed opened HTTPS non-supplementary sources", () => {
  const response = payload({ sources: [
    { url: "https://dictionary.example/entry", title: "Good", quote: "next to the last", sourceClass: "dictionary", supports: true },
    { url: "https://unopened.example/a", title: "Unopened", quote: "claim", sourceClass: "professional", supports: true },
    { url: "http://dictionary.example/entry", title: "HTTP", quote: "claim", sourceClass: "dictionary", supports: true },
    { url: "https://dictionary.example/entry", title: "Extra", quote: "claim", sourceClass: "supplementary", supports: true },
    { url: "https://dictionary.example/entry", title: "Duplicate", quote: "next to the last", sourceClass: "dictionary", supports: true },
  ] });
  const result = normalizeDeepSeekServerResearchResponse(response, researchCase);
  assert.equal(result.outcome, "resolved-candidate");
  assert.equal(result.sources.length, 1);
  assert.deepEqual(result.droppedSources.map((item) => item.reason).sort(), ["duplicate", "insecure-url", "not-opened", "supplementary"]);
  assert.equal(result.usage.cachedInputTokens, 20);
  assert.equal(result.usage.reasoningTokens, 30);
  assert.equal(result.usage.totalTokens, 200);
  assert.equal(result.actions.length, 2);
});

test("usage actions contain completed server actions only", () => {
  const value = payload();
  value.output.splice(1, 0, { type: "web_search_call", status: "in_progress", action: { type: "search", queries: ["unfinished"] } });
  const result = normalizeDeepSeekServerResearchResponse(value, researchCase);
  assert.equal(result.actions.length, 2);
  assert.equal(result.actions.some((item) => item.queries?.includes("unfinished")), false);
});

test("not_found and unresolved are safe terminal model outcomes", () => {
  const notFound = normalizeDeepSeekServerResearchResponse(payload({ status: "not_found" }), researchCase);
  assert.equal(notFound.outcome, "not-found");
  assert.equal(notFound.sources.length, 0);
  assert.equal(notFound.droppedSources[0].reason, "terminal-outcome");
  assert.equal(normalizeDeepSeekServerResearchResponse(payload({ status: "unresolved", sources: [] }), researchCase).outcome, "unresolved");
});

test("malformed completed responses and unsupported model fail closed", () => {
  for (const value of [
    payload({ includeMessage: false }),
    payload({ text: "preface {\"status\":\"unresolved\"}" }),
    { ...payload(), status: "in_progress" },
    { ...payload(), model: "deepseek-v4-pro" },
    { ...payload(), usage: { ...payload().usage, total_tokens: 999 } },
  ]) assert.throws(() => normalizeDeepSeekServerResearchResponse(value, researchCase), (error) => error.category === "malformed-response");
});

test("resolved without an eligible opened source is protocol rejected", () => {
  const value = payload({ sources: [{ url: "https://unopened.example/a", title: "A", quote: "claim", sourceClass: "primary", supports: true }] });
  assert.throws(() => normalizeDeepSeekServerResearchResponse(value, researchCase), (error) => error.category === "protocol");
});

test("resolved with an empty answer is protocol rejected", () => {
  const value = payload();
  const model = JSON.parse(value.output.at(-1).content[0].text);
  model.answer = "  ";
  value.output.at(-1).content[0].text = JSON.stringify(model);
  assert.throws(() => normalizeDeepSeekServerResearchResponse(value, researchCase), (error) => error.category === "protocol");
});

test("HTTP invocation maps errors and never exposes credentials", async () => {
  const errors = [
    [401, "auth", false], [429, "rate-limit", true], [500, "provider", true],
  ];
  for (const [status, category, retryable] of errors) {
    const adapter = new DeepSeekServerResearchAdapter({ fetchImpl: async () => new Response("{}", { status }) });
    await assert.rejects(() => adapter.research(researchCase, { credential: "fixture-secret" }), (error) => {
      assert.equal(error.category, category);
      assert.equal(error.retryable, retryable);
      assert.equal(String(error).includes("fixture-secret"), false);
      return true;
    });
  }
  const unknown = new DeepSeekServerResearchAdapter({ fetchImpl: async () => { throw new Error("fixture-secret network detail"); } });
  await assert.rejects(() => unknown.research(researchCase, { credential: "fixture-secret" }), (error) => error.category === "unknown-outcome" && error.retryable === false);
});
