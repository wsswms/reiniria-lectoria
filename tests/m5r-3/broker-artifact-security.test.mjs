import assert from "node:assert/strict";
import test from "node:test";
import { stableJson } from "../../src/domain/contracts.mjs";
import { adapterManifest } from "../../src/research/adapter-manifest.mjs";
import { ResearchConflictError } from "../../src/research/foundation-service.mjs";
import { SerperSearchAdapter, TavilyExtractAdapter, TavilySearchAdapter, WebAdapterError } from "../../src/research/provider-web-adapters.mjs";
import { BraveResearchSearchAdapter, ResearchWebAdapterBroker } from "../../src/research/web-adapter-broker.mjs";
import { internetWorkspace, searchAndFetch } from "../m5-5/helpers.mjs";
import { researchWorkspace } from "../m5r-2/helpers.mjs";

const canary = "M5R3-FIXTURE-CREDENTIAL-NEVER-PERSIST";
function adapters() {
  return new Map([
    ["brave-search", new BraveResearchSearchAdapter({ fetchImpl: async () => new Response(JSON.stringify({ web: { results: [
      { title: "A", url: "https://official.example/a", description: "alpha" },
    ] } }), { status: 200 }) })],
    ["serper-search", new SerperSearchAdapter({ fetchImpl: async () => new Response(JSON.stringify({ organic: [
      { title: "A", link: "https://official.example/a", snippet: "alpha" },
    ] }), { status: 200 }) })],
    ["tavily-search", new TavilySearchAdapter({ fetchImpl: async () => new Response(JSON.stringify({ results: [
      { title: "A", url: "https://official.example/a", content: "alpha" },
    ] }), { status: 200 }) })],
    ["tavily-extract", new TavilyExtractAdapter({ fetchImpl: async () => new Response(JSON.stringify({ results: [
      { url: "https://official.example/a", raw_content: "alpha" },
    ] }), { status: 200 }) })],
  ]);
}

test("broker fixes credential refs manifests origins headers and normalized secret-free results", async () => {
  const seen = [];
  const map = adapters();
  const broker = new ResearchWebAdapterBroker({ adapters: map, resolveCredential: async (reference) => { seen.push(reference); return canary; } });
  for (const [providerId, capability] of [["brave-search", "search"], ["serper-search", "search"], ["tavily-search", "search"], ["tavily-extract", "extract"]]) {
    const input = capability === "search" ? { query: "public synthetic", count: 1, country: "US", searchLanguage: "en" }
      : { url: "https://official.example/a" };
    const response = await broker.invoke(providerId, capability, input);
    assert.equal(stableJson(response).includes(canary), false);
  }
  assert.deepEqual(seen, ["external-file:brave-search/m5r", "external-file:serper-search/m5r", "external-file:tavily-search/m5r", "external-file:tavily-extract/m5r"]);
  const unavailable = new ResearchWebAdapterBroker({ adapters: map, resolveCredential: async () => { throw new Error("missing"); } });
  await assert.rejects(() => unavailable.invoke("serper-search", "search", { query: "q", count: 1, country: "US", searchLanguage: "en" }),
    (error) => error instanceof WebAdapterError && error.category === "unavailable");
});

test("manifest identity origin credential adapter-version and direct-evidence forgeries fail two hundred times each", async () => {
  const base = adapterManifest("serper-search", "search");
  const mutations = [
    (item) => { item.id = "forged"; },
    (item) => { item.manifest = { ...item.manifest, origin: "https://evil.invalid" }; },
    (item) => { item.manifest = { ...item.manifest, credentialRef: "external-file:forged" }; },
    (item) => { item.manifest = { ...item.manifest, adapterVersion: "forged" }; },
  ];
  for (const mutate of mutations) {
    const forged = { id: "serper-search", manifest: base, async search() { return {}; } }; mutate(forged);
    const broker = new ResearchWebAdapterBroker({ adapters: new Map([["serper-search", forged]]), resolveCredential: async () => canary });
    for (let repeat = 0; repeat < 200; repeat += 1) await assert.rejects(() => broker.invoke("serper-search", "search",
      { query: "q", count: 1, country: "US", searchLanguage: "en" }), (error) => error.category === "policy");
  }
  const direct = { id: "serper-search", manifest: base, async search() { return { adapterId: "serper-search",
    adapterVersion: base.adapterVersion, results: [], directWebEvidence: true }; } };
  const broker = new ResearchWebAdapterBroker({ adapters: new Map([["serper-search", direct]]), resolveCredential: async () => canary });
  for (let repeat = 0; repeat < 200; repeat += 1) await assert.rejects(() => broker.invoke("serper-search", "search",
    { query: "q", count: 1, country: "US", searchLanguage: "en" }), (error) => error.category === "malformed-response");
});

