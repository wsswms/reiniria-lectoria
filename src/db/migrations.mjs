import { createHash } from "node:crypto";

export const CURRENT_SCHEMA_VERSION = 5;

export const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: "workspace-document-core",
    sql: `
      CREATE TABLE workspace_meta (
        singleton INTEGER NOT NULL DEFAULT 1 PRIMARY KEY CHECK (singleton = 1),
        workspace_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE documents (
        workspace_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, document_id),
        FOREIGN KEY (workspace_id)
          REFERENCES workspace_meta(workspace_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE source_revisions (
        workspace_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        original_digest TEXT NOT NULL,
        normalized_digest TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, source_revision_id),
        UNIQUE (workspace_id, document_id, original_digest),
        FOREIGN KEY (workspace_id, document_id)
          REFERENCES documents(workspace_id, document_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE segments (
        workspace_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        structural_path TEXT NOT NULL,
        source_text TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        translatable INTEGER NOT NULL CHECK (translatable IN (0, 1)),
        protected_json TEXT NOT NULL CHECK (json_valid(protected_json)),
        PRIMARY KEY (workspace_id, segment_id),
        UNIQUE (workspace_id, source_revision_id, ordinal),
        FOREIGN KEY (workspace_id, source_revision_id)
          REFERENCES source_revisions(workspace_id, source_revision_id) ON DELETE CASCADE
      ) STRICT;
    `,
  }),
  Object.freeze({
    version: 2,
    name: "workspace-scoped-resources",
    sql: `
      CREATE TABLE object_records (
        workspace_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (workspace_id, resource_id),
        FOREIGN KEY (workspace_id)
          REFERENCES workspace_meta(workspace_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE task_placeholders (
        workspace_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (workspace_id, resource_id),
        FOREIGN KEY (workspace_id)
          REFERENCES workspace_meta(workspace_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE idempotency_keys (
        workspace_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (workspace_id, resource_id),
        FOREIGN KEY (workspace_id)
          REFERENCES workspace_meta(workspace_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE cache_entries (
        workspace_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (workspace_id, resource_id),
        FOREIGN KEY (workspace_id)
          REFERENCES workspace_meta(workspace_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE derived_indexes (
        workspace_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (workspace_id, resource_id),
        FOREIGN KEY (workspace_id)
          REFERENCES workspace_meta(workspace_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE audit_events (
        workspace_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (workspace_id, resource_id),
        FOREIGN KEY (workspace_id)
          REFERENCES workspace_meta(workspace_id) ON DELETE CASCADE
      ) STRICT;
    `,
  }),
  Object.freeze({
    version: 3,
    name: "canonical-state-concurrency-idempotency",
    sql: `
      CREATE TRIGGER source_revisions_no_update
      BEFORE UPDATE ON source_revisions
      BEGIN SELECT RAISE(ABORT, 'source revision is immutable'); END;

      CREATE TRIGGER source_revisions_no_delete
      BEFORE DELETE ON source_revisions
      BEGIN SELECT RAISE(ABORT, 'source revision is immutable'); END;

      CREATE TRIGGER segments_no_update
      BEFORE UPDATE ON segments
      BEGIN SELECT RAISE(ABORT, 'segment is immutable'); END;

      CREATE TRIGGER segments_no_delete
      BEFORE DELETE ON segments
      BEGIN SELECT RAISE(ABORT, 'segment is immutable'); END;

      CREATE TABLE canonical_import_origins (
        workspace_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        origin_package_id TEXT NOT NULL,
        origin_segment_ref TEXT NOT NULL,
        PRIMARY KEY (workspace_id, segment_id),
        UNIQUE (workspace_id, origin_package_id, origin_segment_ref),
        FOREIGN KEY (workspace_id, document_id)
          REFERENCES documents(workspace_id, document_id),
        FOREIGN KEY (workspace_id, source_revision_id)
          REFERENCES source_revisions(workspace_id, source_revision_id),
        FOREIGN KEY (workspace_id, segment_id)
          REFERENCES segments(workspace_id, segment_id)
      ) STRICT;

      CREATE TABLE working_translations (
        workspace_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version >= 0),
        state TEXT NOT NULL CHECK(state IN (
          'imported', 'extraction-pending', 'source-confirmed', 'queued', 'generating',
          'draft-machine', 'candidate-invalid', 'candidate-valid', 'editing', 'human-reviewed',
          'approved-for-export', 'exported', 'stale', 'rejected'
        )),
        content_json TEXT NOT NULL CHECK(json_valid(content_json)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, document_id),
        FOREIGN KEY (workspace_id, document_id)
          REFERENCES documents(workspace_id, document_id)
      ) STRICT;

      CREATE TRIGGER working_translations_state_guard
      BEFORE UPDATE OF state ON working_translations
      WHEN (OLD.state || '->' || NEW.state) NOT IN (
        'imported->extraction-pending', 'imported->source-confirmed', 'imported->rejected',
        'extraction-pending->source-confirmed', 'extraction-pending->rejected',
        'source-confirmed->queued', 'source-confirmed->stale', 'source-confirmed->rejected',
        'queued->generating', 'queued->rejected',
        'generating->draft-machine', 'generating->candidate-invalid', 'generating->candidate-valid', 'generating->rejected',
        'draft-machine->candidate-invalid', 'draft-machine->candidate-valid', 'draft-machine->rejected',
        'candidate-invalid->queued', 'candidate-invalid->rejected',
        'candidate-valid->editing', 'candidate-valid->stale', 'candidate-valid->rejected',
        'editing->human-reviewed', 'editing->stale', 'editing->rejected',
        'human-reviewed->approved-for-export', 'human-reviewed->stale', 'human-reviewed->rejected',
        'approved-for-export->exported', 'approved-for-export->stale',
        'exported->stale',
        'stale->queued', 'stale->human-reviewed', 'stale->rejected',
        'rejected->queued'
      )
      BEGIN SELECT RAISE(ABORT, 'invalid working translation state transition'); END;

      CREATE TABLE command_idempotency (
        workspace_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        result_json TEXT NOT NULL CHECK(json_valid(result_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, operation, idempotency_key),
        FOREIGN KEY (workspace_id)
          REFERENCES workspace_meta(workspace_id)
      ) STRICT;

      CREATE TABLE domain_audit_events (
        workspace_id TEXT NOT NULL,
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        succeeded INTEGER NOT NULL CHECK(succeeded IN (0, 1)),
        details_json TEXT NOT NULL CHECK(json_valid(details_json)),
        occurred_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id)
          REFERENCES workspace_meta(workspace_id)
      ) STRICT;

      CREATE TRIGGER domain_audit_events_no_update
      BEFORE UPDATE ON domain_audit_events
      BEGIN SELECT RAISE(ABORT, 'domain audit is append-only'); END;

      CREATE TRIGGER domain_audit_events_no_delete
      BEFORE DELETE ON domain_audit_events
      BEGIN SELECT RAISE(ABORT, 'domain audit is append-only'); END;
    `,
  }),
  Object.freeze({
    version: 4,
    name: "layered-storage-manifests",
    sql: `
      CREATE TABLE committed_objects (
        workspace_id TEXT NOT NULL,
        object_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
        relative_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, object_id),
        UNIQUE (workspace_id, digest),
        FOREIGN KEY (workspace_id)
          REFERENCES workspace_meta(workspace_id)
      ) STRICT;

      CREATE TRIGGER committed_objects_no_update
      BEFORE UPDATE ON committed_objects
      BEGIN SELECT RAISE(ABORT, 'committed object is immutable'); END;

      CREATE TRIGGER committed_objects_no_delete
      BEFORE DELETE ON committed_objects
      BEGIN SELECT RAISE(ABORT, 'committed object is immutable'); END;
    `,
  }),
  Object.freeze({
    version: 5,
    name: "workspace-summary-data-transform",
    sql: `
      CREATE TABLE workspace_summary (
        workspace_id TEXT PRIMARY KEY,
        document_count INTEGER NOT NULL CHECK(document_count >= 0),
        rebuilt_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id)
          REFERENCES workspace_meta(workspace_id)
      ) STRICT;

      INSERT INTO workspace_summary(workspace_id, document_count, rebuilt_at)
      SELECT workspace_id,
             (SELECT count(*) FROM documents WHERE documents.workspace_id = workspace_meta.workspace_id),
             '1970-01-01T00:00:00.000Z'
      FROM workspace_meta;
    `,
  }),
]);

