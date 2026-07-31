import Database from "better-sqlite3";

export class WorkspaceRegistry {
  constructor(filename) {
    this.database = new Database(filename);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = FULL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        root_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('creating', 'active', 'archived', 'deleting')),
        schema_version INTEGER NOT NULL CHECK(schema_version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS workspace_lifecycle_audit (
        event_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        action TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      ) STRICT;

      CREATE TRIGGER IF NOT EXISTS workspace_lifecycle_audit_no_update
      BEFORE UPDATE ON workspace_lifecycle_audit
      BEGIN SELECT RAISE(ABORT, 'lifecycle audit is append-only'); END;

      CREATE TRIGGER IF NOT EXISTS workspace_lifecycle_audit_no_delete
      BEFORE DELETE ON workspace_lifecycle_audit
      BEGIN SELECT RAISE(ABORT, 'lifecycle audit is append-only'); END;
    `);
  }

  insert(record) {
    this.database.prepare(`
      INSERT INTO workspaces(workspace_id, display_name, root_key, state, schema_version, created_at, updated_at)
      VALUES (@workspaceId, @displayName, @rootKey, @state, @schemaVersion, @createdAt, @updatedAt)
    `).run(record);
  }

  get(workspaceId) {
    return this.database.prepare(`
      SELECT workspace_id AS workspaceId, display_name AS displayName, root_key AS rootKey,
             state, schema_version AS schemaVersion, created_at AS createdAt, updated_at AS updatedAt
      FROM workspaces WHERE workspace_id = ?
    `).get(workspaceId);
  }

  list() {
    return this.database.prepare(`
      SELECT workspace_id AS workspaceId, display_name AS displayName, root_key AS rootKey,
             state, schema_version AS schemaVersion, created_at AS createdAt, updated_at AS updatedAt
      FROM workspaces ORDER BY workspace_id
    `).all();
  }

  update(workspaceId, changes) {
    const current = this.get(workspaceId);
    if (!current) return false;
    const next = { ...current, ...changes, workspaceId };
    this.database.prepare(`
      UPDATE workspaces SET display_name = @displayName, state = @state,
        schema_version = @schemaVersion, updated_at = @updatedAt WHERE workspace_id = @workspaceId
    `).run(next);
    return true;
  }

  updateWithAudit(workspaceId, changes, event) {
    return this.database.transaction(() => {
      const updated = this.update(workspaceId, changes);
      if (!updated) return false;
      this.audit(event);
      return true;
    })();
  }

  audit(event) {
    this.database.prepare(`
      INSERT INTO workspace_lifecycle_audit(event_id, workspace_id, action, occurred_at)
      VALUES (@eventId, @workspaceId, @action, @occurredAt)
    `).run(event);
  }

  listAudit(workspaceId) {
    return this.database.prepare(`
      SELECT event_id AS eventId, workspace_id AS workspaceId, action, occurred_at AS occurredAt
      FROM workspace_lifecycle_audit WHERE workspace_id = ? ORDER BY rowid
    `).all(workspaceId);
  }

  delete(workspaceId) {
    return this.database.prepare("DELETE FROM workspaces WHERE workspace_id = ?").run(workspaceId).changes === 1;
  }

  close() { this.database.close(); }
}
