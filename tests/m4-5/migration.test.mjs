import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { assertDatabaseIntegrity, openWorkspaceDatabase } from "../../src/db/connection.mjs";
import { applyMigrations, CURRENT_SCHEMA_VERSION, MIGRATIONS, migrationChecksum } from "../../src/db/migrations.mjs";

test("schema 14 fault points leave only retryable v13 or complete v14", async () => {
  for (const point of ["before-migration-14", "after-sql-14", "after-commit-14"]) for (let repeat = 0; repeat < 10; repeat += 1) {
    const root = await mkdtemp(join(tmpdir(), "lectoria-m4-5-migration-"));
    const filename = join(root, "app.sqlite3");
    const workspaceId = randomUUID();
    const database = new Database(filename);
    database.pragma("foreign_keys = ON");
    database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;");
    for (const migration of MIGRATIONS.filter((item) => item.version <= 13)) {
      if (migration.foreignKeysOff) database.pragma("foreign_keys = OFF");
      database.exec(migration.sql);
      if (migration.foreignKeysOff) database.pragma("foreign_keys = ON");
      database.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)").run(migration.version, migration.name, migrationChecksum(migration), new Date(0).toISOString());
      database.pragma(`user_version = ${migration.version}`);
    }
    database.prepare("INSERT INTO workspace_meta VALUES (1, ?, ?)").run(workspaceId, new Date(0).toISOString());
    try {
      assert.throws(() => applyMigrations(database, { inject(current) { if (current === point) throw new Error(`injected ${point}`); } }), /injected/);
      assert.ok([13, 14].includes(database.pragma("user_version", { simple: true })));
    } finally { database.close(); }
    const reopened = openWorkspaceDatabase(filename, { workspaceId });
    assert.equal(reopened.pragma("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
    assertDatabaseIntegrity(reopened);
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});
