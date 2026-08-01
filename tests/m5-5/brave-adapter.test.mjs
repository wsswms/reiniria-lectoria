import assert from "node:assert/strict";
import test from "node:test";
import { BRAVE_SEARCH_ORIGIN, BraveSearchAdapter, buildBraveSearchRequest } from "../../src/search/brave-search-adapter.mjs";
import { stableJson } from "../../src/domain/contracts.mjs";
import { bravePayload, secretCanary } from "./helpers.mjs";

const request = Object.freeze({ query: "workspace terminology", count: 2, country: "US", searchLanguage: "en" });

test("Brave request uses one fixed origin minimal parameters and credential header", async () => {
  let observed;
  const adapter = new BraveSearchAdapter({ fetchImpl: async (url, init) => {
    observed = { url, init };
    return new Response(JSON.stringify(bravePayload()), { status: 200 });
  } });
  const outputs = [];
  for (let repeat = 0; repeat < 20; repeat += 1) outputs.push(await adapter.search(request, { credential: secretCanary }));
  assert.equal(new Set(outputs.map(stableJson)).size, 1);
  const url = new URL(observed.url);
  assert.equal(url.origin, BRAVE_SEARCH_ORIGIN);
  assert.equal(url.pathname, "/res/v1/web/search");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["count", "country", "extra_snippets", "q", "safesearch", "search_lang"]);
  assert.equal(observed.init.headers["x-subscription-token"], secretCanary);
  assert.equal(observed.url.includes(secretCanary), false);
  assert.equal(stableJson(outputs).includes(secretCanary), false);
  assert.equal(buildBraveSearchRequest(request).method, "GET");
});

test("Brave malformed errors rate limits timeouts and request expansion fail closed", async () => {
  const cases = [
    [new Response("not-json", { status: 200 }), "malformed-response", false],
    [new Response(JSON.stringify({ web: {} }), { status: 200 }), "malformed-response", false],
    [new Response("private", { status: 401 }), "auth", false],
    [new Response("private", { status: 429 }), "rate-limit", true],
    [new Response("private", { status: 504 }), "timeout", true],
    [new Response("private", { status: 500 }), "provider", true],
  ];
  for (let repeat = 0; repeat < 20; repeat += 1) for (const [response, category, retryable] of cases) {
    await assert.rejects(new BraveSearchAdapter({ fetchImpl: async () => response.clone() }).search(request, { credential: secretCanary }),
      (error) => error.category === category && error.retryable === retryable && !error.message.includes(secretCanary));
  }
  assert.throws(() => buildBraveSearchRequest({ ...request, origin: "https://evil.example" }), /unknown field/);
  assert.throws(() => buildBraveSearchRequest({ ...request, count: 21 }), /count/);
  await assert.rejects(new BraveSearchAdapter({ fetchImpl: async () => { throw new Error("network private"); } }).search(request, { credential: secretCanary }),
    (error) => error.category === "unknown-outcome" && !error.message.includes(secretCanary));
});
