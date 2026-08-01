import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRealBraveGatewayAdapter, loadRealBraveEvaluationManifest, preflightRealBraveEvaluation,
  realBraveEvaluationManifestContract, summarizeRealBraveResult } from "../../src/research/real-brave-evaluation.mjs";
import { researchWorkspace } from "../m5r-2/helpers.mjs";

async function credentialFixture() {
  const root = await mkdtemp(join(tmpdir(), "m5r4a-brave-")); const path = join(root, "brave.key");
  await writeFile(path, "M5R4A-FD-CANARY", { mode: 0o600 }); return { root, path };
}

test("fixed public-synthetic manifest and secure preflight fail closed without exposing the credential path or value", async () => {
  const manifest = await loadRealBraveEvaluationManifest(); const fixture = await credentialFixture();
  try {
    const output = await preflightRealBraveEvaluation({ manifest, credentialPath: fixture.path });
    assert.equal(output.calls, 3); assert.equal(output.plannedCostMicrosUsd, 15_000);
    assert.equal(JSON.stringify(output).includes(fixture.path), false); assert.equal(JSON.stringify(output).includes("M5R4A-FD-CANARY"), false);
    for (const mutate of [
      (value) => { value.maximumCalls = 11; }, (value) => { value.rawResponseRetention = true; },
      (value) => { value.credentialRef = "external-file:forged"; }, (value) => { value.queries[0].dataClass = "user-document"; },
      (value) => { value.policySnapshot.processingRegions = ["assumed-region"]; },
    ]) for (let repeat = 0; repeat < 40; repeat += 1) {
      const forged = JSON.parse(JSON.stringify(manifest)); mutate(forged); assert.throws(() => realBraveEvaluationManifestContract(forged), TypeError);
    }
    await chmod(fixture.path, 0o644);
    await assert.rejects(() => preflightRealBraveEvaluation({ manifest, credentialPath: fixture.path }), /permissions/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("real Brave facade uses fd-only Broker and Research Gateway atomically charges the fixed price", async () => {
  const manifest = await loadRealBraveEvaluationManifest(); const credential = await credentialFixture();
  const adapter = createRealBraveGatewayAdapter({ credentialPath: credential.path, costMicrosUsdPerCall: manifest.costMicrosUsdPerCall,
    brokerOptions: { entry: new URL("./web-broker-fixture.mjs", import.meta.url) } });
  const fixture = await researchWorkspace({ searchProviderId: manifest.providerId, adapterOverrides: { search: adapter },
    limits: { maxSearchCalls: 3, maxCostMicrosUsd: 15_000 },
    providerBudgets: { [manifest.providerId]: { maxSearchCalls: 3, maxCostMicrosUsd: 15_000 } } });
  try {
    const observations = [];
    for (const item of manifest.queries) {
      const response = await fixture.gateway.search(fixture.capability, fixture.run.runId, { providerId: manifest.providerId,
        round: 1, query: item.query, count: item.count, country: item.country, language: item.searchLanguage,
        idempotencyKey: `fixture:${item.id}` });
      assert.equal(JSON.stringify(response).includes("M5R4A-FD-CANARY"), false);
      observations.push({ id: item.id, resultCount: response.results.length, uniqueOriginCount: 1,
        responseDigest: response.responseDigest, latencyMs: 1 });
    }
    assert.deepEqual(fixture.budgets.totals(fixture.grant.grantId), { searchCalls: 3, contentUrls: 0, modelTokens: 0, costMicrosUsd: 15_000 });
    await assert.rejects(() => fixture.gateway.search(fixture.capability, fixture.run.runId, { providerId: manifest.providerId,
      round: 1, query: "one call too many", count: 1, country: "US", language: "en", idempotencyKey: "fixture:overflow" }), /budget exceeded/);
    const result = summarizeRealBraveResult({ manifest, observations, totals: fixture.budgets.totals(fixture.grant.grantId),
      startedAt: new Date(0).toISOString(), completedAt: new Date(1).toISOString() });
    assert.equal(result.conclusion, "conditional-go"); assert.equal(result.rawResponsePersisted, false);
    assert.deepEqual(result.unauthorizedServicesCalled, []);
  } finally { await fixture.close(); await rm(credential.root, { recursive: true, force: true }); }
});

test("an unknown real Search outcome conservatively consumes the pre-reserved call and price", async () => {
  const adapter = Object.freeze({ estimatedUsage: Object.freeze({ searchCalls: 1, contentUrls: 0, modelTokens: 0, costMicrosUsd: 5_000 }),
    async search() { throw Object.assign(new Error("bounded failure"), { category: "unknown-outcome" }); } });
  const fixture = await researchWorkspace({ searchProviderId: "brave-search", adapterOverrides: { search: adapter },
    limits: { maxSearchCalls: 1, maxCostMicrosUsd: 5_000 },
    providerBudgets: { "brave-search": { maxSearchCalls: 1, maxCostMicrosUsd: 5_000 } } });
  try {
    await assert.rejects(() => fixture.gateway.search(fixture.capability, fixture.run.runId, { providerId: "brave-search", round: 1,
      query: "public synthetic query", count: 1, country: "US", language: "en", idempotencyKey: "unknown:1" }), /bounded failure/);
    assert.deepEqual(fixture.budgets.totals(fixture.grant.grantId), { searchCalls: 1, contentUrls: 0, modelTokens: 0, costMicrosUsd: 5_000 });
    const row = fixture.setup.fixture.database.prepare("SELECT entry_type AS entryType FROM research_budget_ledger WHERE workspace_id = ? ORDER BY occurred_at, entry_type")
      .all(fixture.setup.fixture.workspaceId).map((item) => item.entryType);
    assert.deepEqual(row, ["reserved", "unknown"]);
  } finally { await fixture.close(); }
});
