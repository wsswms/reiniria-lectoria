import assert from "node:assert/strict";
import test from "node:test";
import { RESEARCH_ADAPTER_MANIFESTS, adapterManifestContract } from "../../src/research/adapter-manifest.mjs";
import { SerperSearchAdapter, TavilyExtractAdapter, TavilySearchAdapter } from "../../src/research/provider-web-adapters.mjs";
import { BraveResearchSearchAdapter } from "../../src/research/web-adapter-broker.mjs";

const request = { query: "public synthetic terminology", count: 2, country: "US", searchLanguage: "en" };
const normal = {
  "brave-search": { web: { results: [{ title: "A", url: "https://example.com/a", description: "alpha" }] } },
  "serper-search": { organic: [{ title: "A", link: "https://example.com/a", snippet: "alpha" }] },
  "tavily-search": { results: [{ title: "A", url: "https://example.com/a", content: "alpha" }] },
  "tavily-extract": { results: [{ url: "https://example.com/a", raw_content: "alpha" }] },
};
const empty = { "brave-search": { web: { results: [] } }, "serper-search": { organic: [] }, "tavily-search": { results: [] }, "tavily-extract": { results: [] } };

function adapter(id, response) {
  const fetchImpl = async () => response;
  if (id === "brave-search") return new BraveResearchSearchAdapter({ fetchImpl });
  if (id === "serper-search") return new SerperSearchAdapter({ fetchImpl });
  if (id === "tavily-search") return new TavilySearchAdapter({ fetchImpl });
  return new TavilyExtractAdapter({ fetchImpl });
}
async function invoke(value, id) { return id === "tavily-extract"
  ? value.extract({ url: "https://example.com/a" }, { credential: "fixture-key" })
  : value.search(request, { credential: "fixture-key" }); }

for (const id of ["brave-search", "serper-search", "tavily-search", "tavily-extract"]) test(`${id} fixture matrix normalizes twenty times per case`, async () => {
  const cases = [
    { name: "normal", response: () => new Response(JSON.stringify(normal[id]), { status: 200 }), ok: true },
    { name: "empty", response: () => new Response(JSON.stringify(empty[id]), { status: 200 }), ok: id !== "tavily-extract", category: "malformed-response" },
    { name: "missing", response: () => new Response("{}", { status: 200 }), category: "malformed-response" },
    { name: "unknown", response: () => new Response(JSON.stringify({ ...normal[id], ignored: { nested: true } }), { status: 200 }), ok: true },
    { name: "429", response: () => new Response("{}", { status: 429 }), category: "rate-limit" },
    { name: "timeout", fetch: async () => { throw Object.assign(new Error("private"), { name: "TimeoutError" }); }, category: "timeout" },
    { name: "auth", response: () => new Response("{}", { status: 401 }), category: "auth" },
    { name: "provider", response: () => new Response("{}", { status: 500 }), category: "provider" },
    { name: "malformed", response: () => new Response("not-json", { status: 200 }), category: "malformed-response" },
    { name: "oversize", response: () => new Response("{}", { status: 200, headers: { "content-length": String(5 * 1024 * 1024) } }), category: "malformed-response" },
  ];
  for (const item of cases) for (let repeat = 0; repeat < 20; repeat += 1) {
    const value = item.fetch ? (id === "brave-search" ? new BraveResearchSearchAdapter({ fetchImpl: item.fetch })
      : id === "serper-search" ? new SerperSearchAdapter({ fetchImpl: item.fetch })
        : id === "tavily-search" ? new TavilySearchAdapter({ fetchImpl: item.fetch }) : new TavilyExtractAdapter({ fetchImpl: item.fetch }))
      : adapter(id, item.response());
    if (item.ok) assert.ok(await invoke(value, id));
    else await assert.rejects(() => invoke(value, id), (error) => error.category === item.category, `${id}:${item.name}`);
  }
});

test("versioned manifests fix capabilities filters direct evidence and unknown policy values", () => {
  assert.equal(RESEARCH_ADAPTER_MANIFESTS.length, 5);
  assert.equal(RESEARCH_ADAPTER_MANIFESTS.filter((item) => item.directWebEvidence).map((item) => item.adapterId).join(), "restricted-fetch");
  for (const manifest of RESEARCH_ADAPTER_MANIFESTS) {
    assert.deepEqual(adapterManifestContract({ ...manifest, filters: { ...manifest.filters }, policySnapshot: { ...manifest.policySnapshot } }), manifest);
    assert.equal(Object.values(manifest.policySnapshot).every((value) => value === null), true);
  }
});
