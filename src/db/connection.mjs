import Database from "better-sqlite3";
import { applyMigrations, CURRENT_SCHEMA_VERSION } from "./migrations.mjs";

export function openWorkspaceDatabase(filename, { workspaceId, now = () => new Date() }) {
  const database = new Database(filename);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    applyMigrations(database);

    const rows = database.prepare("SELECT workspace_id FROM workspace_meta").all();
    if (rows.length === 0) {
      database.prepare("INSERT INTO workspace_meta(workspace_id, created_at) VALUES (?, ?)")
        .run(workspaceId, now().toISOString());
    } else if (rows.length !== 1 || rows[0].workspace_id !== workspaceId) {
      throw new Error("workspace database identity mismatch");
    }

    database.prepare(`
      INSERT INTO workspace_summary(workspace_id, document_count, rebuilt_at)
      SELECT ?, (SELECT count(*) FROM documents WHERE workspace_id = ?), ?
      WHERE NOT EXISTS (SELECT 1 FROM workspace_summary WHERE workspace_id = ?)
    `).run(workspaceId, workspaceId, new Date(0).toISOString(), workspaceId);

    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function databaseDiagnostics(database) {
  return Object.freeze({
    sqliteVersion: database.prepare("SELECT sqlite_version() AS version").get().version,
    schemaVersion: database.pragma("user_version", { simple: true }),
    expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
    foreignKeys: database.pragma("foreign_keys", { simple: true }) === 1,
    journalMode: database.pragma("journal_mode", { simple: true }),
    synchronous: database.pragma("synchronous", { simple: true }),
    integrity: database.pragma("integrity_check", { simple: true }),
    foreignKeyViolations: database.pragma("foreign_key_check").length,
  });
}

export function assertDatabaseIntegrity(database) {
  const diagnostics = databaseDiagnostics(database);
  if (diagnostics.integrity !== "ok") throw new Error(`database integrity failed: ${diagnostics.integrity}`);
  if (diagnostics.foreignKeyViolations !== 0) throw new Error("database foreign key check failed");
  if (!diagnostics.foreignKeys) throw new Error("database foreign keys are disabled");
  if (diagnostics.schemaVersion !== diagnostics.expectedSchemaVersion) throw new Error("database schema mismatch");
  return diagnostics;
}
