import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { assertDatabaseIntegrity, openWorkspaceDatabase } from "../../src/db/connection.mjs";
import { applyMigrations, CURRENT_SCHEMA_VERSION, MIGRATIONS, migrationChecksum } from "../../src/db/migrations.mjs";

const timestamp = new Date(0).toISOString();

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

test("schema 20 installs scoped immutable research, evidence, budget and cache foundations", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5r-1-schema-"));
  const filename = join(root, "app.sqlite3");
  const workspaceId = randomUUID();
  const database = openWorkspaceDatabase(filename, { workspaceId });
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  for (const name of ["research_requests", "research_request_revisions", "research_grants", "research_runs", "research_queries",
    "research_budget_ledger", "provider_content_snapshots", "research_sources", "research_citations", "research_claims",
    "research_reports", "knowledge_proposal_research_evidence", "research_cache_inventory_entries"]) assert.equal(tables.has(name), true, name);
  for (let index = 0; index < 200; index += 1) assert.throws(() => database.prepare(`INSERT INTO research_cache_inventory_entries
    VALUES (?, ?, 'search-result', ?, 'cache/item', 1, 'public', 'included', 1, 'retain', ?)`)
    .run(randomUUID(), randomUUID(), randomUUID(), timestamp), /FOREIGN KEY/);
  assertDatabaseIntegrity(database);
  database.close();
  await rm(root, { recursive: true, force: true });
});
