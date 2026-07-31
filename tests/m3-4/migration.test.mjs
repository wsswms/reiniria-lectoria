import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { openWorkspaceDatabase } from "../../src/db/connection.mjs";
import { applyMigrations, CURRENT_SCHEMA_VERSION, MIGRATIONS, migrationChecksum } from "../../src/db/migrations.mjs";

test("schema 9 migration fault points leave only retryable v8 or complete v9", async () => {
  for (const point of ["before-migration-9", "after-sql-9", "after-commit-9"]) for (let attempt = 0; attempt < 10; attempt += 1) {
    const root = await mkdtemp(join(tmpdir(), "lectoria-m3-4-migration-"));
    const filename = join(root, "app.sqlite3");
    const workspaceId = randomUUID();
    const database = new Database(filename);
    database.pragma("foreign_keys = ON");
    database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;");
    for (const migration of MIGRATIONS.filter((item) => item.version <= 8)) {
      if (migration.foreignKeysOff) database.pragma("foreign_keys = OFF");
      database.exec(migration.sql);
      if (migration.foreignKeysOff) database.pragma("foreign_keys = ON");
      database.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)").run(migration.version, migration.name, migrationChecksum(migration), new Date(0).toISOString());
      database.pragma(`user_version = ${migration.version}`);
    }
    database.prepare("INSERT INTO workspace_meta VALUES (1, ?, ?)").run(workspaceId, new Date(0).toISOString());
    try {
      assert.throws(() => applyMigrations(database, { inject(current) { if (current === point) throw new Error(`injected ${point}`); } }), /injected/);
      const version = database.pragma("user_version", { simple: true });
      assert.ok([8, 9].includes(version));
      assert.equal(database.prepare("SELECT count(*) AS total FROM sqlite_master WHERE type='table' AND name='candidate_creation_events'").get().total, version === 9 ? 1 : 0);
    } finally { database.close(); }
    const reopened = openWorkspaceDatabase(filename, { workspaceId });
    assert.equal(reopened.pragma("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
    assert.equal(reopened.prepare("SELECT count(*) AS total FROM candidate_creation_events").get().total, 0);
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});