test("key header origin proxy credentialRef adapterVersion and undeclared filters fail closed two hundred times each", async () => {
  const outbound = [];
  const serper = new SerperSearchAdapter({ fetchImpl: async (url, init) => { outbound.push({ url, init });
    return new Response(JSON.stringify({ organic: [] }), { status: 200 }); } });
  for (let repeat = 0; repeat < 200; repeat += 1) {
    await assert.rejects(() => serper.search({ query: "q", count: 1, country: "US", searchLanguage: "en" }, { credential: "bad key" }),
      (error) => error.category === "auth");
    for (const forged of [{ headers: {} }, { origin: "https://evil.invalid" }, { proxy: "http://127.0.0.1" },
      { credentialRef: "forged" }, { adapterVersion: "forged" }]) await assert.rejects(() => serper.search(
      { query: "q", count: 1, country: "US", searchLanguage: "en", ...forged }, { credential: canary }), TypeError);
  }
  const broker = new ResearchWebAdapterBroker({ adapters: new Map([["serper-search", serper]]), resolveCredential: async () => canary });
  for (let repeat = 0; repeat < 200; repeat += 1) await assert.rejects(() => broker.invoke("serper-search", "search",
    { query: "q", count: 1, country: "US", searchLanguage: "en", filters: { includeDomains: ["example.com"] } }),
  (error) => error.category === "policy");
  await serper.search({ query: "q", count: 1, country: "US", searchLanguage: "en" }, { credential: canary });
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].url, "https://google.serper.dev/search");
  assert.equal(outbound[0].init.headers["x-api-key"], canary);
  assert.equal("proxy" in outbound[0].init, false);
});

test("legacy Brave and ResearchQuery results enter one provider-neutral artifact chain with strict lineage", async () => {
  const legacy = await internetWorkspace();
  try {
    const completed = await searchAndFetch(legacy);
    const legacyRow = legacy.fixture.database.prepare("SELECT scope_kind AS scopeKind, adapter_id AS adapterId FROM web_search_artifact_runs WHERE workspace_id = ? AND artifact_run_id = ?")
      .get(legacy.fixture.workspaceId, completed.search.searchRunId);
    assert.deepEqual(legacyRow, { scopeKind: "legacy-investigation", adapterId: "brave-search" });
  } finally { await legacy.fixture.close(); }

  const research = await researchWorkspace();
  try {
    for (let repeat = 0; repeat < 200; repeat += 1) await assert.rejects(() => research.gateway.search(research.capability, research.run.runId,
      { providerId: "serper-search", round: 1, query: "unauthorized fallback", language: "en", country: "US", count: 1,
        idempotencyKey: `unauthorized-${repeat}` }), /outside the token/);
    const response = await research.gateway.search(research.capability, research.run.runId, { providerId: "fake-search", round: 1,
      query: "shared artifact", language: "en", country: "US", count: 2, idempotencyKey: "shared-artifact" });
    assert.equal(research.setup.fixture.database.prepare("SELECT scope_kind AS scopeKind FROM web_search_artifact_runs WHERE workspace_id = ? AND artifact_run_id = ?")
      .get(research.setup.fixture.workspaceId, response.artifactRunId).scopeKind, "research-query");
    const first = response.results[0];
    const source = research.evidence.addSource(research.run.runId, response.queryId, { canonicalUrl: first.url, tier: "S3",
      lineage: "search-snippet", artifactType: "search-result", artifactId: first.resultId });
    assert.equal(source.lineage, "search-snippet");
    for (let repeat = 0; repeat < 200; repeat += 1) assert.throws(() => research.evidence.addSource(research.run.runId, response.queryId,
      { canonicalUrl: first.url, tier: "S1", lineage: "direct", artifactType: "search-result", artifactId: first.resultId }), ResearchConflictError);
    assert.equal(stableJson(research.setup.fixture.database.prepare("SELECT * FROM workspace_meta").all()).includes(canary), false);
  } finally { await research.close(); }
});
