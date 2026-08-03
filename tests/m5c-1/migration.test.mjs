import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { assertDatabaseIntegrity, openWorkspaceDatabase } from "../../src/db/connection.mjs";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, migrationChecksum } from "../../src/db/migrations.mjs";

test("schema v21 migrates to the current M5C foundation without mutating prior tables", async () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 27);
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-migration-")); const filename = join(root, "app.sqlite3"); const workspaceId = randomUUID();
  const legacy = new Database(filename); legacy.pragma("foreign_keys = ON");
  legacy.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;");
  for (const migration of MIGRATIONS.filter((item) => item.version <= 21)) {
    if (migration.foreignKeysOff) legacy.pragma("foreign_keys = OFF"); legacy.exec(migration.sql); if (migration.foreignKeysOff) legacy.pragma("foreign_keys = ON");
    legacy.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)").run(migration.version, migration.name, migrationChecksum(migration), new Date(0).toISOString());
    legacy.pragma(`user_version = ${migration.version}`);
  }
  legacy.prepare("INSERT INTO workspace_meta VALUES (1, ?, ?)").run(workspaceId, new Date(0).toISOString()); legacy.close();
  const database = openWorkspaceDatabase(filename, { workspaceId });
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  for (const name of ["translation_flow_controls", "flow_budget_policy_revisions", "flow_budget_ledger", "translation_context_plan_revisions",
    "translation_context_plan_items", "translation_context_plan_decisions", "user_guidance_revisions", "user_guidance_decisions",
    "m5c_research_bindings", "m5c_research_operations", "translation_flow_recovery_decisions",
    "context_disposition_decisions", "context_persistence_proposals", "candidate_knowledge_needs",
    "candidate_knowledge_need_decisions", "candidate_knowledge_need_plan_bindings",
    "candidate_knowledge_need_research_bindings"]) assert.equal(tables.has(name), true, name);
  assertDatabaseIntegrity(database); database.close(); await rm(root, { recursive: true, force: true });
});
