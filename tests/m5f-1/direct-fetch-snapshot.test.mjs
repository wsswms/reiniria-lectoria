import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { stableJson } from "../../src/domain/contracts.mjs";
import { CURRENT_SCHEMA_VERSION } from "../../src/db/migrations.mjs";
import { DirectResearchFetchSnapshotService } from "../../src/research/direct-fetch-snapshot-service.mjs";
import { researchWorkspace } from "../m5r-2/helpers.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;

function fetched(text = "Penultimate means next to the last item in a series.") {
  const canonical = {
    requestedUrl: "https://official.example/reference",
    finalUrl: "https://official.example/reference",
    statusCode: 200,
    mimeType: "text/plain",
    title: "Official entry",
    extractedText: text,
    truncated: false,
    diagnostics: [],
    redirects: [],
    policyVersion: "restricted-fetch-v1",
  };
  return Object.freeze({ ...canonical, fetchedAt: new Date(0).toISOString(), contentDigest: sha(text),
    snapshotDigest: sha(stableJson(canonical)), untrusted: true });
}

async function fixture() {
  const value = await researchWorkspace({
    limits: { maxSearchCalls: 8, maxContentUrls: 8, maxModelTokens: 10_000, maxCostMicrosUsd: 10_000 },
    providerBudgets: { "fake-research-model": { maxSearchCalls: 8, maxContentUrls: 8, maxModelTokens: 10_000, maxCostMicrosUsd: 10_000 } },
  });
  const reservation = value.budgets.reserve(value.run.runId, { round: 1, capability: "research-model",
    providerId: "fake-research-model", query: "penultimate", language: "en", country: "US",
    idempotencyKey: "direct-fetch-fixture", estimate: { searchCalls: 1, contentUrls: 1, modelTokens: 1_000, costMicrosUsd: 100 } });
  return { ...value, reservation, snapshots: new DirectResearchFetchSnapshotService(value.setup.fixture.database, value.setup.fixture.workspaceId) };
}

test("current schema retains scoped immutable direct research fetch snapshots and generic proposal origins", async () => {
  const value = await fixture();
  try {
    assert.equal(CURRENT_SCHEMA_VERSION, 31);
    const table = value.setup.fixture.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'research_direct_fetch_snapshots'").get();
    assert.match(table.sql, /FOREIGN KEY \(workspace_id, run_id, query_id\)/);
    assert.match(value.setup.fixture.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_proposals'").get().sql,
      /origin_kind/);
    const stored = value.snapshots.persist(value.run.runId, value.reservation.queryId, fetched());
    assert.equal(stored.lineage, "direct");
    assert.equal(stored.untrusted, true);
    assert.throws(() => value.setup.fixture.database.prepare("UPDATE research_direct_fetch_snapshots SET title = 'tampered'").run(), /immutable/);
    assert.throws(() => value.setup.fixture.database.prepare("DELETE FROM research_direct_fetch_snapshots").run(), /immutable/);
    assert.throws(() => value.setup.fixture.database.prepare(`INSERT INTO research_direct_fetch_snapshots
      SELECT ?, snapshot_id || '-foreign', run_id, query_id, requested_url, final_url, fetched_at, fetch_policy_version,
        status_code, mime_type, title, extracted_text, content_digest, snapshot_digest, truncated, diagnostics_json, redirects_json, untrusted
      FROM research_direct_fetch_snapshots`).run(randomUUID()), /FOREIGN KEY/);
  } finally { await value.close(); }
});

test("direct snapshots are digest checked idempotent and usable as exact evidence", async () => {
  const value = await fixture();
  try {
    const input = fetched();
    const stored = value.snapshots.persist(value.run.runId, value.reservation.queryId, input);
    assert.deepEqual(value.snapshots.persist(value.run.runId, value.reservation.queryId, input), stored);
    assert.equal(value.snapshots.get(stored.snapshotId).extractedText, input.extractedText);
    assert.throws(() => value.snapshots.persist(value.run.runId, value.reservation.queryId,
      { ...input, contentDigest: sha("wrong") }), /digest/);
    value.setup.fixture.database.exec("DROP TRIGGER research_direct_fetch_snapshots_no_update");
    value.setup.fixture.database.prepare("UPDATE research_direct_fetch_snapshots SET title = 'corrupted' WHERE snapshot_id = ?").run(stored.snapshotId);
    assert.throws(() => value.snapshots.get(stored.snapshotId), /corrupted/);
    assert.throws(() => value.evidence.addSource(value.run.runId, value.reservation.queryId, {
      canonicalUrl: input.finalUrl, tier: "S1", lineage: "direct", artifactType: "fetch-snapshot", artifactId: stored.snapshotId,
    }), /corrupted/);
    value.setup.fixture.database.prepare("UPDATE research_direct_fetch_snapshots SET title = ? WHERE snapshot_id = ?").run(input.title, stored.snapshotId);
    const source = value.evidence.addSource(value.run.runId, value.reservation.queryId, {
      canonicalUrl: input.finalUrl, tier: "S1", lineage: "direct", artifactType: "fetch-snapshot", artifactId: stored.snapshotId,
    });
    const quote = "next to the last";
    const start = input.extractedText.indexOf(quote);
    const citation = value.evidence.cite(source.sourceId, { quote, locator: { start, end: start + quote.length } });
    assert.equal(citation.verified, true);
    assert.throws(() => value.evidence.addSource(value.run.runId, randomUUID(), {
      canonicalUrl: input.finalUrl, tier: "S1", lineage: "direct", artifactType: "fetch-snapshot", artifactId: stored.snapshotId,
    }), /unavailable|corrupted/);
  } finally { await value.close(); }
});