export function migrationChecksum(migration) {
  return createHash("sha256")
    .update(`${migration.version}\n${migration.name}\n${migration.sql}`, "utf8")
    .digest("hex");
}

export function applyMigrations(database, { inject = () => {} } = {}) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const existing = new Map(
    database.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all()
      .map((row) => [row.version, row]),
  );

  for (const [version, row] of existing) {
    const migration = MIGRATIONS.find((candidate) => candidate.version === version);
    if (!migration) throw new Error(`database schema version ${version} is newer or unsupported`);
    if (row.name !== migration.name || row.checksum !== migrationChecksum(migration)) {
      throw new Error(`migration ${version} integrity mismatch`);
    }
  }

  for (const migration of MIGRATIONS) {
    if (existing.has(migration.version)) continue;
    inject(`before-migration-${migration.version}`);
    const apply = database.transaction(() => {
      database.exec(migration.sql);
      inject(`after-sql-${migration.version}`);
      database.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(
        migration.version,
        migration.name,
        migrationChecksum(migration),
        new Date(0).toISOString(),
      );
      database.pragma(`user_version = ${migration.version}`);
    });
    apply();
    inject(`after-commit-${migration.version}`);
  }

  const userVersion = database.pragma("user_version", { simple: true });
  if (userVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`expected schema ${CURRENT_SCHEMA_VERSION}, got ${userVersion}`);
  }
}
