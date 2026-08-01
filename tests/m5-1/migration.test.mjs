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

test("schemas v1 through v14 migrate to v15 ten times without losing historical identity", async () => {
  for (let version = 1; version <= 14; version += 1) for (let repeat = 0; repeat < 10; repeat += 1) {
    const root = await mkdtemp(join(tmpdir(), `lectoria-m5-1-v${version}-`));
    const filename = join(root, "app.sqlite3");
    const historical = createAtVersion(filename, version);
    historical.database.close();
    const database = openWorkspaceDatabase(filename, { workspaceId: historical.workspaceId });
    assert.equal(database.pragma("user_version", { simple: true }), 15);
    assert.equal(database.prepare("SELECT workspace_id FROM workspace_meta").get().workspace_id, historical.workspaceId);
    assertDatabaseIntegrity(database);
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("schema 15 fault points leave only retryable v14 or complete v15", async () => {
  for (const point of ["before-migration-15", "after-sql-15", "after-commit-15"]) for (let repeat = 0; repeat < 10; repeat += 1) {
    const root = await mkdtemp(join(tmpdir(), "lectoria-m5-1-fault-"));
    const filename = join(root, "app.sqlite3");
    const historical = createAtVersion(filename, 14);
    try {
      assert.throws(() => applyMigrations(historical.database, { inject(current) { if (current === point) throw new Error(`injected ${point}`); } }), /injected/);
      assert.ok([14, 15].includes(historical.database.pragma("user_version", { simple: true })));
    } finally { historical.database.close(); }
    const reopened = openWorkspaceDatabase(filename, { workspaceId: historical.workspaceId });
    assert.equal(reopened.pragma("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
    assertDatabaseIntegrity(reopened);
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});
