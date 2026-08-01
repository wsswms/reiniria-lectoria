import { performance } from "node:perf_hooks";
import { stableJson } from "../src/domain/contracts.mjs";
import { createRealBraveGatewayAdapter, loadRealBraveEvaluationManifest, preflightRealBraveEvaluation,
  summarizeRealBraveResult } from "../src/research/real-brave-evaluation.mjs";
import { researchWorkspace } from "../tests/m5r-2/helpers.mjs";

if (process.env.BRAVE_REAL_SEARCH !== "1") throw new Error("real Brave Search requires BRAVE_REAL_SEARCH=1");
const credentialPath = process.env.BRAVE_KEY_FILE;
if (typeof credentialPath !== "string" || credentialPath.length === 0) throw new Error("BRAVE_KEY_FILE is required");
const manifest = await loadRealBraveEvaluationManifest();
await preflightRealBraveEvaluation({ manifest, credentialPath });
const plannedCost = manifest.maximumCalls * manifest.costMicrosUsdPerCall;
const adapter = createRealBraveGatewayAdapter({ credentialPath, costMicrosUsdPerCall: manifest.costMicrosUsdPerCall,
  brokerOptions: { timeoutMs: 15_000 } });
const fixture = await researchWorkspace({ searchProviderId: manifest.providerId, adapterOverrides: { search: adapter },
  limits: { maxSearchCalls: manifest.maximumCalls, maxCostMicrosUsd: plannedCost },
  providerBudgets: { [manifest.providerId]: { maxSearchCalls: manifest.maximumCalls, maxCostMicrosUsd: plannedCost } } });
const startedAt = new Date().toISOString();
try {
  const observations = [];
  for (const item of manifest.queries) {
    const started = performance.now();
    const response = await fixture.gateway.search(fixture.capability, fixture.run.runId, { providerId: manifest.providerId,
      round: 1, query: item.query, count: item.count, country: item.country, language: item.searchLanguage,
      idempotencyKey: `m5r-4a:${item.id}` });
    observations.push(Object.freeze({ id: item.id, resultCount: response.results.length,
      uniqueOriginCount: new Set(response.results.map((result) => new URL(result.url).origin)).size,
      responseDigest: response.responseDigest, latencyMs: Math.round(performance.now() - started) }));
  }
  const output = summarizeRealBraveResult({ manifest, observations, totals: fixture.budgets.totals(fixture.grant.grantId),
    startedAt, completedAt: new Date().toISOString() });
  process.stdout.write(`${stableJson(output)}\n`);
} finally { await fixture.close(); }
