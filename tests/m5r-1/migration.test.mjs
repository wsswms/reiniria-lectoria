import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { assertDatabaseIntegrity, openWorkspaceDatabase } from "../../src/db/connection.mjs";
import { applyMigrations, CURRENT_SCHEMA_VERSION, MIGRATIONS, migrationChecksum } from "../../src/db/migrations.mjs";
import { stableJson } from "../../src/domain/contracts.mjs";

const timestamp = new Date(0).toISOString();
const sha = (value) => `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;

function createAtVersion(filename, version) {
  const workspaceId = randomUUID();
  const database = new Database(filename);
  database.pragma("foreign_keys = ON");
  database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;");
  for (const migration of MIGRATIONS.filter((item) => item.version <= version)) {
    if (migration.foreignKeysOff) database.pragma("foreign_keys = OFF");
    database.exec(migration.sql);
    if (migration.foreignKeysOff) database.pragma("foreign_keys = ON");
    database.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)").run(migration.version, migration.name, migrationChecksum(migration), timestamp);
    database.pragma(`user_version = ${migration.version}`);
  }
  database.prepare("INSERT INTO workspace_meta VALUES (1, ?, ?)").run(workspaceId, timestamp);
  return { database, workspaceId };
}

function seedLegacyM5(database, workspaceId) {
  const documentId = randomUUID();
  const sourceRevisionId = randomUUID();
  const segmentId = randomUUID();
  const workflowId = randomUUID();
  const taskId = randomUUID();
  const investigationId = randomUUID();
  const searchRunId = sha("legacy-search-run");
  const resultId = sha("legacy-result");
  const fetchSnapshotId = sha("legacy-fetch");
  const proposalId = randomUUID();
  const proposalRevisionId = randomUUID();
  const decisionId = randomUUID();
  const factId = randomUUID();
  const factRevisionId = randomUUID();
  const objectId = randomUUID();
  const applicationId = randomUUID();
  const proposedSource = stableJson({ schemaVersion: "1.0", factId, revisionId: factRevisionId, kind: "knowledge", language: "en",
    scope: { documentIds: [documentId], tags: [], targetLanguages: ["zh-CN"] },
    content: { title: "Legacy fact", body: "Legacy M5 behavior remains stable.", tags: [], source: "public-fixture" } });
  database.transaction(() => {
    database.prepare("INSERT INTO documents VALUES (?, ?, 'legacy', ?)").run(workspaceId, documentId, timestamp);
    database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)").run(workspaceId, sourceRevisionId, documentId, sha("original"), sha("normalized"), timestamp);
    database.prepare("INSERT INTO document_segments VALUES (?, ?, ?, ?)").run(workspaceId, documentId, segmentId, timestamp);
    database.prepare("INSERT INTO source_segment_versions VALUES (?, ?, ?, ?, 'paragraph', '/0', 'legacy source', ?, 0, 1, '[]', 'initial')")
      .run(workspaceId, documentId, sourceRevisionId, segmentId, sha("legacy source"));
    database.prepare("INSERT INTO translation_workflows VALUES (?, ?, ?, ?, 'zh-CN', 0, 'source-confirmed', '{}', 'native', ?)")
      .run(workspaceId, workflowId, documentId, sourceRevisionId, timestamp);
    database.prepare("INSERT INTO translation_tasks VALUES (?, ?, ?, ?, ?, 'zh-CN', 'legacy-task', ?, 'policy-v1', 'completed', 0, ?, ?)")
      .run(workspaceId, taskId, workflowId, documentId, sourceRevisionId, sha("task"), timestamp, timestamp);
    database.prepare("INSERT INTO internet_investigations VALUES (?, ?, ?, ?, ?, ?, 'zh-CN', ?, 'legacy query', 'US', 'en', ?, 1, 'internet-search-policy-v1', 'restricted-fetch-policy-v1', 'user', 'legacy-user', ?, ?)")
      .run(workspaceId, investigationId, taskId, workflowId, documentId, sourceRevisionId, segmentId, sha("query"), timestamp, new Date(86_400_000).toISOString());
    database.prepare("INSERT INTO internet_search_runs VALUES (?, ?, ?, ?, ?, ?, 'brave-search', 'brave-v1', 'internet-search-policy-v1', ?, ?, ?)")
      .run(workspaceId, searchRunId, investigationId, taskId, workflowId, segmentId, sha("query"), sha("results"), timestamp);
    database.prepare("INSERT INTO internet_search_results VALUES (?, ?, ?, ?, 1, 'https://example.com/', ?, 'Legacy title', 'Legacy description', ?, ?)")
      .run(workspaceId, searchRunId, investigationId, resultId, sha("url"), sha("result"), new Date(900_000).toISOString());
    const extractedText = "Legacy public content";
    database.prepare("INSERT INTO internet_fetch_snapshots VALUES (?, ?, ?, ?, ?, 'https://example.com/', 'https://example.com/', ?, 'restricted-fetch-policy-v1', 200, 'text/plain', 'Legacy', ?, ?, ?, 0, '[]', '[]', 1)")
      .run(workspaceId, fetchSnapshotId, investigationId, searchRunId, resultId, timestamp, extractedText, sha(extractedText), sha("snapshot"));
    database.prepare("INSERT INTO knowledge_proposals VALUES (?, ?, ?, ?, ?, ?)").run(workspaceId, proposalId, investigationId, workflowId, segmentId, timestamp);
    database.prepare("INSERT INTO knowledge_proposal_revisions VALUES (?, ?, ?, ?, ?, 1, 'create', ?, NULL, ?, ?, 'proposal-v1', 'fixture', 'legacy-fixture', ?)")
      .run(workspaceId, proposalRevisionId, proposalId, investigationId, fetchSnapshotId, factId, proposedSource, sha(proposedSource), timestamp);
    database.prepare("INSERT INTO knowledge_proposal_heads VALUES (?, ?, ?, 1, 1, 'approved', ?)").run(workspaceId, proposalId, proposalRevisionId, timestamp);
    database.prepare("INSERT INTO knowledge_proposal_decisions VALUES (?, ?, ?, ?, 'approved', 'user', 'legacy-user', ?)").run(workspaceId, decisionId, proposalId, proposalRevisionId, timestamp);
    database.prepare("INSERT INTO committed_objects VALUES (?, ?, ?, 1, 'private/legacy', ?)").run(workspaceId, objectId, sha("object"), timestamp);
    database.prepare("INSERT INTO knowledge_facts VALUES (?, ?, 'knowledge', ?)").run(workspaceId, factId, timestamp);
    database.prepare("INSERT INTO knowledge_fact_revisions VALUES (?, ?, ?, 'knowledge', 1, 'en', ?, ?, ?, ?, ?, 'fixture', 'legacy-fixture', ?)")
      .run(workspaceId, factId, factRevisionId, stableJson({ targetLanguages: ["zh-CN"], tags: [], documentIds: [documentId] }),
        stableJson({ title: "Legacy fact", body: "Legacy M5 behavior remains stable.", tags: [], source: "public-fixture" }), sha("fact-content"), objectId,
        `knowledge/${factId}/${factRevisionId}.json`, timestamp);
    database.prepare("INSERT INTO knowledge_fact_heads VALUES (?, ?, 'knowledge', ?, 1, 0, 'active', ?)").run(workspaceId, factId, factRevisionId, timestamp);
    database.prepare("INSERT INTO knowledge_proposal_applications VALUES (?, ?, ?, ?, ?, 'create', ?, ?, ?, 'user', 'legacy-user', ?)")
      .run(workspaceId, applicationId, proposalId, proposalRevisionId, decisionId, factId, factRevisionId, sha(proposedSource), timestamp);
  })();
  return ["internet_investigations", "internet_search_runs", "internet_search_results", "internet_fetch_snapshots",
    "knowledge_proposals", "knowledge_proposal_revisions", "knowledge_proposal_heads", "knowledge_proposal_decisions", "knowledge_proposal_applications"];
}

function legacyM5Digests(database, tables) {
  const projections = {
    knowledge_proposals: "workspace_id, proposal_id, investigation_id, workflow_id, segment_id, created_at",
    knowledge_proposal_revisions: `workspace_id, proposal_revision_id, proposal_id, investigation_id, fetch_snapshot_id,
      version, operation, fact_id, base_fact_revision_id, proposed_source_json, proposed_source_digest,
      proposal_policy_version, actor_type, actor_id, created_at`,
  };
  return Object.fromEntries(tables.map((table) => [table, sha(stableJson(database.prepare(
    `SELECT ${projections[table] ?? "*"} FROM ${table} ORDER BY rowid`).all()))]));
}

test(`schemas v1 through v${CURRENT_SCHEMA_VERSION - 1} migrate to v${CURRENT_SCHEMA_VERSION} twenty times`, async () => {
  for (let version = 1; version < CURRENT_SCHEMA_VERSION; version += 1) for (let repeat = 0; repeat < 20; repeat += 1) {
    const root = await mkdtemp(join(tmpdir(), `lectoria-m5r-1-v${version}-`));
    const filename = join(root, "app.sqlite3");
    const historical = createAtVersion(filename, version);
    historical.database.close();
    const database = openWorkspaceDatabase(filename, { workspaceId: historical.workspaceId });
    assert.equal(database.pragma("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
    assert.equal(database.prepare("SELECT workspace_id FROM workspace_meta").get().workspace_id, historical.workspaceId);
    assertDatabaseIntegrity(database);
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(`schema ${CURRENT_SCHEMA_VERSION} fault points converge to previous or complete current schema`, async () => {
  const previous = CURRENT_SCHEMA_VERSION - 1;
  for (const point of [`before-migration-${CURRENT_SCHEMA_VERSION}`, `after-sql-${CURRENT_SCHEMA_VERSION}`, `after-commit-${CURRENT_SCHEMA_VERSION}`]) for (let repeat = 0; repeat < 10; repeat += 1) {
    const root = await mkdtemp(join(tmpdir(), "lectoria-m5r-1-fault-"));
    const filename = join(root, "app.sqlite3");
    const historical = createAtVersion(filename, previous);
    try {
      assert.throws(() => applyMigrations(historical.database, { inject(current) { if (current === point) throw new Error(`injected ${point}`); } }), /injected/);
      assert.ok([previous, CURRENT_SCHEMA_VERSION].includes(historical.database.pragma("user_version", { simple: true })));
    } finally { historical.database.close(); }
    const reopened = openWorkspaceDatabase(filename, { workspaceId: historical.workspaceId });
    assert.equal(reopened.pragma("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
    assertDatabaseIntegrity(reopened);
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a populated M5 single-query investigation and applied proposal keeps byte-identical normalized rows after v19 to current migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5r-1-legacy-"));
  const filename = join(root, "app.sqlite3");
  const legacy = createAtVersion(filename, 19);
  const tables = seedLegacyM5(legacy.database, legacy.workspaceId);
  const before = legacyM5Digests(legacy.database, tables);
  applyMigrations(legacy.database);
  assert.deepEqual(legacyM5Digests(legacy.database, tables), before);
  assert.deepEqual(legacy.database.prepare(`SELECT origin_kind AS originKind, investigation_id AS investigationId,
    research_run_id AS researchRunId FROM knowledge_proposals`).get(),
  { originKind: "legacy-investigation", investigationId: legacy.database.prepare("SELECT investigation_id AS id FROM internet_investigations").get().id,
    researchRunId: null });
  assert.deepEqual(legacy.database.prepare(`SELECT evidence_kind AS evidenceKind, direct_snapshot_id AS directSnapshotId
    FROM knowledge_proposal_revisions`).get(), { evidenceKind: "legacy-fetch", directSnapshotId: null });
  assert.equal(legacy.database.prepare("SELECT count(*) AS count FROM research_requests").get().count, 0);
  assert.deepEqual(legacy.database.prepare("SELECT scope_kind AS scopeKind, adapter_id AS adapterId FROM web_search_artifact_runs").get(),
    { scopeKind: "legacy-investigation", adapterId: "brave-search" });
  assert.equal(legacy.database.prepare("SELECT count(*) AS count FROM web_search_artifact_results").get().count, 1);
  assertDatabaseIntegrity(legacy.database);
  legacy.database.close();
  await rm(root, { recursive: true, force: true });
});

test("current schema installs scoped immutable research, evidence, budget, web artifact and cache foundations", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5r-1-schema-"));
  const filename = join(root, "app.sqlite3");
  const workspaceId = randomUUID();
  const database = openWorkspaceDatabase(filename, { workspaceId });
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  for (const name of ["research_requests", "research_request_revisions", "research_grants", "research_runs", "research_queries",
    "research_budget_ledger", "provider_content_snapshots", "research_sources", "research_citations", "research_claims",
    "research_reports", "knowledge_proposal_research_evidence", "web_search_artifact_runs", "web_search_artifact_results",
    "research_cache_inventory_entries"]) assert.equal(tables.has(name), true, name);
  for (let index = 0; index < 200; index += 1) assert.throws(() => database.prepare(`INSERT INTO research_cache_inventory_entries
    VALUES (?, ?, 'search-result', ?, 'cache/item', 1, 'public', 'included', 1, 'retain', ?)`)
    .run(randomUUID(), randomUUID(), randomUUID(), timestamp), /FOREIGN KEY/);
  assertDatabaseIntegrity(database);
  database.close();
  await rm(root, { recursive: true, force: true });
});
