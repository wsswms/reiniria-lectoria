import { createHash } from "node:crypto";

export const CURRENT_SCHEMA_VERSION = 30;

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
  Object.freeze({
    version: 6,
    name: "document-segment-workflow-model",
    sql: `
      CREATE TABLE migration_6_guard (
        valid INTEGER NOT NULL CHECK(valid = 1)
      ) STRICT;

      INSERT INTO migration_6_guard(valid)
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM working_translations AS legacy
        WHERE (
          SELECT count(*)
          FROM source_revisions AS revision
          WHERE revision.workspace_id = legacy.workspace_id
            AND revision.document_id = legacy.document_id
        ) <> 1
      ) THEN 1 ELSE 0 END
      WHERE EXISTS (
        SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name = 'working_translations'
      );

      CREATE UNIQUE INDEX source_revisions_document_identity
        ON source_revisions(workspace_id, document_id, source_revision_id);

      CREATE TABLE document_segments (
        workspace_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, segment_id),
        UNIQUE (workspace_id, document_id, segment_id),
        FOREIGN KEY (workspace_id, document_id)
          REFERENCES documents(workspace_id, document_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE source_segment_versions (
        workspace_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        structural_path TEXT NOT NULL,
        source_text TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        translatable INTEGER NOT NULL CHECK (translatable IN (0, 1)),
        protected_json TEXT NOT NULL CHECK (json_valid(protected_json)),
        alignment_status TEXT NOT NULL CHECK (alignment_status IN (
          'initial', 'unchanged', 'changed', 'inserted', 'deleted', 'moved', 'ambiguous'
        )),
        PRIMARY KEY (workspace_id, source_revision_id, segment_id),
        UNIQUE (workspace_id, source_revision_id, ordinal),
        UNIQUE (workspace_id, source_revision_id, structural_path),
        FOREIGN KEY (workspace_id, document_id, source_revision_id)
          REFERENCES source_revisions(workspace_id, document_id, source_revision_id),
        FOREIGN KEY (workspace_id, document_id, segment_id)
          REFERENCES document_segments(workspace_id, document_id, segment_id)
      ) STRICT;

      INSERT INTO document_segments(workspace_id, document_id, segment_id, created_at)
      SELECT segment.workspace_id, revision.document_id, segment.segment_id, revision.imported_at
      FROM segments AS segment
      JOIN source_revisions AS revision
        ON revision.workspace_id = segment.workspace_id
       AND revision.source_revision_id = segment.source_revision_id;

      INSERT INTO source_segment_versions(
        workspace_id, document_id, source_revision_id, segment_id, kind,
        structural_path, source_text, source_digest, ordinal, translatable,
        protected_json, alignment_status
      )
      SELECT segment.workspace_id, revision.document_id, segment.source_revision_id,
             segment.segment_id, segment.kind, segment.structural_path,
             segment.source_text, segment.source_digest, segment.ordinal,
             segment.translatable, segment.protected_json, 'initial'
      FROM segments AS segment
      JOIN source_revisions AS revision
        ON revision.workspace_id = segment.workspace_id
       AND revision.source_revision_id = segment.source_revision_id;

      CREATE TABLE canonical_import_origins_v6 (
        workspace_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        origin_package_id TEXT NOT NULL,
        origin_segment_ref TEXT NOT NULL,
        PRIMARY KEY (workspace_id, source_revision_id, segment_id),
        UNIQUE (workspace_id, origin_package_id, origin_segment_ref),
        FOREIGN KEY (workspace_id, document_id)
          REFERENCES documents(workspace_id, document_id),
        FOREIGN KEY (workspace_id, document_id, source_revision_id)
          REFERENCES source_revisions(workspace_id, document_id, source_revision_id),
        FOREIGN KEY (workspace_id, source_revision_id, segment_id)
          REFERENCES source_segment_versions(workspace_id, source_revision_id, segment_id)
      ) STRICT;

      INSERT INTO canonical_import_origins_v6
      SELECT * FROM canonical_import_origins;

      CREATE TABLE translation_workflows (
        workspace_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        target_language TEXT NOT NULL
          CHECK(length(target_language) BETWEEN 2 AND 63)
          CHECK(target_language = trim(target_language))
          CHECK(instr(target_language, ' ') = 0),
        version INTEGER NOT NULL CHECK(version >= 0),
        state TEXT NOT NULL CHECK(state IN (
          'imported', 'extraction-pending', 'source-confirmed', 'queued', 'generating',
          'draft-machine', 'candidate-invalid', 'candidate-valid', 'editing', 'human-reviewed',
          'approved-for-export', 'exported', 'stale', 'rejected'
        )),
        legacy_content_json TEXT NOT NULL CHECK(json_valid(legacy_content_json)),
        origin_type TEXT NOT NULL CHECK(origin_type IN ('legacy', 'native')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, workflow_id),
        UNIQUE (workspace_id, document_id, source_revision_id, target_language),
        UNIQUE (workspace_id, workflow_id, document_id, source_revision_id, target_language),
        FOREIGN KEY (workspace_id, document_id, source_revision_id)
          REFERENCES source_revisions(workspace_id, document_id, source_revision_id)
      ) STRICT;

      INSERT INTO translation_workflows(
        workspace_id, workflow_id, document_id, source_revision_id,
        target_language, version, state, legacy_content_json, origin_type, updated_at
      )
      SELECT legacy.workspace_id, legacy.document_id, legacy.document_id,
             revision.source_revision_id, 'und', legacy.version, legacy.state,
             legacy.content_json, 'legacy', legacy.updated_at
      FROM working_translations AS legacy
      JOIN source_revisions AS revision
        ON revision.workspace_id = legacy.workspace_id
       AND revision.document_id = legacy.document_id;

      CREATE TRIGGER translation_workflows_state_guard
      BEFORE UPDATE OF state ON translation_workflows
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
      BEGIN SELECT RAISE(ABORT, 'invalid translation workflow state transition'); END;

      CREATE TABLE translation_candidates (
        workspace_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        target_language TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('user', 'local-fixture')),
        text TEXT NOT NULL,
        text_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, candidate_id),
        UNIQUE (workspace_id, workflow_id, segment_id, candidate_id),
        FOREIGN KEY (workspace_id, workflow_id, document_id, source_revision_id, target_language)
          REFERENCES translation_workflows(workspace_id, workflow_id, document_id, source_revision_id, target_language),
        FOREIGN KEY (workspace_id, source_revision_id, segment_id)
          REFERENCES source_segment_versions(workspace_id, source_revision_id, segment_id)
      ) STRICT;

      CREATE TABLE working_copy_revisions (
        workspace_id TEXT NOT NULL,
        working_copy_revision_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        target_language TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        parent_revision_id TEXT,
        source_candidate_id TEXT,
        text TEXT NOT NULL,
        text_digest TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'system', 'fixture')),
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, working_copy_revision_id),
        UNIQUE (workspace_id, workflow_id, segment_id, working_copy_revision_id),
        FOREIGN KEY (workspace_id, workflow_id, document_id, source_revision_id, target_language)
          REFERENCES translation_workflows(workspace_id, workflow_id, document_id, source_revision_id, target_language),
        FOREIGN KEY (workspace_id, source_revision_id, segment_id)
          REFERENCES source_segment_versions(workspace_id, source_revision_id, segment_id),
        FOREIGN KEY (workspace_id, workflow_id, segment_id, parent_revision_id)
          REFERENCES working_copy_revisions(workspace_id, workflow_id, segment_id, working_copy_revision_id),
        FOREIGN KEY (workspace_id, workflow_id, segment_id, source_candidate_id)
          REFERENCES translation_candidates(workspace_id, workflow_id, segment_id, candidate_id)
      ) STRICT;

      CREATE TABLE working_copy_heads (
        workspace_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        head_revision_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version >= 0),
        PRIMARY KEY (workspace_id, workflow_id, segment_id),
        FOREIGN KEY (workspace_id, workflow_id, segment_id, head_revision_id)
          REFERENCES working_copy_revisions(workspace_id, workflow_id, segment_id, working_copy_revision_id)
      ) STRICT;

      CREATE TABLE validation_runs (
        workspace_id TEXT NOT NULL,
        validation_run_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        target_language TEXT NOT NULL,
        working_copy_digest TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        validator_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, validation_run_id),
        UNIQUE (workspace_id, workflow_id, validation_run_id),
        FOREIGN KEY (workspace_id, workflow_id, document_id, source_revision_id, target_language)
          REFERENCES translation_workflows(workspace_id, workflow_id, document_id, source_revision_id, target_language)
      ) STRICT;

      CREATE TABLE validation_findings (
        workspace_id TEXT NOT NULL,
        validation_run_id TEXT NOT NULL,
        finding_id TEXT NOT NULL,
        severity TEXT NOT NULL CHECK(severity IN ('error', 'warning', 'info')),
        code TEXT NOT NULL,
        segment_id TEXT,
        details_json TEXT NOT NULL CHECK(json_valid(details_json)),
        PRIMARY KEY (workspace_id, validation_run_id, finding_id),
        FOREIGN KEY (workspace_id, validation_run_id)
          REFERENCES validation_runs(workspace_id, validation_run_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE review_events (
        workspace_id TEXT NOT NULL,
        review_event_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        validation_run_id TEXT,
        action TEXT NOT NULL CHECK(action IN ('human-reviewed', 'approved-for-export', 'warning-confirmed', 'stale-confirmed')),
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        details_json TEXT NOT NULL CHECK(json_valid(details_json)),
        occurred_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, review_event_id),
        FOREIGN KEY (workspace_id, workflow_id)
          REFERENCES translation_workflows(workspace_id, workflow_id),
        FOREIGN KEY (workspace_id, workflow_id, validation_run_id)
          REFERENCES validation_runs(workspace_id, workflow_id, validation_run_id)
      ) STRICT;

      CREATE TABLE export_records (
        workspace_id TEXT NOT NULL,
        export_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        validation_run_id TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        manifest_digest TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, export_id),
        FOREIGN KEY (workspace_id, workflow_id, validation_run_id)
          REFERENCES validation_runs(workspace_id, workflow_id, validation_run_id)
      ) STRICT;

      CREATE TRIGGER document_segments_no_update
      BEFORE UPDATE ON document_segments
      BEGIN SELECT RAISE(ABORT, 'document segment is immutable'); END;
      CREATE TRIGGER document_segments_no_delete
      BEFORE DELETE ON document_segments
      BEGIN SELECT RAISE(ABORT, 'document segment is immutable'); END;
      CREATE TRIGGER source_segment_versions_no_update
      BEFORE UPDATE ON source_segment_versions
      BEGIN SELECT RAISE(ABORT, 'source segment version is immutable'); END;
      CREATE TRIGGER source_segment_versions_no_delete
      BEFORE DELETE ON source_segment_versions
      BEGIN SELECT RAISE(ABORT, 'source segment version is immutable'); END;
      CREATE TRIGGER translation_candidates_no_update
      BEFORE UPDATE ON translation_candidates
      BEGIN SELECT RAISE(ABORT, 'translation candidate is immutable'); END;
      CREATE TRIGGER translation_candidates_no_delete
      BEFORE DELETE ON translation_candidates
      BEGIN SELECT RAISE(ABORT, 'translation candidate is immutable'); END;
      CREATE TRIGGER working_copy_revisions_no_update
      BEFORE UPDATE ON working_copy_revisions
      BEGIN SELECT RAISE(ABORT, 'working copy revision is immutable'); END;
      CREATE TRIGGER working_copy_revisions_no_delete
      BEFORE DELETE ON working_copy_revisions
      BEGIN SELECT RAISE(ABORT, 'working copy revision is immutable'); END;
      CREATE TRIGGER validation_runs_no_update
      BEFORE UPDATE ON validation_runs
      BEGIN SELECT RAISE(ABORT, 'validation run is immutable'); END;
      CREATE TRIGGER validation_runs_no_delete
      BEFORE DELETE ON validation_runs
      BEGIN SELECT RAISE(ABORT, 'validation run is immutable'); END;
      CREATE TRIGGER validation_findings_no_update
      BEFORE UPDATE ON validation_findings
      BEGIN SELECT RAISE(ABORT, 'validation finding is immutable'); END;
      CREATE TRIGGER validation_findings_no_delete
      BEFORE DELETE ON validation_findings
      BEGIN SELECT RAISE(ABORT, 'validation finding is immutable'); END;
      CREATE TRIGGER review_events_no_update
      BEFORE UPDATE ON review_events
      BEGIN SELECT RAISE(ABORT, 'review event is append-only'); END;
      CREATE TRIGGER review_events_no_delete
      BEFORE DELETE ON review_events
      BEGIN SELECT RAISE(ABORT, 'review event is append-only'); END;
      CREATE TRIGGER export_records_no_update
      BEFORE UPDATE ON export_records
      BEGIN SELECT RAISE(ABORT, 'export record is immutable'); END;
      CREATE TRIGGER export_records_no_delete
      BEFORE DELETE ON export_records
      BEGIN SELECT RAISE(ABORT, 'export record is immutable'); END;

      DROP TRIGGER segments_no_update;
      DROP TRIGGER segments_no_delete;
      DROP TRIGGER working_translations_state_guard;
      DROP TABLE canonical_import_origins;
      ALTER TABLE canonical_import_origins_v6 RENAME TO canonical_import_origins;
      DROP TABLE segments;
      DROP TABLE working_translations;
      DROP TABLE migration_6_guard;
    `,
  }),
  Object.freeze({
    version: 7,
    name: "safe-document-imports",
    sql: `
      CREATE TABLE document_imports (
        workspace_id TEXT NOT NULL,
        import_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        format TEXT NOT NULL CHECK(format IN ('markdown', 'html', 'text')),
        raw_object_id TEXT NOT NULL,
        raw_digest TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        normalized_digest TEXT NOT NULL,
        projection_json TEXT NOT NULL CHECK(json_valid(projection_json)),
        projection_digest TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        sanitizer_version TEXT NOT NULL,
        requires_confirmation INTEGER NOT NULL CHECK(requires_confirmation IN (0, 1)),
        imported_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, import_id),
        UNIQUE (workspace_id, source_revision_id),
        FOREIGN KEY (workspace_id, document_id, source_revision_id)
          REFERENCES source_revisions(workspace_id, document_id, source_revision_id),
        FOREIGN KEY (workspace_id, raw_object_id)
          REFERENCES committed_objects(workspace_id, object_id)
      ) STRICT;

      CREATE TABLE import_diagnostics (
        workspace_id TEXT NOT NULL,
        import_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence >= 0),
        code TEXT NOT NULL,
        path_json TEXT NOT NULL CHECK(json_valid(path_json)),
        detail TEXT NOT NULL,
        PRIMARY KEY (workspace_id, import_id, sequence),
        FOREIGN KEY (workspace_id, import_id)
          REFERENCES document_imports(workspace_id, import_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE import_confirmations (
        workspace_id TEXT NOT NULL,
        import_id TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, import_id),
        FOREIGN KEY (workspace_id, import_id)
          REFERENCES document_imports(workspace_id, import_id)
      ) STRICT;

      CREATE TRIGGER document_imports_no_update
      BEFORE UPDATE ON document_imports
      BEGIN SELECT RAISE(ABORT, 'document import is immutable'); END;
      CREATE TRIGGER document_imports_no_delete
      BEFORE DELETE ON document_imports
      BEGIN SELECT RAISE(ABORT, 'document import is immutable'); END;
      CREATE TRIGGER import_diagnostics_no_update
      BEFORE UPDATE ON import_diagnostics
      BEGIN SELECT RAISE(ABORT, 'import diagnostic is immutable'); END;
      CREATE TRIGGER import_diagnostics_no_delete
      BEFORE DELETE ON import_diagnostics
      BEGIN SELECT RAISE(ABORT, 'import diagnostic is immutable'); END;
      CREATE TRIGGER import_confirmations_no_update
      BEFORE UPDATE ON import_confirmations
      BEGIN SELECT RAISE(ABORT, 'import confirmation is immutable'); END;
      CREATE TRIGGER import_confirmations_no_delete
      BEFORE DELETE ON import_confirmations
      BEGIN SELECT RAISE(ABORT, 'import confirmation is immutable'); END;
    `,
  }),
  Object.freeze({
    version: 8,
    name: "reimport-alignment-and-stale",
    foreignKeysOff: true,
    sql: `
      CREATE TABLE source_revisions_v8 (
        workspace_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        original_digest TEXT NOT NULL,
        normalized_digest TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, source_revision_id),
        UNIQUE (workspace_id, document_id, source_revision_id),
        FOREIGN KEY (workspace_id, document_id)
          REFERENCES documents(workspace_id, document_id) ON DELETE CASCADE
      ) STRICT;

      INSERT INTO source_revisions_v8 SELECT * FROM source_revisions;
      DROP TABLE source_revisions;
      ALTER TABLE source_revisions_v8 RENAME TO source_revisions;

      CREATE TRIGGER source_revisions_no_update
      BEFORE UPDATE ON source_revisions
      BEGIN SELECT RAISE(ABORT, 'source revision is immutable'); END;
      CREATE TRIGGER source_revisions_no_delete
      BEFORE DELETE ON source_revisions
      BEGIN SELECT RAISE(ABORT, 'source revision is immutable'); END;

      CREATE TABLE reimport_operations (
        workspace_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        base_revision_id TEXT NOT NULL,
        new_revision_id TEXT NOT NULL,
        import_id TEXT NOT NULL,
        format TEXT NOT NULL CHECK(format IN ('markdown', 'html', 'text')),
        raw_object_id TEXT NOT NULL,
        raw_digest TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        normalized_digest TEXT NOT NULL,
        projection_json TEXT NOT NULL CHECK(json_valid(projection_json)),
        projection_digest TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        sanitizer_version TEXT NOT NULL,
        diagnostics_json TEXT NOT NULL CHECK(json_valid(diagnostics_json)),
        status TEXT NOT NULL CHECK(status IN ('pending', 'finalized', 'canceled')),
        version INTEGER NOT NULL CHECK(version >= 0),
        created_at TEXT NOT NULL,
        finalized_at TEXT,
        PRIMARY KEY (workspace_id, operation_id),
        UNIQUE (workspace_id, operation_id, document_id),
        UNIQUE (workspace_id, new_revision_id),
        UNIQUE (workspace_id, import_id),
        FOREIGN KEY (workspace_id, document_id, base_revision_id)
          REFERENCES source_revisions(workspace_id, document_id, source_revision_id),
        FOREIGN KEY (workspace_id, raw_object_id)
          REFERENCES committed_objects(workspace_id, object_id)
      ) STRICT;

      CREATE UNIQUE INDEX one_pending_reimport_per_document
        ON reimport_operations(workspace_id, document_id)
        WHERE status = 'pending';

      CREATE TABLE reimport_segment_candidates (
        workspace_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        new_segment_id TEXT NOT NULL,
        suggested_segment_id TEXT,
        alignment_status TEXT NOT NULL CHECK(alignment_status IN ('unchanged', 'changed', 'moved', 'inserted', 'ambiguous')),
        score REAL,
        kind TEXT NOT NULL,
        structural_path TEXT NOT NULL,
        source_text TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        translatable INTEGER NOT NULL CHECK(translatable IN (0, 1)),
        protected_json TEXT NOT NULL CHECK(json_valid(protected_json)),
        evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
        PRIMARY KEY (workspace_id, operation_id, ordinal),
        UNIQUE (workspace_id, operation_id, new_segment_id),
        FOREIGN KEY (workspace_id, operation_id, document_id)
          REFERENCES reimport_operations(workspace_id, operation_id, document_id),
        FOREIGN KEY (workspace_id, document_id, suggested_segment_id)
          REFERENCES document_segments(workspace_id, document_id, segment_id)
      ) STRICT;

      CREATE TABLE reimport_alignment_confirmations (
        workspace_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        confirmed_segment_id TEXT,
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, operation_id, ordinal),
        UNIQUE (workspace_id, operation_id, confirmed_segment_id),
        FOREIGN KEY (workspace_id, operation_id, ordinal)
          REFERENCES reimport_segment_candidates(workspace_id, operation_id, ordinal),
        FOREIGN KEY (workspace_id, document_id, confirmed_segment_id)
          REFERENCES document_segments(workspace_id, document_id, segment_id)
      ) STRICT;

      CREATE TABLE reimport_semantic_confirmations (
        workspace_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, operation_id, ordinal),
        FOREIGN KEY (workspace_id, operation_id, ordinal)
          REFERENCES reimport_segment_candidates(workspace_id, operation_id, ordinal),
        FOREIGN KEY (workspace_id, operation_id, document_id)
          REFERENCES reimport_operations(workspace_id, operation_id, document_id)
      ) STRICT;

      CREATE TABLE source_revision_impacts (
        workspace_id TEXT NOT NULL,
        impact_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        from_revision_id TEXT NOT NULL,
        to_revision_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        change_kind TEXT NOT NULL CHECK(change_kind IN ('changed', 'moved', 'inserted', 'deleted', 'parser-changed')),
        stale_required INTEGER NOT NULL CHECK(stale_required IN (0, 1)),
        details_json TEXT NOT NULL CHECK(json_valid(details_json)),
        PRIMARY KEY (workspace_id, impact_id),
        FOREIGN KEY (workspace_id, document_id, from_revision_id)
          REFERENCES source_revisions(workspace_id, document_id, source_revision_id),
        FOREIGN KEY (workspace_id, document_id, to_revision_id)
          REFERENCES source_revisions(workspace_id, document_id, source_revision_id)
      ) STRICT;

      CREATE TRIGGER reimport_operations_fixed_fields
      BEFORE UPDATE OF document_id, base_revision_id, new_revision_id, import_id, format,
                       raw_object_id, raw_digest, normalized_text, normalized_digest,
                       projection_json, projection_digest, parser_version,
                       sanitizer_version, diagnostics_json, created_at
      ON reimport_operations
      BEGIN SELECT RAISE(ABORT, 'reimport operation facts are immutable'); END;

      CREATE TRIGGER reimport_operations_status_guard
      BEFORE UPDATE OF status ON reimport_operations
      WHEN (OLD.status || '->' || NEW.status) NOT IN ('pending->finalized', 'pending->canceled')
      BEGIN SELECT RAISE(ABORT, 'invalid reimport operation transition'); END;

      CREATE TRIGGER reimport_segment_candidates_no_update
      BEFORE UPDATE ON reimport_segment_candidates
      BEGIN SELECT RAISE(ABORT, 'reimport candidate is immutable'); END;
      CREATE TRIGGER reimport_segment_candidates_no_delete
      BEFORE DELETE ON reimport_segment_candidates
      BEGIN SELECT RAISE(ABORT, 'reimport candidate is immutable'); END;
      CREATE TRIGGER reimport_alignment_confirmations_no_update
      BEFORE UPDATE ON reimport_alignment_confirmations
      BEGIN SELECT RAISE(ABORT, 'alignment confirmation is immutable'); END;
      CREATE TRIGGER reimport_alignment_confirmations_no_delete
      BEFORE DELETE ON reimport_alignment_confirmations
      BEGIN SELECT RAISE(ABORT, 'alignment confirmation is immutable'); END;
      CREATE TRIGGER reimport_semantic_confirmations_no_update
      BEFORE UPDATE ON reimport_semantic_confirmations
      BEGIN SELECT RAISE(ABORT, 'semantic confirmation is immutable'); END;
      CREATE TRIGGER reimport_semantic_confirmations_no_delete
      BEFORE DELETE ON reimport_semantic_confirmations
      BEGIN SELECT RAISE(ABORT, 'semantic confirmation is immutable'); END;
      CREATE TRIGGER source_revision_impacts_no_update
      BEFORE UPDATE ON source_revision_impacts
      BEGIN SELECT RAISE(ABORT, 'source revision impact is immutable'); END;
      CREATE TRIGGER source_revision_impacts_no_delete
      BEFORE DELETE ON source_revision_impacts
      BEGIN SELECT RAISE(ABORT, 'source revision impact is immutable'); END;

      DROP TRIGGER translation_workflows_state_guard;
      CREATE TRIGGER translation_workflows_state_guard
      BEFORE UPDATE OF state ON translation_workflows
      WHEN (OLD.state || '->' || NEW.state) NOT IN (
        'imported->extraction-pending', 'imported->source-confirmed', 'imported->stale', 'imported->rejected',
        'extraction-pending->source-confirmed', 'extraction-pending->stale', 'extraction-pending->rejected',
        'source-confirmed->queued', 'source-confirmed->stale', 'source-confirmed->rejected',
        'queued->generating', 'queued->stale', 'queued->rejected',
        'generating->draft-machine', 'generating->candidate-invalid', 'generating->candidate-valid', 'generating->stale', 'generating->rejected',
        'draft-machine->candidate-invalid', 'draft-machine->candidate-valid', 'draft-machine->stale', 'draft-machine->rejected',
        'candidate-invalid->queued', 'candidate-invalid->stale', 'candidate-invalid->rejected',
        'candidate-valid->editing', 'candidate-valid->stale', 'candidate-valid->rejected',
        'editing->human-reviewed', 'editing->stale', 'editing->rejected',
        'human-reviewed->approved-for-export', 'human-reviewed->stale', 'human-reviewed->rejected',
        'approved-for-export->exported', 'approved-for-export->stale',
        'exported->stale',
        'stale->queued', 'stale->human-reviewed', 'stale->rejected',
        'rejected->queued'
      )
      BEGIN SELECT RAISE(ABORT, 'invalid translation workflow state transition'); END;
    `,
  }),
  Object.freeze({
    version: 9,
    name: "editing-validation-review-guards",
    sql: `
      CREATE TABLE candidate_creation_events (
        workspace_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'fixture')),
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, candidate_id),
        FOREIGN KEY (workspace_id, workflow_id, segment_id, candidate_id)
          REFERENCES translation_candidates(workspace_id, workflow_id, segment_id, candidate_id)
      ) STRICT;

      CREATE TRIGGER candidate_creation_events_no_update
      BEFORE UPDATE ON candidate_creation_events
      BEGIN SELECT RAISE(ABORT, 'candidate creation event is immutable'); END;
      CREATE TRIGGER candidate_creation_events_no_delete
      BEFORE DELETE ON candidate_creation_events
      BEGIN SELECT RAISE(ABORT, 'candidate creation event is immutable'); END;

      CREATE TRIGGER working_copy_heads_update_guard
      BEFORE UPDATE ON working_copy_heads
      WHEN NEW.version <> OLD.version + 1 OR NEW.head_revision_id = OLD.head_revision_id
      BEGIN SELECT RAISE(ABORT, 'invalid working copy head update'); END;
      CREATE TRIGGER working_copy_heads_no_delete
      BEFORE DELETE ON working_copy_heads
      BEGIN SELECT RAISE(ABORT, 'working copy head is immutable'); END;

      CREATE UNIQUE INDEX one_warning_confirmation
        ON review_events(workspace_id, workflow_id, validation_run_id, json_extract(details_json, '$.findingId'))
        WHERE action = 'warning-confirmed';
    `,
  }),
  Object.freeze({
    version: 10,
    name: "deterministic-export-artifacts",
    sql: `
      CREATE TABLE export_artifact_metadata (
        workspace_id TEXT NOT NULL,
        export_id TEXT NOT NULL,
        format TEXT NOT NULL CHECK(format IN ('canonical', 'markdown', 'html', 'text')),
        filename TEXT NOT NULL,
        PRIMARY KEY (workspace_id, export_id),
        UNIQUE (workspace_id, export_id, format),
        FOREIGN KEY (workspace_id, export_id)
          REFERENCES export_records(workspace_id, export_id)
      ) STRICT;

      CREATE UNIQUE INDEX one_deterministic_export
        ON export_records(workspace_id, workflow_id, validation_run_id, content_digest, manifest_digest);

      CREATE TRIGGER export_artifact_metadata_no_update
      BEFORE UPDATE ON export_artifact_metadata
      BEGIN SELECT RAISE(ABORT, 'export metadata is immutable'); END;
      CREATE TRIGGER export_artifact_metadata_no_delete
      BEFORE DELETE ON export_artifact_metadata
      BEGIN SELECT RAISE(ABORT, 'export metadata is immutable'); END;
    `,
  }),
  Object.freeze({
    version: 11,
    name: "provider-task-attempt-foundation",
    sql: `
      CREATE TABLE translation_tasks (
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        target_language TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL CHECK(length(request_digest) = 71 AND substr(request_digest, 1, 7) = 'sha256:'),
        policy_version TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'paused', 'completed', 'failed', 'canceled')),
        version INTEGER NOT NULL CHECK(version >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, task_id),
        UNIQUE (workspace_id, workflow_id, idempotency_key),
        UNIQUE (workspace_id, task_id, workflow_id, document_id, source_revision_id, target_language),
        FOREIGN KEY (workspace_id, workflow_id, document_id, source_revision_id, target_language)
          REFERENCES translation_workflows(workspace_id, workflow_id, document_id, source_revision_id, target_language)
      ) STRICT;

      CREATE TABLE translation_attempts (
        workspace_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        target_language TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        provider_id TEXT NOT NULL CHECK(length(provider_id) BETWEEN 1 AND 127),
        model_id TEXT NOT NULL CHECK(length(model_id) BETWEEN 1 AND 255),
        prompt_version TEXT NOT NULL,
        context_digest TEXT NOT NULL CHECK(length(context_digest) = 71 AND substr(context_digest, 1, 7) = 'sha256:'),
        request_digest TEXT NOT NULL CHECK(length(request_digest) = 71 AND substr(request_digest, 1, 7) = 'sha256:'),
        state TEXT NOT NULL CHECK(state IN ('queued', 'leased', 'running', 'retry-wait', 'completed', 'failed', 'canceled', 'unknown-outcome')),
        version INTEGER NOT NULL CHECK(version >= 0),
        created_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (workspace_id, attempt_id),
        UNIQUE (workspace_id, task_id, segment_id, attempt_id),
        UNIQUE (workspace_id, attempt_id, task_id),
        UNIQUE (workspace_id, attempt_id, task_id, provider_id, model_id),
        FOREIGN KEY (workspace_id, task_id, workflow_id, document_id, source_revision_id, target_language)
          REFERENCES translation_tasks(workspace_id, task_id, workflow_id, document_id, source_revision_id, target_language),
        FOREIGN KEY (workspace_id, source_revision_id, segment_id)
          REFERENCES source_segment_versions(workspace_id, source_revision_id, segment_id)
      ) STRICT;

      CREATE TABLE attempt_events (
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        details_json TEXT NOT NULL CHECK(json_valid(details_json)),
        occurred_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, event_id),
        FOREIGN KEY (workspace_id, attempt_id, task_id)
          REFERENCES translation_attempts(workspace_id, attempt_id, task_id)
      ) STRICT;

      CREATE TABLE capability_grants (
        workspace_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        token_digest TEXT NOT NULL CHECK(length(token_digest) = 71 AND substr(token_digest, 1, 7) = 'sha256:'),
        scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json) AND json_type(scopes_json) = 'array'),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, grant_id),
        UNIQUE (workspace_id, token_digest),
        FOREIGN KEY (workspace_id, attempt_id, task_id)
          REFERENCES translation_attempts(workspace_id, attempt_id, task_id)
      ) STRICT;

      CREATE TABLE usage_cost_records (
        workspace_id TEXT NOT NULL,
        usage_record_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        provider_response_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
        cached_input_tokens INTEGER NOT NULL CHECK(cached_input_tokens >= 0 AND cached_input_tokens <= input_tokens),
        total_tokens INTEGER NOT NULL CHECK(total_tokens = input_tokens + output_tokens),
        currency TEXT,
        amount_micros INTEGER CHECK(amount_micros >= 0),
        pricing_version TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, usage_record_id),
        UNIQUE (workspace_id, attempt_id, provider_response_id),
        CHECK((currency IS NULL AND amount_micros IS NULL) OR (currency IS NOT NULL AND amount_micros IS NOT NULL)),
        FOREIGN KEY (workspace_id, attempt_id, task_id, provider_id, model_id)
          REFERENCES translation_attempts(workspace_id, attempt_id, task_id, provider_id, model_id)
      ) STRICT;

      CREATE TRIGGER attempt_events_no_update
      BEFORE UPDATE ON attempt_events
      BEGIN SELECT RAISE(ABORT, 'attempt event is append-only'); END;
      CREATE TRIGGER attempt_events_no_delete
      BEFORE DELETE ON attempt_events
      BEGIN SELECT RAISE(ABORT, 'attempt event is append-only'); END;
      CREATE TRIGGER capability_grants_no_update
      BEFORE UPDATE ON capability_grants
      BEGIN SELECT RAISE(ABORT, 'capability grant is immutable'); END;
      CREATE TRIGGER capability_grants_no_delete
      BEFORE DELETE ON capability_grants
      BEGIN SELECT RAISE(ABORT, 'capability grant is immutable'); END;
      CREATE TRIGGER usage_cost_records_no_update
      BEFORE UPDATE ON usage_cost_records
      BEGIN SELECT RAISE(ABORT, 'usage cost record is immutable'); END;
      CREATE TRIGGER usage_cost_records_no_delete
      BEFORE DELETE ON usage_cost_records
      BEGIN SELECT RAISE(ABORT, 'usage cost record is immutable'); END;
    `,
  }),
  Object.freeze({
    version: 12,
    name: "translation-task-runtime-state",
    sql: `
      CREATE TABLE task_execution_policies (
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 10),
        batch_size INTEGER NOT NULL CHECK(batch_size BETWEEN 1 AND 100),
        offline_reason TEXT,
        PRIMARY KEY (workspace_id, task_id),
        FOREIGN KEY (workspace_id, task_id)
          REFERENCES translation_tasks(workspace_id, task_id)
      ) STRICT;

      CREATE TABLE attempt_runtime_states (
        workspace_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL CHECK(attempt_number BETWEEN 1 AND 10),
        lease_holder TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        next_retry_at TEXT,
        error_category TEXT,
        provider_call_state TEXT NOT NULL CHECK(provider_call_state IN ('not-started', 'started', 'completed', 'unknown')),
        outcome_digest TEXT,
        PRIMARY KEY (workspace_id, attempt_id),
        UNIQUE (workspace_id, task_id, segment_id, attempt_number),
        CHECK((lease_holder IS NULL AND lease_expires_at IS NULL) OR (lease_holder IS NOT NULL AND lease_expires_at IS NOT NULL)),
        FOREIGN KEY (workspace_id, attempt_id, task_id)
          REFERENCES translation_attempts(workspace_id, attempt_id, task_id),
        FOREIGN KEY (workspace_id, task_id, segment_id, attempt_id)
          REFERENCES translation_attempts(workspace_id, task_id, segment_id, attempt_id)
      ) STRICT;

      CREATE TABLE task_command_results (
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        result_json TEXT NOT NULL CHECK(json_valid(result_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, task_id, operation, idempotency_key),
        FOREIGN KEY (workspace_id, task_id)
          REFERENCES translation_tasks(workspace_id, task_id)
      ) STRICT;

      CREATE INDEX runnable_attempts
        ON translation_attempts(workspace_id, state, created_at);
      CREATE INDEX retry_schedule
        ON attempt_runtime_states(workspace_id, next_retry_at)
        WHERE next_retry_at IS NOT NULL;

      CREATE TRIGGER task_command_results_no_update
      BEFORE UPDATE ON task_command_results
      BEGIN SELECT RAISE(ABORT, 'task command result is immutable'); END;
      CREATE TRIGGER task_command_results_no_delete
      BEFORE DELETE ON task_command_results
      BEGIN SELECT RAISE(ABORT, 'task command result is immutable'); END;
    `,
  }),
  Object.freeze({
    version: 13,
    name: "machine-candidate-provenance",
    foreignKeysOff: true,
    sql: `
      CREATE TABLE translation_candidates_v13 (
        workspace_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        target_language TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('user', 'local-fixture', 'machine')),
        text TEXT NOT NULL,
        text_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, candidate_id),
        UNIQUE (workspace_id, workflow_id, segment_id, candidate_id),
        FOREIGN KEY (workspace_id, workflow_id, document_id, source_revision_id, target_language)
          REFERENCES translation_workflows(workspace_id, workflow_id, document_id, source_revision_id, target_language),
        FOREIGN KEY (workspace_id, source_revision_id, segment_id)
          REFERENCES source_segment_versions(workspace_id, source_revision_id, segment_id)
      ) STRICT;

      INSERT INTO translation_candidates_v13 SELECT * FROM translation_candidates;

      CREATE TABLE candidate_creation_events_v13 (
        workspace_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'system', 'fixture')),
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, candidate_id),
        FOREIGN KEY (workspace_id, workflow_id, segment_id, candidate_id)
          REFERENCES translation_candidates_v13(workspace_id, workflow_id, segment_id, candidate_id)
      ) STRICT;

      INSERT INTO candidate_creation_events_v13 SELECT * FROM candidate_creation_events;

      DROP TRIGGER candidate_creation_events_no_update;
      DROP TRIGGER candidate_creation_events_no_delete;
      DROP TRIGGER translation_candidates_no_update;
      DROP TRIGGER translation_candidates_no_delete;
      DROP TABLE candidate_creation_events;
      DROP TABLE translation_candidates;
      ALTER TABLE translation_candidates_v13 RENAME TO translation_candidates;
      ALTER TABLE candidate_creation_events_v13 RENAME TO candidate_creation_events;

      CREATE UNIQUE INDEX machine_candidate_attempt_identity
        ON translation_attempts(
          workspace_id, attempt_id, task_id, workflow_id, source_revision_id,
          target_language, segment_id, provider_id, model_id, prompt_version,
          context_digest, request_digest
        );
      CREATE UNIQUE INDEX machine_candidate_attempt_outcome
        ON attempt_runtime_states(workspace_id, attempt_id, outcome_digest);

      CREATE TABLE machine_candidate_provenance (
        workspace_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        target_language TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        context_digest TEXT NOT NULL CHECK(length(context_digest) = 71 AND substr(context_digest, 1, 7) = 'sha256:'),
        request_digest TEXT NOT NULL CHECK(length(request_digest) = 71 AND substr(request_digest, 1, 7) = 'sha256:'),
        output_digest TEXT NOT NULL CHECK(length(output_digest) = 71 AND substr(output_digest, 1, 7) = 'sha256:'),
        generation_mode TEXT NOT NULL CHECK(generation_mode IN ('default', 'user-requested')),
        user_command_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, candidate_id),
        UNIQUE (workspace_id, attempt_id),
        CHECK((generation_mode = 'default' AND user_command_id IS NULL) OR
              (generation_mode = 'user-requested' AND length(user_command_id) > 0)),
        FOREIGN KEY (workspace_id, workflow_id, segment_id, candidate_id)
          REFERENCES translation_candidates(workspace_id, workflow_id, segment_id, candidate_id),
        FOREIGN KEY (
          workspace_id, attempt_id, task_id, workflow_id, source_revision_id,
          target_language, segment_id, provider_id, model_id, prompt_version,
          context_digest, request_digest
        ) REFERENCES translation_attempts(
          workspace_id, attempt_id, task_id, workflow_id, source_revision_id,
          target_language, segment_id, provider_id, model_id, prompt_version,
          context_digest, request_digest
        ),
        FOREIGN KEY (workspace_id, attempt_id, output_digest)
          REFERENCES attempt_runtime_states(workspace_id, attempt_id, outcome_digest)
      ) STRICT;

      CREATE UNIQUE INDEX one_default_machine_candidate
        ON machine_candidate_provenance(workspace_id, task_id, segment_id)
        WHERE generation_mode = 'default';

      CREATE TRIGGER translation_candidates_no_update
      BEFORE UPDATE ON translation_candidates
      BEGIN SELECT RAISE(ABORT, 'translation candidate is immutable'); END;
      CREATE TRIGGER translation_candidates_no_delete
      BEFORE DELETE ON translation_candidates
      BEGIN SELECT RAISE(ABORT, 'translation candidate is immutable'); END;
      CREATE TRIGGER candidate_creation_events_no_update
      BEFORE UPDATE ON candidate_creation_events
      BEGIN SELECT RAISE(ABORT, 'candidate creation event is immutable'); END;
      CREATE TRIGGER candidate_creation_events_no_delete
      BEFORE DELETE ON candidate_creation_events
      BEGIN SELECT RAISE(ABORT, 'candidate creation event is immutable'); END;
      CREATE TRIGGER machine_candidate_provenance_no_update
      BEFORE UPDATE ON machine_candidate_provenance
      BEGIN SELECT RAISE(ABORT, 'machine candidate provenance is immutable'); END;
      CREATE TRIGGER machine_candidate_provenance_no_delete
      BEFORE DELETE ON machine_candidate_provenance
      BEGIN SELECT RAISE(ABORT, 'machine candidate provenance is immutable'); END;
    `,
  }),
  Object.freeze({
    version: 14,
    name: "pricing-budget-offline-controls",
    sql: `
      CREATE TABLE pricing_snapshots (
        workspace_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        pricing_version TEXT NOT NULL,
        currency TEXT NOT NULL CHECK(length(currency) = 3 AND currency = upper(currency)),
        input_micros_per_million INTEGER NOT NULL CHECK(input_micros_per_million >= 0),
        output_micros_per_million INTEGER NOT NULL CHECK(output_micros_per_million >= 0),
        cached_input_micros_per_million INTEGER NOT NULL CHECK(cached_input_micros_per_million >= 0),
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, provider_id, model_id, pricing_version),
        UNIQUE (workspace_id, provider_id, model_id, pricing_version, currency),
        FOREIGN KEY (workspace_id) REFERENCES workspace_meta(workspace_id)
      ) STRICT;

      CREATE TABLE budget_policy_snapshots (
        workspace_id TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        currency TEXT NOT NULL CHECK(length(currency) = 3 AND currency = upper(currency)),
        soft_limit_micros INTEGER NOT NULL CHECK(soft_limit_micros >= 0),
        hard_limit_micros INTEGER NOT NULL CHECK(hard_limit_micros >= soft_limit_micros),
        unknown_price_action TEXT NOT NULL CHECK(unknown_price_action IN ('pause', 'block')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, policy_version),
        FOREIGN KEY (workspace_id) REFERENCES workspace_meta(workspace_id)
      ) STRICT;

      CREATE TABLE task_budget_assignments (
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        task_soft_limit_micros INTEGER,
        task_hard_limit_micros INTEGER,
        state TEXT NOT NULL CHECK(state IN ('active', 'soft-paused', 'hard-blocked', 'unknown-paused')),
        version INTEGER NOT NULL CHECK(version >= 0),
        PRIMARY KEY (workspace_id, task_id),
        CHECK((task_soft_limit_micros IS NULL AND task_hard_limit_micros IS NULL) OR
              (task_soft_limit_micros >= 0 AND task_hard_limit_micros >= task_soft_limit_micros)),
        FOREIGN KEY (workspace_id, task_id) REFERENCES translation_tasks(workspace_id, task_id),
        FOREIGN KEY (workspace_id, policy_version) REFERENCES budget_policy_snapshots(workspace_id, policy_version)
      ) STRICT;

      CREATE TABLE budget_soft_approvals (
        workspace_id TEXT NOT NULL,
        approval_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, approval_id),
        FOREIGN KEY (workspace_id, task_id) REFERENCES translation_tasks(workspace_id, task_id)
      ) STRICT;

      CREATE TABLE budget_reservations (
        workspace_id TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        pricing_version TEXT NOT NULL,
        currency TEXT NOT NULL,
        estimated_input_tokens INTEGER NOT NULL CHECK(estimated_input_tokens >= 0),
        estimated_output_tokens INTEGER NOT NULL CHECK(estimated_output_tokens >= 0),
        estimated_cached_input_tokens INTEGER NOT NULL CHECK(estimated_cached_input_tokens >= 0 AND estimated_cached_input_tokens <= estimated_input_tokens),
        estimated_amount_micros INTEGER NOT NULL CHECK(estimated_amount_micros >= 0),
        actual_amount_micros INTEGER CHECK(actual_amount_micros >= 0),
        usage_record_id TEXT,
        approval_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('reserved', 'consumed', 'released', 'unknown')),
        version INTEGER NOT NULL CHECK(version >= 0),
        created_at TEXT NOT NULL,
        finalized_at TEXT,
        PRIMARY KEY (workspace_id, reservation_id),
        UNIQUE (workspace_id, attempt_id),
        UNIQUE (workspace_id, approval_id),
        CHECK(
          (state = 'reserved' AND actual_amount_micros IS NULL AND usage_record_id IS NULL AND finalized_at IS NULL) OR
          (state = 'consumed' AND actual_amount_micros IS NOT NULL AND usage_record_id IS NOT NULL AND finalized_at IS NOT NULL) OR
          (state = 'unknown' AND actual_amount_micros IS NULL AND finalized_at IS NOT NULL) OR
          (state = 'released' AND actual_amount_micros IS NULL AND finalized_at IS NOT NULL)
        ),
        FOREIGN KEY (workspace_id, attempt_id, task_id, provider_id, model_id)
          REFERENCES translation_attempts(workspace_id, attempt_id, task_id, provider_id, model_id),
        FOREIGN KEY (workspace_id, provider_id, model_id, pricing_version, currency)
          REFERENCES pricing_snapshots(workspace_id, provider_id, model_id, pricing_version, currency),
        FOREIGN KEY (workspace_id, task_id)
          REFERENCES task_budget_assignments(workspace_id, task_id),
        FOREIGN KEY (workspace_id, usage_record_id)
          REFERENCES usage_cost_records(workspace_id, usage_record_id),
        FOREIGN KEY (workspace_id, approval_id)
          REFERENCES budget_soft_approvals(workspace_id, approval_id)
      ) STRICT;

      CREATE TRIGGER pricing_snapshots_no_update BEFORE UPDATE ON pricing_snapshots
      BEGIN SELECT RAISE(ABORT, 'pricing snapshot is immutable'); END;
      CREATE TRIGGER pricing_snapshots_no_delete BEFORE DELETE ON pricing_snapshots
      BEGIN SELECT RAISE(ABORT, 'pricing snapshot is immutable'); END;
      CREATE TRIGGER budget_policy_snapshots_no_update BEFORE UPDATE ON budget_policy_snapshots
      BEGIN SELECT RAISE(ABORT, 'budget policy snapshot is immutable'); END;
      CREATE TRIGGER budget_policy_snapshots_no_delete BEFORE DELETE ON budget_policy_snapshots
      BEGIN SELECT RAISE(ABORT, 'budget policy snapshot is immutable'); END;
      CREATE TRIGGER budget_soft_approvals_no_update BEFORE UPDATE ON budget_soft_approvals
      BEGIN SELECT RAISE(ABORT, 'budget approval is immutable'); END;
      CREATE TRIGGER budget_soft_approvals_no_delete BEFORE DELETE ON budget_soft_approvals
      BEGIN SELECT RAISE(ABORT, 'budget approval is immutable'); END;
      CREATE TRIGGER task_budget_assignments_state_guard
      BEFORE UPDATE ON task_budget_assignments
      WHEN NEW.policy_version <> OLD.policy_version
        OR NEW.task_soft_limit_micros IS NOT OLD.task_soft_limit_micros
        OR NEW.task_hard_limit_micros IS NOT OLD.task_hard_limit_micros
        OR NEW.version <> OLD.version + 1 OR (OLD.state || '->' || NEW.state) NOT IN (
        'active->soft-paused', 'active->hard-blocked', 'active->unknown-paused',
        'soft-paused->active', 'unknown-paused->active'
      )
      BEGIN SELECT RAISE(ABORT, 'invalid task budget transition'); END;
      CREATE TRIGGER task_budget_assignments_no_delete BEFORE DELETE ON task_budget_assignments
      BEGIN SELECT RAISE(ABORT, 'task budget assignment is immutable'); END;
      CREATE TRIGGER budget_reservations_state_guard
      BEFORE UPDATE ON budget_reservations
      WHEN NEW.task_id <> OLD.task_id OR NEW.attempt_id <> OLD.attempt_id
        OR NEW.provider_id <> OLD.provider_id OR NEW.model_id <> OLD.model_id
        OR NEW.pricing_version <> OLD.pricing_version OR NEW.currency <> OLD.currency
        OR NEW.estimated_input_tokens <> OLD.estimated_input_tokens
        OR NEW.estimated_output_tokens <> OLD.estimated_output_tokens
        OR NEW.estimated_cached_input_tokens <> OLD.estimated_cached_input_tokens
        OR NEW.estimated_amount_micros <> OLD.estimated_amount_micros
        OR NEW.approval_id IS NOT OLD.approval_id OR NEW.created_at <> OLD.created_at
        OR NEW.version <> OLD.version + 1 OR (OLD.state || '->' || NEW.state) NOT IN (
        'reserved->consumed', 'reserved->released', 'reserved->unknown', 'unknown->consumed', 'unknown->released'
      )
      BEGIN SELECT RAISE(ABORT, 'invalid budget reservation transition'); END;
      CREATE TRIGGER budget_reservations_no_delete BEFORE DELETE ON budget_reservations
      BEGIN SELECT RAISE(ABORT, 'budget reservation is immutable'); END;
    `,
  }),
  Object.freeze({
    version: 15,
    name: "knowledge-fact-version-foundation",
    sql: `
      CREATE TABLE knowledge_facts (
        workspace_id TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('term', 'style', 'knowledge')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, fact_id),
        UNIQUE (workspace_id, fact_id, kind),
        FOREIGN KEY (workspace_id) REFERENCES workspace_meta(workspace_id)
      ) STRICT;

      CREATE TABLE knowledge_fact_revisions (
        workspace_id TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('term', 'style', 'knowledge')),
        version INTEGER NOT NULL CHECK(version >= 1),
        language TEXT NOT NULL,
        scope_json TEXT NOT NULL CHECK(json_valid(scope_json) AND json_type(scope_json) = 'object'),
        content_json TEXT NOT NULL CHECK(json_valid(content_json) AND json_type(content_json) = 'object'),
        content_digest TEXT NOT NULL CHECK(length(content_digest) = 71 AND substr(content_digest, 1, 7) = 'sha256:'),
        object_id TEXT NOT NULL,
        source_path TEXT NOT NULL CHECK(
          source_path = (CASE kind
            WHEN 'term' THEN 'dictionary/'
            WHEN 'style' THEN 'style/'
            WHEN 'knowledge' THEN 'knowledge/'
          END) || fact_id || '/' || revision_id || '.json'
        ),
        actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'system', 'fixture')),
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, revision_id),
        UNIQUE (workspace_id, fact_id, version),
        UNIQUE (workspace_id, fact_id, revision_id),
        UNIQUE (workspace_id, fact_id, kind, revision_id),
        FOREIGN KEY (workspace_id, fact_id, kind)
          REFERENCES knowledge_facts(workspace_id, fact_id, kind),
        FOREIGN KEY (workspace_id, object_id)
          REFERENCES committed_objects(workspace_id, object_id)
      ) STRICT;

      CREATE TABLE knowledge_fact_heads (
        workspace_id TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('term', 'style', 'knowledge')),
        revision_id TEXT NOT NULL,
        revision_version INTEGER NOT NULL CHECK(revision_version >= 1),
        version INTEGER NOT NULL CHECK(version >= 0),
        state TEXT NOT NULL CHECK(state IN ('active', 'inactive')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, fact_id),
        FOREIGN KEY (workspace_id, fact_id, kind)
          REFERENCES knowledge_facts(workspace_id, fact_id, kind),
        FOREIGN KEY (workspace_id, fact_id, kind, revision_id)
          REFERENCES knowledge_fact_revisions(workspace_id, fact_id, kind, revision_id)
      ) STRICT;

      CREATE TABLE knowledge_fact_scope_documents (
        workspace_id TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        PRIMARY KEY (workspace_id, revision_id, document_id),
        FOREIGN KEY (workspace_id, fact_id, revision_id)
          REFERENCES knowledge_fact_revisions(workspace_id, fact_id, revision_id),
        FOREIGN KEY (workspace_id, document_id)
          REFERENCES documents(workspace_id, document_id)
      ) STRICT;

      CREATE TABLE knowledge_fact_events (
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('created', 'revised', 'activated', 'deactivated')),
        actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'system', 'fixture')),
        actor_id TEXT NOT NULL,
        details_json TEXT NOT NULL CHECK(json_valid(details_json) AND json_type(details_json) = 'object'),
        occurred_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, event_id),
        FOREIGN KEY (workspace_id, fact_id, revision_id)
          REFERENCES knowledge_fact_revisions(workspace_id, fact_id, revision_id)
      ) STRICT;

      CREATE TRIGGER knowledge_facts_no_update BEFORE UPDATE ON knowledge_facts
      BEGIN SELECT RAISE(ABORT, 'knowledge fact is immutable'); END;
      CREATE TRIGGER knowledge_facts_no_delete BEFORE DELETE ON knowledge_facts
      BEGIN SELECT RAISE(ABORT, 'knowledge fact is immutable'); END;
      CREATE TRIGGER knowledge_fact_revisions_no_update BEFORE UPDATE ON knowledge_fact_revisions
      BEGIN SELECT RAISE(ABORT, 'knowledge fact revision is immutable'); END;
      CREATE TRIGGER knowledge_fact_revisions_no_delete BEFORE DELETE ON knowledge_fact_revisions
      BEGIN SELECT RAISE(ABORT, 'knowledge fact revision is immutable'); END;
      CREATE TRIGGER knowledge_fact_scope_documents_no_update BEFORE UPDATE ON knowledge_fact_scope_documents
      BEGIN SELECT RAISE(ABORT, 'knowledge fact scope is immutable'); END;
      CREATE TRIGGER knowledge_fact_scope_documents_no_delete BEFORE DELETE ON knowledge_fact_scope_documents
      BEGIN SELECT RAISE(ABORT, 'knowledge fact scope is immutable'); END;
      CREATE TRIGGER knowledge_fact_events_no_update BEFORE UPDATE ON knowledge_fact_events
      BEGIN SELECT RAISE(ABORT, 'knowledge fact event is append-only'); END;
      CREATE TRIGGER knowledge_fact_events_no_delete BEFORE DELETE ON knowledge_fact_events
      BEGIN SELECT RAISE(ABORT, 'knowledge fact event is append-only'); END;
      CREATE TRIGGER knowledge_fact_heads_no_delete BEFORE DELETE ON knowledge_fact_heads
      BEGIN SELECT RAISE(ABORT, 'knowledge fact head is immutable'); END;
      CREATE TRIGGER knowledge_fact_heads_update_guard BEFORE UPDATE ON knowledge_fact_heads
      WHEN NEW.fact_id <> OLD.fact_id OR NEW.kind <> OLD.kind
        OR NEW.version <> OLD.version + 1
        OR NOT (
          (NEW.revision_id <> OLD.revision_id AND NEW.revision_version = OLD.revision_version + 1 AND NEW.state = OLD.state) OR
          (NEW.revision_id = OLD.revision_id AND NEW.revision_version = OLD.revision_version
            AND (OLD.state || '->' || NEW.state) IN ('active->inactive', 'inactive->active'))
        )
      BEGIN SELECT RAISE(ABORT, 'invalid knowledge fact head update'); END;
    `,
  }),
  Object.freeze({
    version: 16,
    name: "retrieval-evidence-snapshots",
    sql: `
      CREATE UNIQUE INDEX knowledge_revision_evidence_identity
        ON knowledge_fact_revisions(workspace_id, fact_id, kind, revision_id, language, content_digest);

      CREATE UNIQUE INDEX evidence_attempt_identity
        ON translation_attempts(
          workspace_id, attempt_id, task_id, workflow_id, source_revision_id, target_language, segment_id
        );

      CREATE TABLE knowledge_evidence_snapshots (
        workspace_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        target_language TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        query_json TEXT NOT NULL CHECK(
          json_valid(query_json) AND json_type(query_json) = 'object'
          AND json_extract(query_json, '$.language') = target_language
          AND length(json_extract(query_json, '$.text')) BETWEEN 1 AND 512
        ),
        filters_json TEXT NOT NULL CHECK(
          json_valid(filters_json) AND json_type(filters_json) = 'object'
          AND json_array_length(json_extract(filters_json, '$.documentIds')) = 1
          AND json_extract(filters_json, '$.documentIds[0]') = document_id
          AND json_extract(filters_json, '$.topK') BETWEEN 1 AND 20
        ),
        retriever_version TEXT NOT NULL,
        query_policy_version TEXT NOT NULL,
        index_digest TEXT NOT NULL CHECK(length(index_digest) = 71 AND substr(index_digest, 1, 7) = 'sha256:'),
        evidence_digest TEXT NOT NULL CHECK(length(evidence_digest) = 71 AND substr(evidence_digest, 1, 7) = 'sha256:'),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, evidence_id),
        UNIQUE (workspace_id, evidence_digest),
        UNIQUE (workspace_id, evidence_id, evidence_digest),
        UNIQUE (workspace_id, evidence_id, workflow_id, source_revision_id, target_language, segment_id),
        FOREIGN KEY (workspace_id, workflow_id, document_id, source_revision_id, target_language)
          REFERENCES translation_workflows(workspace_id, workflow_id, document_id, source_revision_id, target_language),
        FOREIGN KEY (workspace_id, source_revision_id, segment_id)
          REFERENCES source_segment_versions(workspace_id, source_revision_id, segment_id)
      ) STRICT;

      CREATE TABLE knowledge_evidence_hits (
        workspace_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        rank INTEGER NOT NULL CHECK(rank BETWEEN 1 AND 50),
        fact_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('term', 'style', 'knowledge')),
        language TEXT NOT NULL,
        matched_field TEXT NOT NULL CHECK(matched_field IN ('title', 'body', 'terms', 'tags')),
        snippet TEXT NOT NULL CHECK(length(snippet) BETWEEN 1 AND 4096),
        snippet_digest TEXT NOT NULL CHECK(length(snippet_digest) = 71 AND substr(snippet_digest, 1, 7) = 'sha256:'),
        content_digest TEXT NOT NULL CHECK(length(content_digest) = 71 AND substr(content_digest, 1, 7) = 'sha256:'),
        score REAL NOT NULL,
        PRIMARY KEY (workspace_id, evidence_id, rank),
        UNIQUE (workspace_id, evidence_id, fact_id, revision_id),
        FOREIGN KEY (workspace_id, evidence_id) REFERENCES knowledge_evidence_snapshots(workspace_id, evidence_id),
        FOREIGN KEY (workspace_id, fact_id, kind, revision_id, language, content_digest)
          REFERENCES knowledge_fact_revisions(workspace_id, fact_id, kind, revision_id, language, content_digest)
      ) STRICT;

      CREATE TABLE attempt_evidence_bindings (
        workspace_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        target_language TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        evidence_digest TEXT NOT NULL,
        PRIMARY KEY (workspace_id, attempt_id, evidence_id),
        FOREIGN KEY (workspace_id, attempt_id, task_id, workflow_id, source_revision_id, target_language, segment_id)
          REFERENCES translation_attempts(workspace_id, attempt_id, task_id, workflow_id, source_revision_id, target_language, segment_id),
        FOREIGN KEY (workspace_id, evidence_id, workflow_id, source_revision_id, target_language, segment_id)
          REFERENCES knowledge_evidence_snapshots(workspace_id, evidence_id, workflow_id, source_revision_id, target_language, segment_id),
        FOREIGN KEY (workspace_id, evidence_id, evidence_digest)
          REFERENCES knowledge_evidence_snapshots(workspace_id, evidence_id, evidence_digest)
      ) STRICT;

      CREATE TRIGGER knowledge_evidence_snapshots_no_update BEFORE UPDATE ON knowledge_evidence_snapshots
      BEGIN SELECT RAISE(ABORT, 'knowledge evidence snapshot is immutable'); END;
      CREATE TRIGGER knowledge_evidence_snapshots_no_delete BEFORE DELETE ON knowledge_evidence_snapshots
      BEGIN SELECT RAISE(ABORT, 'knowledge evidence snapshot is immutable'); END;
      CREATE TRIGGER knowledge_evidence_hits_no_update BEFORE UPDATE ON knowledge_evidence_hits
      BEGIN SELECT RAISE(ABORT, 'knowledge evidence hit is immutable'); END;
      CREATE TRIGGER knowledge_evidence_hits_no_delete BEFORE DELETE ON knowledge_evidence_hits
      BEGIN SELECT RAISE(ABORT, 'knowledge evidence hit is immutable'); END;
      CREATE TRIGGER attempt_evidence_bindings_no_update BEFORE UPDATE ON attempt_evidence_bindings
      BEGIN SELECT RAISE(ABORT, 'attempt evidence binding is immutable'); END;
      CREATE TRIGGER attempt_evidence_bindings_no_delete BEFORE DELETE ON attempt_evidence_bindings
      BEGIN SELECT RAISE(ABORT, 'attempt evidence binding is immutable'); END;
    `,
  }),
  Object.freeze({
    version: 17,
    name: "deterministic-quality-runs",
    sql: `
      CREATE TABLE quality_rule_snapshots (
        workspace_id TEXT NOT NULL,
        rule_snapshot_id TEXT NOT NULL CHECK(length(rule_snapshot_id) = 71 AND substr(rule_snapshot_id, 1, 7) = 'sha256:'),
        registry_version TEXT NOT NULL,
        rules_digest TEXT NOT NULL CHECK(length(rules_digest) = 71 AND substr(rules_digest, 1, 7) = 'sha256:'),
        fact_heads_digest TEXT NOT NULL CHECK(length(fact_heads_digest) = 71 AND substr(fact_heads_digest, 1, 7) = 'sha256:'),
        parser_version TEXT NOT NULL,
        validator_version TEXT NOT NULL,
        rules_json TEXT NOT NULL CHECK(json_valid(rules_json) AND json_type(rules_json) = 'array'),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, rule_snapshot_id),
        FOREIGN KEY (workspace_id) REFERENCES workspace_meta(workspace_id)
      ) STRICT;

      CREATE TABLE quality_runs (
        workspace_id TEXT NOT NULL,
        quality_run_id TEXT NOT NULL CHECK(length(quality_run_id) = 71 AND substr(quality_run_id, 1, 7) = 'sha256:'),
        workflow_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        target_language TEXT NOT NULL,
        segment_id TEXT,
        subject_type TEXT NOT NULL CHECK(subject_type IN ('candidate', 'working-copy')),
        subject_id TEXT NOT NULL,
        subject_digest TEXT NOT NULL CHECK(length(subject_digest) = 71 AND substr(subject_digest, 1, 7) = 'sha256:'),
        rule_snapshot_id TEXT NOT NULL,
        validation_run_id TEXT,
        evidence_digest TEXT NOT NULL CHECK(length(evidence_digest) = 71 AND substr(evidence_digest, 1, 7) = 'sha256:'),
        summary_digest TEXT NOT NULL CHECK(length(summary_digest) = 71 AND substr(summary_digest, 1, 7) = 'sha256:'),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, quality_run_id),
        UNIQUE (workspace_id, workflow_id, quality_run_id),
        CHECK((subject_type = 'candidate' AND segment_id IS NOT NULL AND validation_run_id IS NULL) OR
              (subject_type = 'working-copy' AND segment_id IS NULL AND validation_run_id IS NOT NULL)),
        FOREIGN KEY (workspace_id, workflow_id, document_id, source_revision_id, target_language)
          REFERENCES translation_workflows(workspace_id, workflow_id, document_id, source_revision_id, target_language),
        FOREIGN KEY (workspace_id, rule_snapshot_id)
          REFERENCES quality_rule_snapshots(workspace_id, rule_snapshot_id),
        FOREIGN KEY (workspace_id, workflow_id, validation_run_id)
          REFERENCES validation_runs(workspace_id, workflow_id, validation_run_id)
      ) STRICT;

      CREATE TABLE quality_run_candidates (
        workspace_id TEXT NOT NULL,
        quality_run_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        PRIMARY KEY (workspace_id, quality_run_id),
        FOREIGN KEY (workspace_id, workflow_id, quality_run_id)
          REFERENCES quality_runs(workspace_id, workflow_id, quality_run_id),
        FOREIGN KEY (workspace_id, workflow_id, segment_id, candidate_id)
          REFERENCES translation_candidates(workspace_id, workflow_id, segment_id, candidate_id)
      ) STRICT;

      CREATE TABLE quality_run_working_revisions (
        workspace_id TEXT NOT NULL,
        quality_run_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        working_copy_revision_id TEXT NOT NULL,
        PRIMARY KEY (workspace_id, quality_run_id, segment_id),
        FOREIGN KEY (workspace_id, workflow_id, quality_run_id)
          REFERENCES quality_runs(workspace_id, workflow_id, quality_run_id),
        FOREIGN KEY (workspace_id, workflow_id, segment_id, working_copy_revision_id)
          REFERENCES working_copy_revisions(workspace_id, workflow_id, segment_id, working_copy_revision_id)
      ) STRICT;

      CREATE TABLE quality_findings (
        workspace_id TEXT NOT NULL,
        quality_run_id TEXT NOT NULL,
        finding_id TEXT NOT NULL CHECK(length(finding_id) = 71 AND substr(finding_id, 1, 7) = 'sha256:'),
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        severity TEXT NOT NULL CHECK(severity IN ('error', 'warning', 'info')),
        rule_id TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        segment_id TEXT,
        subject_revision_id TEXT NOT NULL,
        fact_id TEXT,
        fact_revision_id TEXT,
        evidence_digest TEXT NOT NULL CHECK(length(evidence_digest) = 71 AND substr(evidence_digest, 1, 7) = 'sha256:'),
        parameters_json TEXT NOT NULL CHECK(json_valid(parameters_json) AND json_type(parameters_json) = 'object'),
        PRIMARY KEY (workspace_id, quality_run_id, finding_id),
        UNIQUE (workspace_id, quality_run_id, ordinal),
        CHECK((fact_id IS NULL AND fact_revision_id IS NULL) OR (fact_id IS NOT NULL AND fact_revision_id IS NOT NULL)),
        FOREIGN KEY (workspace_id, quality_run_id) REFERENCES quality_runs(workspace_id, quality_run_id),
        FOREIGN KEY (workspace_id, fact_id, fact_revision_id)
          REFERENCES knowledge_fact_revisions(workspace_id, fact_id, revision_id)
      ) STRICT;

      CREATE TABLE quality_warning_confirmations (
        workspace_id TEXT NOT NULL,
        confirmation_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        quality_run_id TEXT NOT NULL,
        finding_id TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, confirmation_id),
        UNIQUE (workspace_id, quality_run_id, finding_id),
        FOREIGN KEY (workspace_id, workflow_id, quality_run_id)
          REFERENCES quality_runs(workspace_id, workflow_id, quality_run_id),
        FOREIGN KEY (workspace_id, quality_run_id, finding_id)
          REFERENCES quality_findings(workspace_id, quality_run_id, finding_id)
      ) STRICT;

      CREATE TABLE candidate_comparisons (
        workspace_id TEXT NOT NULL,
        comparison_id TEXT NOT NULL CHECK(length(comparison_id) = 71 AND substr(comparison_id, 1, 7) = 'sha256:'),
        workflow_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        rule_snapshot_id TEXT NOT NULL,
        comparison_digest TEXT NOT NULL CHECK(length(comparison_digest) = 71 AND substr(comparison_digest, 1, 7) = 'sha256:'),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, comparison_id),
        UNIQUE (workspace_id, workflow_id, segment_id, comparison_id),
        FOREIGN KEY (workspace_id, rule_snapshot_id)
          REFERENCES quality_rule_snapshots(workspace_id, rule_snapshot_id)
      ) STRICT;

      CREATE TABLE candidate_comparison_members (
        workspace_id TEXT NOT NULL,
        comparison_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        quality_run_id TEXT NOT NULL,
        rank INTEGER NOT NULL CHECK(rank >= 1),
        error_count INTEGER NOT NULL CHECK(error_count >= 0),
        warning_count INTEGER NOT NULL CHECK(warning_count >= 0),
        info_count INTEGER NOT NULL CHECK(info_count >= 0),
        evidence_coverage INTEGER NOT NULL CHECK(evidence_coverage BETWEEN 0 AND 100),
        PRIMARY KEY (workspace_id, comparison_id, candidate_id),
        UNIQUE (workspace_id, comparison_id, rank),
        FOREIGN KEY (workspace_id, workflow_id, segment_id, comparison_id)
          REFERENCES candidate_comparisons(workspace_id, workflow_id, segment_id, comparison_id),
        FOREIGN KEY (workspace_id, workflow_id, segment_id, candidate_id)
          REFERENCES translation_candidates(workspace_id, workflow_id, segment_id, candidate_id),
        FOREIGN KEY (workspace_id, quality_run_id)
          REFERENCES quality_runs(workspace_id, quality_run_id)
      ) STRICT;

      CREATE TRIGGER quality_rule_snapshots_no_update BEFORE UPDATE ON quality_rule_snapshots
      BEGIN SELECT RAISE(ABORT, 'quality rule snapshot is immutable'); END;
      CREATE TRIGGER quality_rule_snapshots_no_delete BEFORE DELETE ON quality_rule_snapshots
      BEGIN SELECT RAISE(ABORT, 'quality rule snapshot is immutable'); END;
      CREATE TRIGGER quality_runs_no_update BEFORE UPDATE ON quality_runs
      BEGIN SELECT RAISE(ABORT, 'quality run is immutable'); END;
      CREATE TRIGGER quality_runs_no_delete BEFORE DELETE ON quality_runs
      BEGIN SELECT RAISE(ABORT, 'quality run is immutable'); END;
      CREATE TRIGGER quality_findings_no_update BEFORE UPDATE ON quality_findings
      BEGIN SELECT RAISE(ABORT, 'quality finding is immutable'); END;
      CREATE TRIGGER quality_findings_no_delete BEFORE DELETE ON quality_findings
      BEGIN SELECT RAISE(ABORT, 'quality finding is immutable'); END;
      CREATE TRIGGER quality_run_candidates_no_update BEFORE UPDATE ON quality_run_candidates
      BEGIN SELECT RAISE(ABORT, 'quality candidate binding is immutable'); END;
      CREATE TRIGGER quality_run_candidates_no_delete BEFORE DELETE ON quality_run_candidates
      BEGIN SELECT RAISE(ABORT, 'quality candidate binding is immutable'); END;
      CREATE TRIGGER quality_run_working_revisions_no_update BEFORE UPDATE ON quality_run_working_revisions
      BEGIN SELECT RAISE(ABORT, 'quality working binding is immutable'); END;
      CREATE TRIGGER quality_run_working_revisions_no_delete BEFORE DELETE ON quality_run_working_revisions
      BEGIN SELECT RAISE(ABORT, 'quality working binding is immutable'); END;
      CREATE TRIGGER quality_warning_confirmations_no_update BEFORE UPDATE ON quality_warning_confirmations
      BEGIN SELECT RAISE(ABORT, 'quality warning confirmation is immutable'); END;
      CREATE TRIGGER quality_warning_confirmations_no_delete BEFORE DELETE ON quality_warning_confirmations
      BEGIN SELECT RAISE(ABORT, 'quality warning confirmation is immutable'); END;
      CREATE TRIGGER candidate_comparisons_no_update BEFORE UPDATE ON candidate_comparisons
      BEGIN SELECT RAISE(ABORT, 'candidate comparison is immutable'); END;
      CREATE TRIGGER candidate_comparisons_no_delete BEFORE DELETE ON candidate_comparisons
      BEGIN SELECT RAISE(ABORT, 'candidate comparison is immutable'); END;
      CREATE TRIGGER candidate_comparison_members_no_update BEFORE UPDATE ON candidate_comparison_members
      BEGIN SELECT RAISE(ABORT, 'candidate comparison member is immutable'); END;
      CREATE TRIGGER candidate_comparison_members_no_delete BEFORE DELETE ON candidate_comparison_members
      BEGIN SELECT RAISE(ABORT, 'candidate comparison member is immutable'); END;
    `,
  }),
  Object.freeze({
    version: 18,
    name: "internet-investigation-and-knowledge-proposals",
    sql: `
      CREATE TABLE internet_investigations (
        workspace_id TEXT NOT NULL,
        investigation_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        target_language TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        query_text TEXT NOT NULL CHECK(length(query_text) BETWEEN 1 AND 512),
        country TEXT NOT NULL CHECK(length(country) = 2),
        search_language TEXT NOT NULL CHECK(length(search_language) BETWEEN 2 AND 16),
        query_digest TEXT NOT NULL CHECK(length(query_digest) = 71 AND substr(query_digest, 1, 7) = 'sha256:'),
        max_results INTEGER NOT NULL CHECK(max_results BETWEEN 1 AND 20),
        search_policy_version TEXT NOT NULL,
        fetch_policy_version TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, investigation_id),
        UNIQUE (workspace_id, investigation_id, task_id, workflow_id, segment_id),
        UNIQUE (workspace_id, investigation_id, workflow_id, segment_id),
        FOREIGN KEY (workspace_id, task_id, workflow_id, document_id, source_revision_id, target_language)
          REFERENCES translation_tasks(workspace_id, task_id, workflow_id, document_id, source_revision_id, target_language),
        FOREIGN KEY (workspace_id, source_revision_id, segment_id)
          REFERENCES source_segment_versions(workspace_id, source_revision_id, segment_id)
      ) STRICT;

      CREATE TABLE internet_search_runs (
        workspace_id TEXT NOT NULL,
        search_run_id TEXT NOT NULL CHECK(length(search_run_id) = 71 AND substr(search_run_id, 1, 7) = 'sha256:'),
        investigation_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL CHECK(adapter_id = 'brave-search'),
        adapter_version TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        query_digest TEXT NOT NULL,
        result_set_digest TEXT NOT NULL CHECK(length(result_set_digest) = 71 AND substr(result_set_digest, 1, 7) = 'sha256:'),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, search_run_id),
        UNIQUE (workspace_id, investigation_id, search_run_id),
        FOREIGN KEY (workspace_id, investigation_id, task_id, workflow_id, segment_id)
          REFERENCES internet_investigations(workspace_id, investigation_id, task_id, workflow_id, segment_id)
      ) STRICT;

      CREATE TABLE internet_investigation_events (
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL CHECK(length(event_id) = 71 AND substr(event_id, 1, 7) = 'sha256:'),
        investigation_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN (
          'created', 'search-succeeded', 'search-failed', 'fetch-succeeded', 'fetch-failed',
          'proposal-created', 'proposal-revised', 'proposal-approved', 'proposal-rejected'
        )),
        category TEXT,
        details_json TEXT NOT NULL CHECK(json_valid(details_json) AND json_type(details_json) = 'object'),
        occurred_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, event_id),
        UNIQUE (workspace_id, investigation_id, event_id),
        FOREIGN KEY (workspace_id, investigation_id)
          REFERENCES internet_investigations(workspace_id, investigation_id)
      ) STRICT;

      CREATE TABLE internet_search_results (
        workspace_id TEXT NOT NULL,
        search_run_id TEXT NOT NULL,
        investigation_id TEXT NOT NULL,
        result_id TEXT NOT NULL CHECK(length(result_id) = 71 AND substr(result_id, 1, 7) = 'sha256:'),
        rank INTEGER NOT NULL CHECK(rank BETWEEN 1 AND 20),
        url TEXT NOT NULL CHECK(length(url) BETWEEN 1 AND 4096),
        url_digest TEXT NOT NULL CHECK(length(url_digest) = 71 AND substr(url_digest, 1, 7) = 'sha256:'),
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 2048),
        description TEXT NOT NULL CHECK(length(description) <= 8192),
        result_digest TEXT NOT NULL CHECK(length(result_digest) = 71 AND substr(result_digest, 1, 7) = 'sha256:'),
        handle_expires_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, result_id),
        UNIQUE (workspace_id, search_run_id, rank),
        UNIQUE (workspace_id, investigation_id, result_id),
        FOREIGN KEY (workspace_id, investigation_id, search_run_id)
          REFERENCES internet_search_runs(workspace_id, investigation_id, search_run_id)
      ) STRICT;

      CREATE TABLE internet_fetch_snapshots (
        workspace_id TEXT NOT NULL,
        fetch_snapshot_id TEXT NOT NULL CHECK(length(fetch_snapshot_id) = 71 AND substr(fetch_snapshot_id, 1, 7) = 'sha256:'),
        investigation_id TEXT NOT NULL,
        search_run_id TEXT NOT NULL,
        result_id TEXT NOT NULL,
        requested_url TEXT NOT NULL,
        final_url TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        fetch_policy_version TEXT NOT NULL,
        status_code INTEGER NOT NULL CHECK(status_code BETWEEN 200 AND 299),
        mime_type TEXT NOT NULL CHECK(mime_type IN ('text/html', 'text/plain')),
        title TEXT NOT NULL CHECK(length(title) <= 2048),
        extracted_text TEXT NOT NULL CHECK(length(extracted_text) BETWEEN 1 AND 262144),
        content_digest TEXT NOT NULL CHECK(length(content_digest) = 71 AND substr(content_digest, 1, 7) = 'sha256:'),
        snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest) = 71 AND substr(snapshot_digest, 1, 7) = 'sha256:'),
        truncated INTEGER NOT NULL CHECK(truncated IN (0, 1)),
        diagnostics_json TEXT NOT NULL CHECK(json_valid(diagnostics_json) AND json_type(diagnostics_json) = 'array'),
        redirects_json TEXT NOT NULL CHECK(json_valid(redirects_json) AND json_type(redirects_json) = 'array'),
        untrusted INTEGER NOT NULL CHECK(untrusted = 1),
        PRIMARY KEY (workspace_id, fetch_snapshot_id),
        UNIQUE (workspace_id, investigation_id, fetch_snapshot_id),
        FOREIGN KEY (workspace_id, investigation_id, search_run_id)
          REFERENCES internet_search_runs(workspace_id, investigation_id, search_run_id),
        FOREIGN KEY (workspace_id, investigation_id, result_id)
          REFERENCES internet_search_results(workspace_id, investigation_id, result_id)
      ) STRICT;

      CREATE TABLE knowledge_proposals (
        workspace_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        investigation_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, proposal_id),
        UNIQUE (workspace_id, investigation_id, proposal_id),
        FOREIGN KEY (workspace_id, investigation_id, workflow_id, segment_id)
          REFERENCES internet_investigations(workspace_id, investigation_id, workflow_id, segment_id)
      ) STRICT;

      CREATE TABLE knowledge_proposal_revisions (
        workspace_id TEXT NOT NULL,
        proposal_revision_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        investigation_id TEXT NOT NULL,
        fetch_snapshot_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version >= 1),
        operation TEXT NOT NULL CHECK(operation IN ('create', 'revise')),
        fact_id TEXT NOT NULL,
        base_fact_revision_id TEXT,
        proposed_source_json TEXT NOT NULL CHECK(json_valid(proposed_source_json) AND json_type(proposed_source_json) = 'object'),
        proposed_source_digest TEXT NOT NULL CHECK(length(proposed_source_digest) = 71 AND substr(proposed_source_digest, 1, 7) = 'sha256:'),
        proposal_policy_version TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'system', 'fixture')),
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, proposal_revision_id),
        UNIQUE (workspace_id, proposal_id, version),
        UNIQUE (workspace_id, proposal_id, proposal_revision_id),
        CHECK((operation = 'create' AND base_fact_revision_id IS NULL) OR
              (operation = 'revise' AND base_fact_revision_id IS NOT NULL)),
        FOREIGN KEY (workspace_id, investigation_id, proposal_id)
          REFERENCES knowledge_proposals(workspace_id, investigation_id, proposal_id),
        FOREIGN KEY (workspace_id, investigation_id, fetch_snapshot_id)
          REFERENCES internet_fetch_snapshots(workspace_id, investigation_id, fetch_snapshot_id),
        FOREIGN KEY (workspace_id, fact_id, base_fact_revision_id)
          REFERENCES knowledge_fact_revisions(workspace_id, fact_id, revision_id)
      ) STRICT;

      CREATE TABLE knowledge_proposal_heads (
        workspace_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        proposal_revision_id TEXT NOT NULL,
        revision_version INTEGER NOT NULL CHECK(revision_version >= 1),
        version INTEGER NOT NULL CHECK(version >= 0),
        state TEXT NOT NULL CHECK(state IN ('draft', 'approved', 'rejected')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, proposal_id),
        FOREIGN KEY (workspace_id, proposal_id, proposal_revision_id)
          REFERENCES knowledge_proposal_revisions(workspace_id, proposal_id, proposal_revision_id)
      ) STRICT;

      CREATE TABLE knowledge_proposal_decisions (
        workspace_id TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        proposal_revision_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('approved', 'rejected')),
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, decision_id),
        UNIQUE (workspace_id, proposal_id),
        FOREIGN KEY (workspace_id, proposal_id, proposal_revision_id)
          REFERENCES knowledge_proposal_revisions(workspace_id, proposal_id, proposal_revision_id)
      ) STRICT;

      CREATE TRIGGER internet_investigations_no_update BEFORE UPDATE ON internet_investigations
      BEGIN SELECT RAISE(ABORT, 'internet investigation is immutable'); END;
      CREATE TRIGGER internet_investigations_no_delete BEFORE DELETE ON internet_investigations
      BEGIN SELECT RAISE(ABORT, 'internet investigation is immutable'); END;
      CREATE TRIGGER internet_search_runs_no_update BEFORE UPDATE ON internet_search_runs
      BEGIN SELECT RAISE(ABORT, 'internet search run is immutable'); END;
      CREATE TRIGGER internet_search_runs_no_delete BEFORE DELETE ON internet_search_runs
      BEGIN SELECT RAISE(ABORT, 'internet search run is immutable'); END;
      CREATE TRIGGER internet_investigation_events_no_update BEFORE UPDATE ON internet_investigation_events
      BEGIN SELECT RAISE(ABORT, 'internet investigation event is append-only'); END;
      CREATE TRIGGER internet_investigation_events_no_delete BEFORE DELETE ON internet_investigation_events
      BEGIN SELECT RAISE(ABORT, 'internet investigation event is append-only'); END;
      CREATE TRIGGER internet_search_results_no_update BEFORE UPDATE ON internet_search_results
      BEGIN SELECT RAISE(ABORT, 'internet search result is immutable'); END;
      CREATE TRIGGER internet_search_results_no_delete BEFORE DELETE ON internet_search_results
      BEGIN SELECT RAISE(ABORT, 'internet search result is immutable'); END;
      CREATE TRIGGER internet_fetch_snapshots_no_update BEFORE UPDATE ON internet_fetch_snapshots
      BEGIN SELECT RAISE(ABORT, 'internet fetch snapshot is immutable'); END;
      CREATE TRIGGER internet_fetch_snapshots_no_delete BEFORE DELETE ON internet_fetch_snapshots
      BEGIN SELECT RAISE(ABORT, 'internet fetch snapshot is immutable'); END;
      CREATE TRIGGER knowledge_proposals_no_update BEFORE UPDATE ON knowledge_proposals
      BEGIN SELECT RAISE(ABORT, 'knowledge proposal is immutable'); END;
      CREATE TRIGGER knowledge_proposals_no_delete BEFORE DELETE ON knowledge_proposals
      BEGIN SELECT RAISE(ABORT, 'knowledge proposal is immutable'); END;
      CREATE TRIGGER knowledge_proposal_revisions_no_update BEFORE UPDATE ON knowledge_proposal_revisions
      BEGIN SELECT RAISE(ABORT, 'knowledge proposal revision is immutable'); END;
      CREATE TRIGGER knowledge_proposal_revisions_no_delete BEFORE DELETE ON knowledge_proposal_revisions
      BEGIN SELECT RAISE(ABORT, 'knowledge proposal revision is immutable'); END;
      CREATE TRIGGER knowledge_proposal_heads_no_delete BEFORE DELETE ON knowledge_proposal_heads
      BEGIN SELECT RAISE(ABORT, 'knowledge proposal head is immutable'); END;
      CREATE TRIGGER knowledge_proposal_heads_update_guard BEFORE UPDATE ON knowledge_proposal_heads
      WHEN NEW.version <> OLD.version + 1 OR NOT (
        (OLD.state = 'draft' AND NEW.state = 'draft' AND NEW.proposal_revision_id <> OLD.proposal_revision_id AND NEW.revision_version = OLD.revision_version + 1) OR
        (OLD.state = 'draft' AND NEW.state IN ('approved', 'rejected') AND NEW.proposal_revision_id = OLD.proposal_revision_id AND NEW.revision_version = OLD.revision_version)
      )
      BEGIN SELECT RAISE(ABORT, 'invalid knowledge proposal head update'); END;
      CREATE TRIGGER knowledge_proposal_decisions_no_update BEFORE UPDATE ON knowledge_proposal_decisions
      BEGIN SELECT RAISE(ABORT, 'knowledge proposal decision is immutable'); END;
      CREATE TRIGGER knowledge_proposal_decisions_no_delete BEFORE DELETE ON knowledge_proposal_decisions
      BEGIN SELECT RAISE(ABORT, 'knowledge proposal decision is immutable'); END;
    `,
  }),
  Object.freeze({
    version: 19,
    name: "approved-knowledge-proposal-applications",
    sql: `
      CREATE UNIQUE INDEX knowledge_proposal_decision_scope
        ON knowledge_proposal_decisions(workspace_id, decision_id, proposal_id, proposal_revision_id);

      CREATE TABLE knowledge_proposal_applications (
        workspace_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        proposal_revision_id TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('create', 'revise')),
        fact_id TEXT NOT NULL,
        fact_revision_id TEXT NOT NULL,
        proposed_source_digest TEXT NOT NULL CHECK(length(proposed_source_digest) = 71 AND substr(proposed_source_digest, 1, 7) = 'sha256:'),
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, application_id),
        UNIQUE (workspace_id, proposal_id),
        UNIQUE (workspace_id, proposal_id, proposal_revision_id),
        FOREIGN KEY (workspace_id, proposal_id, proposal_revision_id)
          REFERENCES knowledge_proposal_revisions(workspace_id, proposal_id, proposal_revision_id),
        FOREIGN KEY (workspace_id, decision_id, proposal_id, proposal_revision_id)
          REFERENCES knowledge_proposal_decisions(workspace_id, decision_id, proposal_id, proposal_revision_id),
        FOREIGN KEY (workspace_id, fact_id, fact_revision_id)
          REFERENCES knowledge_fact_revisions(workspace_id, fact_id, revision_id)
      ) STRICT;

      CREATE TRIGGER knowledge_proposal_applications_no_update BEFORE UPDATE ON knowledge_proposal_applications
      BEGIN SELECT RAISE(ABORT, 'knowledge proposal application is immutable'); END;
      CREATE TRIGGER knowledge_proposal_applications_no_delete BEFORE DELETE ON knowledge_proposal_applications
      BEGIN SELECT RAISE(ABORT, 'knowledge proposal application is immutable'); END;
    `,
  }),
  Object.freeze({
    version: 20,
    name: "controlled-multi-round-research-foundation",
    sql: `
      CREATE TABLE research_requests (
        workspace_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        target_language TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, request_id),
        UNIQUE (workspace_id, request_id, task_id, workflow_id, document_id, source_revision_id, target_language),
        FOREIGN KEY (workspace_id, task_id, workflow_id, document_id, source_revision_id, target_language)
          REFERENCES translation_tasks(workspace_id, task_id, workflow_id, document_id, source_revision_id, target_language)
      ) STRICT;

      CREATE TABLE research_request_segments (
        workspace_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        PRIMARY KEY (workspace_id, request_id, segment_id),
        FOREIGN KEY (workspace_id, request_id) REFERENCES research_requests(workspace_id, request_id),
        FOREIGN KEY (workspace_id, source_revision_id, segment_id)
          REFERENCES source_segment_versions(workspace_id, source_revision_id, segment_id)
      ) STRICT;

      CREATE TABLE research_request_revisions (
        workspace_id TEXT NOT NULL,
        request_revision_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        contract_version TEXT NOT NULL CHECK(contract_version = '1.0'),
        request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json) = 'object'),
        request_digest TEXT NOT NULL CHECK(length(request_digest) = 71 AND substr(request_digest, 1, 7) = 'sha256:'),
        actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'system', 'model', 'fixture')),
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, request_revision_id),
        UNIQUE (workspace_id, request_id, revision),
        UNIQUE (workspace_id, request_id, request_revision_id),
        FOREIGN KEY (workspace_id, request_id) REFERENCES research_requests(workspace_id, request_id)
      ) STRICT;

      CREATE TABLE research_request_heads (
        workspace_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_revision_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        version INTEGER NOT NULL CHECK(version >= 0),
        state TEXT NOT NULL CHECK(state IN ('draft', 'pending-user', 'approved', 'rejected', 'canceled')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, request_id),
        FOREIGN KEY (workspace_id, request_id, request_revision_id)
          REFERENCES research_request_revisions(workspace_id, request_id, request_revision_id)
      ) STRICT;

      CREATE TABLE research_request_decisions (
        workspace_id TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_revision_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('approved', 'rejected', 'canceled')),
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, decision_id),
        UNIQUE (workspace_id, request_id),
        UNIQUE (workspace_id, decision_id, request_id, request_revision_id, decision),
        FOREIGN KEY (workspace_id, request_id, request_revision_id)
          REFERENCES research_request_revisions(workspace_id, request_id, request_revision_id)
      ) STRICT;

      CREATE TABLE research_grants (
        workspace_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_revision_id TEXT NOT NULL,
        approval_decision_id TEXT NOT NULL,
        approval_decision TEXT NOT NULL CHECK(approval_decision = 'approved'),
        contract_version TEXT NOT NULL CHECK(contract_version = '1.0'),
        grant_json TEXT NOT NULL CHECK(json_valid(grant_json) AND json_type(grant_json) = 'object'),
        grant_digest TEXT NOT NULL CHECK(length(grant_digest) = 71 AND substr(grant_digest, 1, 7) = 'sha256:'),
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        expires_at TEXT NOT NULL CHECK(expires_at > approved_at),
        PRIMARY KEY (workspace_id, grant_id),
        UNIQUE (workspace_id, request_id, request_revision_id),
        FOREIGN KEY (workspace_id, approval_decision_id, request_id, request_revision_id, approval_decision)
          REFERENCES research_request_decisions(workspace_id, decision_id, request_id, request_revision_id, decision)
      ) STRICT;

      CREATE TABLE research_grant_revocations (
        workspace_id TEXT NOT NULL,
        revocation_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        revoked_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, revocation_id),
        UNIQUE (workspace_id, grant_id),
        FOREIGN KEY (workspace_id, grant_id) REFERENCES research_grants(workspace_id, grant_id)
      ) STRICT;

      CREATE TABLE research_runs (
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 3),
        request_digest TEXT NOT NULL CHECK(length(request_digest) = 71 AND substr(request_digest, 1, 7) = 'sha256:'),
        created_at TEXT NOT NULL,
        deadline_at TEXT NOT NULL CHECK(deadline_at > created_at),
        PRIMARY KEY (workspace_id, run_id),
        UNIQUE (workspace_id, grant_id, attempt),
        UNIQUE (workspace_id, grant_id, run_id),
        FOREIGN KEY (workspace_id, grant_id) REFERENCES research_grants(workspace_id, grant_id)
      ) STRICT;

      CREATE TABLE research_run_events (
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'paused', 'completed', 'failed', 'canceled')),
        reason TEXT,
        details_json TEXT NOT NULL CHECK(json_valid(details_json) AND json_type(details_json) = 'object'),
        occurred_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, event_id),
        UNIQUE (workspace_id, run_id, ordinal),
        FOREIGN KEY (workspace_id, run_id) REFERENCES research_runs(workspace_id, run_id)
      ) STRICT;

      CREATE TABLE research_queries (
        workspace_id TEXT NOT NULL,
        query_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        round INTEGER NOT NULL CHECK(round BETWEEN 1 AND 10),
        capability TEXT NOT NULL CHECK(capability IN ('search', 'fetch', 'extract', 'research-model')),
        provider_id TEXT NOT NULL CHECK(length(provider_id) BETWEEN 1 AND 127),
        query_text TEXT NOT NULL CHECK(length(query_text) BETWEEN 1 AND 2048),
        request_digest TEXT NOT NULL CHECK(length(request_digest) = 71 AND substr(request_digest, 1, 7) = 'sha256:'),
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, query_id),
        UNIQUE (workspace_id, run_id, idempotency_key),
        UNIQUE (workspace_id, run_id, query_id),
        FOREIGN KEY (workspace_id, run_id) REFERENCES research_runs(workspace_id, run_id)
      ) STRICT;

      CREATE TABLE research_budget_ledger (
        workspace_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        query_id TEXT NOT NULL,
        entry_type TEXT NOT NULL CHECK(entry_type IN ('reserved', 'settled', 'released', 'unknown')),
        search_calls INTEGER NOT NULL CHECK(search_calls >= 0),
        content_urls INTEGER NOT NULL CHECK(content_urls >= 0),
        model_tokens INTEGER NOT NULL CHECK(model_tokens >= 0),
        cost_micros_usd INTEGER NOT NULL CHECK(cost_micros_usd >= 0),
        usage_json TEXT NOT NULL CHECK(json_valid(usage_json) AND json_type(usage_json) = 'object'),
        occurred_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, entry_id),
        UNIQUE (workspace_id, query_id, entry_type),
        FOREIGN KEY (workspace_id, grant_id, run_id) REFERENCES research_runs(workspace_id, grant_id, run_id),
        FOREIGN KEY (workspace_id, run_id, query_id) REFERENCES research_queries(workspace_id, run_id, query_id)
      ) STRICT;

      CREATE TABLE provider_content_snapshots (
        workspace_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        query_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        canonical_url TEXT NOT NULL CHECK(length(canonical_url) BETWEEN 1 AND 4096),
        content_text TEXT NOT NULL CHECK(length(content_text) BETWEEN 1 AND 262144),
        content_digest TEXT NOT NULL CHECK(length(content_digest) = 71 AND substr(content_digest, 1, 7) = 'sha256:'),
        snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest) = 71 AND substr(snapshot_digest, 1, 7) = 'sha256:'),
        lineage TEXT NOT NULL CHECK(lineage = 'provider-processed'),
        untrusted INTEGER NOT NULL CHECK(untrusted = 1),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, snapshot_id),
        UNIQUE (workspace_id, run_id, snapshot_id),
        FOREIGN KEY (workspace_id, run_id, query_id) REFERENCES research_queries(workspace_id, run_id, query_id)
      ) STRICT;

      CREATE TABLE research_sources (
        workspace_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        query_id TEXT NOT NULL,
        canonical_url TEXT NOT NULL CHECK(length(canonical_url) BETWEEN 1 AND 4096),
        url_digest TEXT NOT NULL CHECK(length(url_digest) = 71 AND substr(url_digest, 1, 7) = 'sha256:'),
        source_cluster_id TEXT NOT NULL,
        tier TEXT NOT NULL CHECK(tier IN ('S1', 'S2', 'S3', 'S4', 'S5')),
        lineage TEXT NOT NULL CHECK(lineage IN ('direct', 'provider-processed', 'search-snippet')),
        artifact_type TEXT NOT NULL CHECK(artifact_type IN ('search-result', 'fetch-snapshot', 'provider-content-snapshot')),
        artifact_id TEXT NOT NULL,
        artifact_digest TEXT NOT NULL CHECK(length(artifact_digest) = 71 AND substr(artifact_digest, 1, 7) = 'sha256:'),
        retrieved_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, source_id),
        UNIQUE (workspace_id, run_id, source_id),
        CHECK(NOT (lineage = 'provider-processed' AND artifact_type = 'fetch-snapshot')),
        FOREIGN KEY (workspace_id, run_id, query_id) REFERENCES research_queries(workspace_id, run_id, query_id)
      ) STRICT;

      CREATE TABLE research_citations (
        workspace_id TEXT NOT NULL,
        citation_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        quote_text TEXT NOT NULL CHECK(length(quote_text) BETWEEN 1 AND 16384),
        quote_digest TEXT NOT NULL CHECK(length(quote_digest) = 71 AND substr(quote_digest, 1, 7) = 'sha256:'),
        locator_json TEXT NOT NULL CHECK(json_valid(locator_json) AND json_type(locator_json) = 'object'),
        verified INTEGER NOT NULL CHECK(verified IN (0, 1)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, citation_id),
        UNIQUE (workspace_id, run_id, citation_id),
        FOREIGN KEY (workspace_id, run_id, source_id) REFERENCES research_sources(workspace_id, run_id, source_id)
      ) STRICT;

      CREATE TABLE research_claims (
        workspace_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        claim_text TEXT NOT NULL CHECK(length(claim_text) BETWEEN 1 AND 16384),
        claim_digest TEXT NOT NULL CHECK(length(claim_digest) = 71 AND substr(claim_digest, 1, 7) = 'sha256:'),
        support_level TEXT NOT NULL CHECK(support_level IN ('C0', 'C1', 'C2', 'C3', 'CD', 'CI')),
        inference INTEGER NOT NULL CHECK(inference IN (0, 1)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, claim_id),
        UNIQUE (workspace_id, run_id, claim_id),
        CHECK(NOT (support_level IN ('C2', 'C3') AND inference = 1)),
        FOREIGN KEY (workspace_id, run_id) REFERENCES research_runs(workspace_id, run_id)
      ) STRICT;

      CREATE TABLE research_claim_citations (
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        citation_id TEXT NOT NULL,
        PRIMARY KEY (workspace_id, claim_id, citation_id),
        FOREIGN KEY (workspace_id, run_id, claim_id) REFERENCES research_claims(workspace_id, run_id, claim_id),
        FOREIGN KEY (workspace_id, run_id, citation_id) REFERENCES research_citations(workspace_id, run_id, citation_id)
      ) STRICT;

      CREATE TABLE research_reports (
        workspace_id TEXT NOT NULL,
        report_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('supported', 'disputed', 'insufficient', 'partial')),
        stop_reason TEXT NOT NULL,
        report_json TEXT NOT NULL CHECK(json_valid(report_json) AND json_type(report_json) = 'object'),
        report_digest TEXT NOT NULL CHECK(length(report_digest) = 71 AND substr(report_digest, 1, 7) = 'sha256:'),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, report_id),
        UNIQUE (workspace_id, run_id),
        UNIQUE (workspace_id, run_id, report_id),
        FOREIGN KEY (workspace_id, run_id) REFERENCES research_runs(workspace_id, run_id)
      ) STRICT;

      CREATE TABLE research_report_claims (
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        report_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        PRIMARY KEY (workspace_id, report_id, claim_id),
        UNIQUE (workspace_id, report_id, ordinal),
        FOREIGN KEY (workspace_id, run_id, report_id) REFERENCES research_reports(workspace_id, run_id, report_id),
        FOREIGN KEY (workspace_id, run_id, claim_id) REFERENCES research_claims(workspace_id, run_id, claim_id)
      ) STRICT;

      CREATE TABLE knowledge_proposal_research_evidence (
        workspace_id TEXT NOT NULL,
        proposal_revision_id TEXT NOT NULL,
        report_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        citation_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        PRIMARY KEY (workspace_id, proposal_revision_id, claim_id, citation_id),
        UNIQUE (workspace_id, proposal_revision_id, ordinal),
        FOREIGN KEY (workspace_id, proposal_revision_id) REFERENCES knowledge_proposal_revisions(workspace_id, proposal_revision_id),
        FOREIGN KEY (workspace_id, report_id, claim_id) REFERENCES research_report_claims(workspace_id, report_id, claim_id),
        FOREIGN KEY (workspace_id, claim_id, citation_id) REFERENCES research_claim_citations(workspace_id, claim_id, citation_id)
      ) STRICT;

      CREATE TABLE research_cache_inventory_entries (
        workspace_id TEXT NOT NULL,
        inventory_id TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        relative_location TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
        sensitivity TEXT NOT NULL CHECK(sensitivity IN ('public', 'untrusted-public', 'private-derived')),
        backup_relation TEXT NOT NULL CHECK(backup_relation IN ('included', 'excluded', 'manifest-only')),
        rebuildable INTEGER NOT NULL CHECK(rebuildable IN (0, 1)),
        cleanup_recommendation TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, inventory_id),
        UNIQUE (workspace_id, artifact_type, artifact_id),
        FOREIGN KEY (workspace_id) REFERENCES workspace_meta(workspace_id)
      ) STRICT;

      CREATE TRIGGER research_request_heads_no_delete BEFORE DELETE ON research_request_heads
      BEGIN SELECT RAISE(ABORT, 'research request head is append-only by version'); END;
      CREATE TRIGGER research_request_heads_update_guard BEFORE UPDATE ON research_request_heads
      WHEN NEW.version <> OLD.version + 1 OR NOT (
        (OLD.state = 'draft' AND NEW.state = 'draft' AND NEW.request_revision_id <> OLD.request_revision_id AND NEW.revision = OLD.revision + 1) OR
        (OLD.state = 'draft' AND NEW.state = 'pending-user' AND NEW.request_revision_id = OLD.request_revision_id AND NEW.revision = OLD.revision) OR
        (OLD.state = 'pending-user' AND NEW.state = 'draft' AND NEW.request_revision_id <> OLD.request_revision_id AND NEW.revision = OLD.revision + 1) OR
        (OLD.state = 'pending-user' AND NEW.state IN ('approved', 'rejected', 'canceled') AND NEW.request_revision_id = OLD.request_revision_id AND NEW.revision = OLD.revision)
      )
      BEGIN SELECT RAISE(ABORT, 'invalid research request head update'); END;

      CREATE TRIGGER research_requests_no_update BEFORE UPDATE ON research_requests BEGIN SELECT RAISE(ABORT, 'research request is immutable'); END;
      CREATE TRIGGER research_requests_no_delete BEFORE DELETE ON research_requests BEGIN SELECT RAISE(ABORT, 'research request is immutable'); END;
      CREATE TRIGGER research_request_segments_no_update BEFORE UPDATE ON research_request_segments BEGIN SELECT RAISE(ABORT, 'research request segment is immutable'); END;
      CREATE TRIGGER research_request_segments_no_delete BEFORE DELETE ON research_request_segments BEGIN SELECT RAISE(ABORT, 'research request segment is immutable'); END;
      CREATE TRIGGER research_request_revisions_no_update BEFORE UPDATE ON research_request_revisions BEGIN SELECT RAISE(ABORT, 'research request revision is immutable'); END;
      CREATE TRIGGER research_request_revisions_no_delete BEFORE DELETE ON research_request_revisions BEGIN SELECT RAISE(ABORT, 'research request revision is immutable'); END;
      CREATE TRIGGER research_request_decisions_no_update BEFORE UPDATE ON research_request_decisions BEGIN SELECT RAISE(ABORT, 'research request decision is immutable'); END;
      CREATE TRIGGER research_request_decisions_no_delete BEFORE DELETE ON research_request_decisions BEGIN SELECT RAISE(ABORT, 'research request decision is immutable'); END;
      CREATE TRIGGER research_grants_no_update BEFORE UPDATE ON research_grants BEGIN SELECT RAISE(ABORT, 'research grant is immutable'); END;
      CREATE TRIGGER research_grants_no_delete BEFORE DELETE ON research_grants BEGIN SELECT RAISE(ABORT, 'research grant is immutable'); END;
      CREATE TRIGGER research_grant_revocations_no_update BEFORE UPDATE ON research_grant_revocations BEGIN SELECT RAISE(ABORT, 'research grant revocation is immutable'); END;
      CREATE TRIGGER research_grant_revocations_no_delete BEFORE DELETE ON research_grant_revocations BEGIN SELECT RAISE(ABORT, 'research grant revocation is immutable'); END;
      CREATE TRIGGER research_runs_no_update BEFORE UPDATE ON research_runs BEGIN SELECT RAISE(ABORT, 'research run is immutable'); END;
      CREATE TRIGGER research_runs_no_delete BEFORE DELETE ON research_runs BEGIN SELECT RAISE(ABORT, 'research run is immutable'); END;
      CREATE TRIGGER research_run_events_no_update BEFORE UPDATE ON research_run_events BEGIN SELECT RAISE(ABORT, 'research run event is append-only'); END;
      CREATE TRIGGER research_run_events_no_delete BEFORE DELETE ON research_run_events BEGIN SELECT RAISE(ABORT, 'research run event is append-only'); END;
      CREATE TRIGGER research_queries_no_update BEFORE UPDATE ON research_queries BEGIN SELECT RAISE(ABORT, 'research query is immutable'); END;
      CREATE TRIGGER research_queries_no_delete BEFORE DELETE ON research_queries BEGIN SELECT RAISE(ABORT, 'research query is immutable'); END;
      CREATE TRIGGER research_budget_ledger_no_update BEFORE UPDATE ON research_budget_ledger BEGIN SELECT RAISE(ABORT, 'research budget ledger is append-only'); END;
      CREATE TRIGGER research_budget_ledger_no_delete BEFORE DELETE ON research_budget_ledger BEGIN SELECT RAISE(ABORT, 'research budget ledger is append-only'); END;
      CREATE TRIGGER provider_content_snapshots_no_update BEFORE UPDATE ON provider_content_snapshots BEGIN SELECT RAISE(ABORT, 'provider content snapshot is immutable'); END;
      CREATE TRIGGER provider_content_snapshots_no_delete BEFORE DELETE ON provider_content_snapshots BEGIN SELECT RAISE(ABORT, 'provider content snapshot is immutable'); END;
      CREATE TRIGGER research_sources_no_update BEFORE UPDATE ON research_sources BEGIN SELECT RAISE(ABORT, 'research source is immutable'); END;
      CREATE TRIGGER research_sources_no_delete BEFORE DELETE ON research_sources BEGIN SELECT RAISE(ABORT, 'research source is immutable'); END;
      CREATE TRIGGER research_citations_no_update BEFORE UPDATE ON research_citations BEGIN SELECT RAISE(ABORT, 'research citation is immutable'); END;
      CREATE TRIGGER research_citations_no_delete BEFORE DELETE ON research_citations BEGIN SELECT RAISE(ABORT, 'research citation is immutable'); END;
      CREATE TRIGGER research_claims_no_update BEFORE UPDATE ON research_claims BEGIN SELECT RAISE(ABORT, 'research claim is immutable'); END;
      CREATE TRIGGER research_claims_no_delete BEFORE DELETE ON research_claims BEGIN SELECT RAISE(ABORT, 'research claim is immutable'); END;
      CREATE TRIGGER research_claim_citations_no_update BEFORE UPDATE ON research_claim_citations BEGIN SELECT RAISE(ABORT, 'research claim citation is immutable'); END;
      CREATE TRIGGER research_claim_citations_no_delete BEFORE DELETE ON research_claim_citations BEGIN SELECT RAISE(ABORT, 'research claim citation is immutable'); END;
      CREATE TRIGGER research_reports_no_update BEFORE UPDATE ON research_reports BEGIN SELECT RAISE(ABORT, 'research report is immutable'); END;
      CREATE TRIGGER research_reports_no_delete BEFORE DELETE ON research_reports BEGIN SELECT RAISE(ABORT, 'research report is immutable'); END;
      CREATE TRIGGER research_report_claims_no_update BEFORE UPDATE ON research_report_claims BEGIN SELECT RAISE(ABORT, 'research report claim is immutable'); END;
      CREATE TRIGGER research_report_claims_no_delete BEFORE DELETE ON research_report_claims BEGIN SELECT RAISE(ABORT, 'research report claim is immutable'); END;
      CREATE TRIGGER knowledge_proposal_research_evidence_no_update BEFORE UPDATE ON knowledge_proposal_research_evidence BEGIN SELECT RAISE(ABORT, 'proposal research evidence is immutable'); END;
      CREATE TRIGGER knowledge_proposal_research_evidence_no_delete BEFORE DELETE ON knowledge_proposal_research_evidence BEGIN SELECT RAISE(ABORT, 'proposal research evidence is immutable'); END;
      CREATE TRIGGER research_cache_inventory_entries_no_update BEFORE UPDATE ON research_cache_inventory_entries BEGIN SELECT RAISE(ABORT, 'research cache inventory is immutable'); END;
      CREATE TRIGGER research_cache_inventory_entries_no_delete BEFORE DELETE ON research_cache_inventory_entries BEGIN SELECT RAISE(ABORT, 'research cache inventory is immutable'); END;
    `,
  }),
  Object.freeze({
    version: 21,
    name: "provider-neutral-web-artifacts",
    sql: `
      CREATE TABLE web_search_artifact_runs (
        workspace_id TEXT NOT NULL,
        artifact_run_id TEXT NOT NULL,
        scope_kind TEXT NOT NULL CHECK(scope_kind IN ('legacy-investigation', 'research-query')),
        investigation_id TEXT,
        research_run_id TEXT,
        research_query_id TEXT,
        adapter_id TEXT NOT NULL CHECK(length(adapter_id) BETWEEN 1 AND 127),
        adapter_version TEXT NOT NULL CHECK(length(adapter_version) BETWEEN 1 AND 128),
        policy_version TEXT NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 128),
        query_digest TEXT NOT NULL CHECK(length(query_digest) = 71 AND substr(query_digest, 1, 7) = 'sha256:'),
        result_set_digest TEXT NOT NULL CHECK(length(result_set_digest) = 71 AND substr(result_set_digest, 1, 7) = 'sha256:'),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, artifact_run_id),
        CHECK((scope_kind = 'legacy-investigation' AND investigation_id IS NOT NULL AND research_run_id IS NULL AND research_query_id IS NULL)
          OR (scope_kind = 'research-query' AND investigation_id IS NULL AND research_run_id IS NOT NULL AND research_query_id IS NOT NULL)),
        FOREIGN KEY (workspace_id, investigation_id) REFERENCES internet_investigations(workspace_id, investigation_id),
        FOREIGN KEY (workspace_id, research_run_id, research_query_id) REFERENCES research_queries(workspace_id, run_id, query_id)
      ) STRICT;

      CREATE TABLE web_search_artifact_results (
        workspace_id TEXT NOT NULL,
        artifact_run_id TEXT NOT NULL,
        result_id TEXT NOT NULL,
        rank INTEGER NOT NULL CHECK(rank BETWEEN 1 AND 20),
        url TEXT NOT NULL CHECK(length(url) BETWEEN 1 AND 4096),
        url_digest TEXT NOT NULL CHECK(length(url_digest) = 71 AND substr(url_digest, 1, 7) = 'sha256:'),
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 2048),
        description TEXT NOT NULL CHECK(length(description) <= 8192),
        result_digest TEXT NOT NULL CHECK(length(result_digest) = 71 AND substr(result_digest, 1, 7) = 'sha256:'),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, result_id),
        UNIQUE (workspace_id, artifact_run_id, rank),
        FOREIGN KEY (workspace_id, artifact_run_id) REFERENCES web_search_artifact_runs(workspace_id, artifact_run_id)
      ) STRICT;

      INSERT INTO web_search_artifact_runs
        SELECT workspace_id, search_run_id, 'legacy-investigation', investigation_id, NULL, NULL, adapter_id,
          adapter_version, policy_version, query_digest, result_set_digest, created_at FROM internet_search_runs;
      INSERT INTO web_search_artifact_results
        SELECT workspace_id, search_run_id, result_id, rank, url, url_digest, title, description, result_digest,
          (SELECT created_at FROM internet_search_runs run WHERE run.workspace_id = result.workspace_id AND run.search_run_id = result.search_run_id)
        FROM internet_search_results result;

      CREATE TRIGGER web_search_artifact_runs_no_update BEFORE UPDATE ON web_search_artifact_runs BEGIN SELECT RAISE(ABORT, 'web search artifact run is immutable'); END;
      CREATE TRIGGER web_search_artifact_runs_no_delete BEFORE DELETE ON web_search_artifact_runs BEGIN SELECT RAISE(ABORT, 'web search artifact run is immutable'); END;
      CREATE TRIGGER web_search_artifact_results_no_update BEFORE UPDATE ON web_search_artifact_results BEGIN SELECT RAISE(ABORT, 'web search artifact result is immutable'); END;
      CREATE TRIGGER web_search_artifact_results_no_delete BEFORE DELETE ON web_search_artifact_results BEGIN SELECT RAISE(ABORT, 'web search artifact result is immutable'); END;
    `,
  }),
  Object.freeze({
    version: 22,
    name: "m5c-flow-plan-guidance-budget-foundation",
    sql: `
      CREATE TABLE translation_flow_controls (
        workspace_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        flow_state TEXT NOT NULL CHECK(flow_state IN (
          'planning', 'plan-approval', 'research', 'context-approval', 'translating',
          'qa', 'remediation', 'human-review', 'final-qa', 'ready-export',
          'exported', 'disposition', 'closed', 'paused', 'canceled', 'failed'
        )),
        outcome_state TEXT NOT NULL CHECK(outcome_state IN ('none', 'partial', 'complete', 'failed', 'unknown')),
        pause_reason TEXT,
        planner_enabled INTEGER NOT NULL CHECK(planner_enabled IN (0, 1)),
        version INTEGER NOT NULL CHECK(version >= 0),
        qa_cycles INTEGER NOT NULL DEFAULT 0 CHECK(qa_cycles >= 0),
        research_cycles INTEGER NOT NULL DEFAULT 0 CHECK(research_cycles >= 0),
        retranslation_count INTEGER NOT NULL DEFAULT 0 CHECK(retranslation_count >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, workflow_id),
        CHECK((flow_state = 'paused' AND pause_reason IS NOT NULL) OR (flow_state <> 'paused' AND pause_reason IS NULL)),
        CHECK((outcome_state = 'unknown' AND flow_state = 'paused') OR outcome_state <> 'unknown'),
        FOREIGN KEY (workspace_id, workflow_id) REFERENCES translation_workflows(workspace_id, workflow_id)
      ) STRICT;

      CREATE TABLE translation_flow_events (
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'system', 'model', 'provider', 'runner', 'fixture')),
        actor_id TEXT NOT NULL,
        details_json TEXT NOT NULL CHECK(json_valid(details_json) AND json_type(details_json) = 'object'),
        occurred_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, event_id),
        FOREIGN KEY (workspace_id, workflow_id) REFERENCES translation_flow_controls(workspace_id, workflow_id)
      ) STRICT;

      CREATE TABLE flow_budget_policy_revisions (
        workspace_id TEXT NOT NULL,
        policy_revision_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        policy_json TEXT NOT NULL CHECK(json_valid(policy_json) AND json_type(policy_json) = 'object'),
        policy_digest TEXT NOT NULL CHECK(length(policy_digest) = 71 AND substr(policy_digest, 1, 7) = 'sha256:'),
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, policy_revision_id),
        UNIQUE (workspace_id, workflow_id, revision),
        UNIQUE (workspace_id, workflow_id, policy_revision_id),
        FOREIGN KEY (workspace_id, workflow_id) REFERENCES translation_flow_controls(workspace_id, workflow_id)
      ) STRICT;

      CREATE TABLE flow_budget_policy_heads (
        workspace_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        policy_revision_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        version INTEGER NOT NULL CHECK(version >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, workflow_id),
        FOREIGN KEY (workspace_id, workflow_id, policy_revision_id)
          REFERENCES flow_budget_policy_revisions(workspace_id, workflow_id, policy_revision_id)
      ) STRICT;

      CREATE TABLE flow_budget_ledger (
        workspace_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        policy_revision_id TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('planner', 'search', 'fetch', 'research', 'translation', 'qa', 'retranslation')),
        entry_type TEXT NOT NULL CHECK(entry_type IN ('reserved', 'settled', 'released', 'unknown')),
        calls INTEGER NOT NULL CHECK(calls >= 0),
        input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
        cost_micros_cny INTEGER NOT NULL CHECK(cost_micros_cny >= 0),
        cost_micros_usd INTEGER NOT NULL CHECK(cost_micros_usd >= 0),
        duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
        usage_json TEXT NOT NULL CHECK(json_valid(usage_json) AND json_type(usage_json) = 'object'),
        occurred_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, entry_id),
        UNIQUE (workspace_id, workflow_id, reservation_id, entry_type),
        FOREIGN KEY (workspace_id, workflow_id, policy_revision_id)
          REFERENCES flow_budget_policy_revisions(workspace_id, workflow_id, policy_revision_id)
      ) STRICT;

      CREATE TABLE translation_context_plan_revisions (
        workspace_id TEXT NOT NULL,
        plan_revision_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        target_language TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        planner_mode TEXT NOT NULL CHECK(planner_mode IN ('local', 'model-assisted')),
        execution_state TEXT NOT NULL CHECK(execution_state IN ('draft', 'pending-user', 'approved', 'rejected', 'canceled', 'failed', 'unknown', 'stale')),
        plan_json TEXT NOT NULL CHECK(json_valid(plan_json) AND json_type(plan_json) = 'object'),
        plan_digest TEXT NOT NULL CHECK(length(plan_digest) = 71 AND substr(plan_digest, 1, 7) = 'sha256:'),
        actor_type TEXT NOT NULL CHECK(actor_type IN ('system', 'model', 'fixture')),
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, plan_revision_id),
        UNIQUE (workspace_id, workflow_id, revision),
        UNIQUE (workspace_id, workflow_id, plan_revision_id),
        FOREIGN KEY (workspace_id, workflow_id, document_id, source_revision_id, target_language)
          REFERENCES translation_workflows(workspace_id, workflow_id, document_id, source_revision_id, target_language)
      ) STRICT;

      CREATE TABLE translation_context_plan_heads (
        workspace_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        plan_revision_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        version INTEGER NOT NULL CHECK(version >= 0),
        state TEXT NOT NULL CHECK(state IN ('draft', 'pending-user', 'approved', 'rejected', 'canceled', 'failed', 'unknown', 'stale')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, workflow_id),
        FOREIGN KEY (workspace_id, workflow_id, plan_revision_id)
          REFERENCES translation_context_plan_revisions(workspace_id, workflow_id, plan_revision_id)
      ) STRICT;

      CREATE TABLE translation_context_plan_items (
        workspace_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        plan_revision_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('term', 'entity', 'fact', 'relation', 'style', 'measurement')),
        coverage TEXT NOT NULL CHECK(coverage IN ('covered', 'partially-covered', 'conflicted', 'stale', 'uncovered', 'low-impact')),
        instruction_type TEXT NOT NULL CHECK(instruction_type IN ('hard-constraint', 'preferred', 'background', 'disputed', 'warning-only')),
        impact TEXT NOT NULL CHECK(impact IN ('critical', 'high', 'medium', 'low')),
        segment_ids_json TEXT NOT NULL CHECK(json_valid(segment_ids_json) AND json_type(segment_ids_json) = 'array'),
        dependency_json TEXT NOT NULL CHECK(json_valid(dependency_json) AND json_type(dependency_json) = 'object'),
        dependency_digest TEXT NOT NULL CHECK(length(dependency_digest) = 71 AND substr(dependency_digest, 1, 7) = 'sha256:'),
        item_json TEXT NOT NULL CHECK(json_valid(item_json) AND json_type(item_json) = 'object'),
        item_digest TEXT NOT NULL CHECK(length(item_digest) = 71 AND substr(item_digest, 1, 7) = 'sha256:'),
        PRIMARY KEY (workspace_id, item_id),
        UNIQUE (workspace_id, plan_revision_id, item_id),
        FOREIGN KEY (workspace_id, workflow_id, plan_revision_id)
          REFERENCES translation_context_plan_revisions(workspace_id, workflow_id, plan_revision_id)
      ) STRICT;

      CREATE TABLE translation_context_plan_decisions (
        workspace_id TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        plan_revision_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('approved', 'rejected', 'canceled')),
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, decision_id),
        UNIQUE (workspace_id, plan_revision_id),
        FOREIGN KEY (workspace_id, workflow_id, plan_revision_id)
          REFERENCES translation_context_plan_revisions(workspace_id, workflow_id, plan_revision_id)
      ) STRICT;

      CREATE TABLE user_guidance_revisions (
        workspace_id TEXT NOT NULL,
        guidance_revision_id TEXT NOT NULL,
        guidance_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        raw_text TEXT NOT NULL CHECK(length(raw_text) BETWEEN 1 AND 16384),
        raw_digest TEXT NOT NULL CHECK(length(raw_digest) = 71 AND substr(raw_digest, 1, 7) = 'sha256:'),
        interpretation_json TEXT NOT NULL CHECK(json_valid(interpretation_json) AND json_type(interpretation_json) = 'object'),
        interpretation_digest TEXT NOT NULL CHECK(length(interpretation_digest) = 71 AND substr(interpretation_digest, 1, 7) = 'sha256:'),
        state TEXT NOT NULL CHECK(state IN ('draft', 'pending-user', 'confirmed', 'rejected', 'canceled', 'failed', 'unknown')),
        actor_type TEXT NOT NULL CHECK(actor_type IN ('system', 'model', 'fixture')),
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, guidance_revision_id),
        UNIQUE (workspace_id, guidance_id, revision),
        UNIQUE (workspace_id, guidance_id, guidance_revision_id),
        UNIQUE (workspace_id, workflow_id, guidance_revision_id),
        FOREIGN KEY (workspace_id, workflow_id) REFERENCES translation_flow_controls(workspace_id, workflow_id)
      ) STRICT;

      CREATE TABLE user_guidance_heads (
        workspace_id TEXT NOT NULL,
        guidance_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        guidance_revision_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        version INTEGER NOT NULL CHECK(version >= 0),
        state TEXT NOT NULL CHECK(state IN ('draft', 'pending-user', 'confirmed', 'rejected', 'canceled', 'failed', 'unknown')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, guidance_id),
        FOREIGN KEY (workspace_id, workflow_id, guidance_revision_id)
          REFERENCES user_guidance_revisions(workspace_id, workflow_id, guidance_revision_id)
      ) STRICT;

      CREATE TABLE user_guidance_decisions (
        workspace_id TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        guidance_id TEXT NOT NULL,
        guidance_revision_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('confirmed', 'rejected', 'canceled')),
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, decision_id),
        UNIQUE (workspace_id, guidance_revision_id),
        FOREIGN KEY (workspace_id, guidance_id, guidance_revision_id)
          REFERENCES user_guidance_revisions(workspace_id, guidance_id, guidance_revision_id)
      ) STRICT;

      CREATE TRIGGER translation_flow_events_no_update BEFORE UPDATE ON translation_flow_events BEGIN SELECT RAISE(ABORT, 'translation flow event is append-only'); END;
      CREATE TRIGGER translation_flow_events_no_delete BEFORE DELETE ON translation_flow_events BEGIN SELECT RAISE(ABORT, 'translation flow event is append-only'); END;
      CREATE TRIGGER flow_budget_policy_revisions_no_update BEFORE UPDATE ON flow_budget_policy_revisions BEGIN SELECT RAISE(ABORT, 'flow budget policy revision is immutable'); END;
      CREATE TRIGGER flow_budget_policy_revisions_no_delete BEFORE DELETE ON flow_budget_policy_revisions BEGIN SELECT RAISE(ABORT, 'flow budget policy revision is immutable'); END;
      CREATE TRIGGER flow_budget_ledger_no_update BEFORE UPDATE ON flow_budget_ledger BEGIN SELECT RAISE(ABORT, 'flow budget ledger is append-only'); END;
      CREATE TRIGGER flow_budget_ledger_no_delete BEFORE DELETE ON flow_budget_ledger BEGIN SELECT RAISE(ABORT, 'flow budget ledger is append-only'); END;
      CREATE TRIGGER translation_context_plan_revisions_no_update BEFORE UPDATE ON translation_context_plan_revisions BEGIN SELECT RAISE(ABORT, 'context plan revision is immutable'); END;
      CREATE TRIGGER translation_context_plan_revisions_no_delete BEFORE DELETE ON translation_context_plan_revisions BEGIN SELECT RAISE(ABORT, 'context plan revision is immutable'); END;
      CREATE TRIGGER translation_context_plan_items_no_update BEFORE UPDATE ON translation_context_plan_items BEGIN SELECT RAISE(ABORT, 'context plan item is immutable'); END;
      CREATE TRIGGER translation_context_plan_items_no_delete BEFORE DELETE ON translation_context_plan_items BEGIN SELECT RAISE(ABORT, 'context plan item is immutable'); END;
      CREATE TRIGGER translation_context_plan_decisions_no_update BEFORE UPDATE ON translation_context_plan_decisions BEGIN SELECT RAISE(ABORT, 'context plan decision is immutable'); END;
      CREATE TRIGGER translation_context_plan_decisions_no_delete BEFORE DELETE ON translation_context_plan_decisions BEGIN SELECT RAISE(ABORT, 'context plan decision is immutable'); END;
      CREATE TRIGGER user_guidance_revisions_no_update BEFORE UPDATE ON user_guidance_revisions BEGIN SELECT RAISE(ABORT, 'user guidance revision is immutable'); END;
      CREATE TRIGGER user_guidance_revisions_no_delete BEFORE DELETE ON user_guidance_revisions BEGIN SELECT RAISE(ABORT, 'user guidance revision is immutable'); END;
      CREATE TRIGGER user_guidance_decisions_no_update BEFORE UPDATE ON user_guidance_decisions BEGIN SELECT RAISE(ABORT, 'user guidance decision is immutable'); END;
      CREATE TRIGGER user_guidance_decisions_no_delete BEFORE DELETE ON user_guidance_decisions BEGIN SELECT RAISE(ABORT, 'user guidance decision is immutable'); END;
    `,
  }),
  Object.freeze({
    version: 23,
    name: "m5c-temporary-context-and-translation-binding",
    sql: `
      CREATE TABLE temporary_context_revisions (
        workspace_id TEXT NOT NULL,
        context_revision_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        plan_revision_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        state TEXT NOT NULL CHECK(state IN ('draft', 'pending-user', 'approved', 'rejected', 'canceled', 'stale')),
        context_json TEXT NOT NULL CHECK(json_valid(context_json) AND json_type(context_json) = 'object'),
        context_digest TEXT NOT NULL CHECK(length(context_digest) = 71 AND substr(context_digest, 1, 7) = 'sha256:'),
        actor_type TEXT NOT NULL CHECK(actor_type IN ('system', 'fixture')),
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, context_revision_id),
        UNIQUE (workspace_id, workflow_id, revision),
        UNIQUE (workspace_id, workflow_id, context_revision_id),
        FOREIGN KEY (workspace_id, workflow_id, plan_revision_id)
          REFERENCES translation_context_plan_revisions(workspace_id, workflow_id, plan_revision_id)
      ) STRICT;

      CREATE TABLE temporary_context_heads (
        workspace_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        context_revision_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        version INTEGER NOT NULL CHECK(version >= 0),
        state TEXT NOT NULL CHECK(state IN ('draft', 'pending-user', 'approved', 'rejected', 'canceled', 'stale')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, workflow_id),
        FOREIGN KEY (workspace_id, workflow_id, context_revision_id)
          REFERENCES temporary_context_revisions(workspace_id, workflow_id, context_revision_id)
      ) STRICT;

      CREATE TABLE temporary_context_items (
        workspace_id TEXT NOT NULL,
        context_item_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        context_revision_id TEXT NOT NULL,
        instruction_type TEXT NOT NULL CHECK(instruction_type IN ('hard-constraint', 'preferred', 'background', 'disputed', 'warning-only')),
        source_type TEXT NOT NULL CHECK(source_type IN ('plan-item', 'research-claim', 'user-guidance')),
        source_id TEXT NOT NULL,
        source_digest TEXT NOT NULL CHECK(length(source_digest) = 71 AND substr(source_digest, 1, 7) = 'sha256:'),
        segment_ids_json TEXT NOT NULL CHECK(json_valid(segment_ids_json) AND json_type(segment_ids_json) = 'array'),
        content_json TEXT NOT NULL CHECK(json_valid(content_json) AND json_type(content_json) = 'object'),
        content_digest TEXT NOT NULL CHECK(length(content_digest) = 71 AND substr(content_digest, 1, 7) = 'sha256:'),
        affirmative INTEGER NOT NULL CHECK(affirmative IN (0, 1)),
        PRIMARY KEY (workspace_id, context_item_id),
        UNIQUE (workspace_id, context_revision_id, context_item_id),
        CHECK((instruction_type IN ('disputed', 'warning-only') AND affirmative = 0) OR instruction_type NOT IN ('disputed', 'warning-only')),
        FOREIGN KEY (workspace_id, workflow_id, context_revision_id)
          REFERENCES temporary_context_revisions(workspace_id, workflow_id, context_revision_id)
      ) STRICT;

      CREATE TABLE context_use_decisions (
        workspace_id TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        context_revision_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('approved', 'rejected', 'canceled')),
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, decision_id),
        UNIQUE (workspace_id, context_revision_id),
        UNIQUE (workspace_id, workflow_id, context_revision_id, decision_id),
        FOREIGN KEY (workspace_id, workflow_id, context_revision_id)
          REFERENCES temporary_context_revisions(workspace_id, workflow_id, context_revision_id)
      ) STRICT;

      CREATE TABLE m5c_translation_attempt_bindings (
        workspace_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        context_revision_id TEXT NOT NULL,
        context_use_decision_id TEXT NOT NULL,
        plan_revision_id TEXT NOT NULL,
        flow_budget_reservation_id TEXT NOT NULL,
        segment_context_digest TEXT NOT NULL CHECK(length(segment_context_digest) = 71 AND substr(segment_context_digest, 1, 7) = 'sha256:'),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, attempt_id),
        UNIQUE (workspace_id, workflow_id, attempt_id),
        FOREIGN KEY (workspace_id, attempt_id, task_id)
          REFERENCES translation_attempts(workspace_id, attempt_id, task_id),
        FOREIGN KEY (workspace_id, workflow_id, context_revision_id, context_use_decision_id)
          REFERENCES context_use_decisions(workspace_id, workflow_id, context_revision_id, decision_id),
        FOREIGN KEY (workspace_id, workflow_id, plan_revision_id)
          REFERENCES translation_context_plan_revisions(workspace_id, workflow_id, plan_revision_id)
      ) STRICT;

      CREATE TRIGGER temporary_context_revisions_no_update BEFORE UPDATE ON temporary_context_revisions BEGIN SELECT RAISE(ABORT, 'temporary context revision is immutable'); END;
      CREATE TRIGGER temporary_context_revisions_no_delete BEFORE DELETE ON temporary_context_revisions BEGIN SELECT RAISE(ABORT, 'temporary context revision is immutable'); END;
      CREATE TRIGGER temporary_context_items_no_update BEFORE UPDATE ON temporary_context_items BEGIN SELECT RAISE(ABORT, 'temporary context item is immutable'); END;
      CREATE TRIGGER temporary_context_items_no_delete BEFORE DELETE ON temporary_context_items BEGIN SELECT RAISE(ABORT, 'temporary context item is immutable'); END;
      CREATE TRIGGER context_use_decisions_no_update BEFORE UPDATE ON context_use_decisions BEGIN SELECT RAISE(ABORT, 'context use decision is immutable'); END;
      CREATE TRIGGER context_use_decisions_no_delete BEFORE DELETE ON context_use_decisions BEGIN SELECT RAISE(ABORT, 'context use decision is immutable'); END;
      CREATE TRIGGER m5c_translation_attempt_bindings_no_update BEFORE UPDATE ON m5c_translation_attempt_bindings BEGIN SELECT RAISE(ABORT, 'M5C attempt binding is immutable'); END;
      CREATE TRIGGER m5c_translation_attempt_bindings_no_delete BEFORE DELETE ON m5c_translation_attempt_bindings BEGIN SELECT RAISE(ABORT, 'M5C attempt binding is immutable'); END;
    `,
  }),
  Object.freeze({
    version: 24,
    name: "m5c-target-revision-layered-qa",
    sql: `
      CREATE TABLE target_revision_snapshots (
        workspace_id TEXT NOT NULL,
        target_revision_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        working_copy_digest TEXT NOT NULL CHECK(length(working_copy_digest) = 71 AND substr(working_copy_digest, 1, 7) = 'sha256:'),
        parent_target_revision_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, target_revision_id),
        UNIQUE (workspace_id, workflow_id, working_copy_digest),
        UNIQUE (workspace_id, workflow_id, target_revision_id),
        FOREIGN KEY (workspace_id, workflow_id) REFERENCES translation_flow_controls(workspace_id, workflow_id),
        FOREIGN KEY (workspace_id, workflow_id, parent_target_revision_id)
          REFERENCES target_revision_snapshots(workspace_id, workflow_id, target_revision_id)
      ) STRICT;

      CREATE TABLE target_revision_segments (
        workspace_id TEXT NOT NULL,
        target_revision_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        working_copy_revision_id TEXT NOT NULL,
        text_digest TEXT NOT NULL CHECK(length(text_digest) = 71 AND substr(text_digest, 1, 7) = 'sha256:'),
        PRIMARY KEY (workspace_id, target_revision_id, segment_id),
        FOREIGN KEY (workspace_id, workflow_id, target_revision_id)
          REFERENCES target_revision_snapshots(workspace_id, workflow_id, target_revision_id),
        FOREIGN KEY (workspace_id, workflow_id, segment_id, working_copy_revision_id)
          REFERENCES working_copy_revisions(workspace_id, workflow_id, segment_id, working_copy_revision_id)
      ) STRICT;

      CREATE TABLE m5c_qa_runs (
        workspace_id TEXT NOT NULL,
        qa_run_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        target_revision_id TEXT NOT NULL,
        plan_revision_id TEXT NOT NULL,
        context_revision_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('completed', 'partial', 'failed', 'unknown', 'canceled')),
        scope TEXT NOT NULL CHECK(scope IN ('full', 'diff', 'deterministic-final')),
        layers_json TEXT NOT NULL CHECK(json_valid(layers_json) AND json_type(layers_json) = 'array'),
        rules_version TEXT NOT NULL,
        model_json TEXT NOT NULL CHECK(json_valid(model_json) AND json_type(model_json) = 'object'),
        run_digest TEXT NOT NULL CHECK(length(run_digest) = 71 AND substr(run_digest, 1, 7) = 'sha256:'),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, qa_run_id),
        UNIQUE (workspace_id, workflow_id, qa_run_id),
        FOREIGN KEY (workspace_id, workflow_id) REFERENCES translation_workflows(workspace_id, workflow_id),
        FOREIGN KEY (workspace_id, workflow_id, target_revision_id)
          REFERENCES target_revision_snapshots(workspace_id, workflow_id, target_revision_id),
        FOREIGN KEY (workspace_id, workflow_id, plan_revision_id)
          REFERENCES translation_context_plan_revisions(workspace_id, workflow_id, plan_revision_id),
        FOREIGN KEY (workspace_id, workflow_id, context_revision_id)
          REFERENCES temporary_context_revisions(workspace_id, workflow_id, context_revision_id)
      ) STRICT;

      CREATE TABLE m5c_qa_findings (
        workspace_id TEXT NOT NULL,
        finding_id TEXT NOT NULL,
        qa_run_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        layer TEXT NOT NULL CHECK(layer IN ('invariant', 'heuristic', 'model')),
        severity TEXT NOT NULL CHECK(severity IN ('error', 'warning', 'info')),
        code TEXT NOT NULL,
        segment_id TEXT,
        blocking INTEGER NOT NULL CHECK(blocking IN (0, 1)),
        details_json TEXT NOT NULL CHECK(json_valid(details_json) AND json_type(details_json) = 'object'),
        finding_digest TEXT NOT NULL CHECK(length(finding_digest) = 71 AND substr(finding_digest, 1, 7) = 'sha256:'),
        PRIMARY KEY (workspace_id, finding_id),
        UNIQUE (workspace_id, qa_run_id, finding_id),
        CHECK((layer = 'invariant' AND severity = 'error' AND blocking = 1) OR NOT (layer = 'invariant' AND severity = 'error')),
        FOREIGN KEY (workspace_id, workflow_id, qa_run_id) REFERENCES m5c_qa_runs(workspace_id, workflow_id, qa_run_id),
        FOREIGN KEY (workspace_id, segment_id) REFERENCES document_segments(workspace_id, segment_id)
      ) STRICT;

      CREATE TABLE m5c_qa_dependencies (
        workspace_id TEXT NOT NULL,
        qa_run_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        dependency_type TEXT NOT NULL CHECK(dependency_type IN ('segment-revision', 'context-item', 'fact-revision', 'evidence')),
        dependency_id TEXT NOT NULL,
        dependency_digest TEXT NOT NULL CHECK(length(dependency_digest) = 71 AND substr(dependency_digest, 1, 7) = 'sha256:'),
        segment_id TEXT,
        PRIMARY KEY (workspace_id, qa_run_id, dependency_type, dependency_id),
        FOREIGN KEY (workspace_id, workflow_id, qa_run_id) REFERENCES m5c_qa_runs(workspace_id, workflow_id, qa_run_id)
      ) STRICT;

      CREATE TABLE m5c_qa_finding_decisions (
        workspace_id TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        qa_run_id TEXT NOT NULL,
        finding_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('continue-research', 'add-guidance', 'accept-issue', 'retranslate', 'resolved')),
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, decision_id),
        UNIQUE (workspace_id, qa_run_id, finding_id),
        FOREIGN KEY (workspace_id, qa_run_id, finding_id) REFERENCES m5c_qa_findings(workspace_id, qa_run_id, finding_id)
      ) STRICT;

      CREATE TABLE m5c_qa_stale_events (
        workspace_id TEXT NOT NULL,
        stale_event_id TEXT NOT NULL,
        qa_run_id TEXT NOT NULL,
        dependency_type TEXT NOT NULL,
        dependency_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, stale_event_id),
        UNIQUE (workspace_id, qa_run_id, dependency_type, dependency_id),
        FOREIGN KEY (workspace_id, qa_run_id) REFERENCES m5c_qa_runs(workspace_id, qa_run_id)
      ) STRICT;

      CREATE TRIGGER working_copy_revision_stales_m5c_qa AFTER INSERT ON working_copy_revisions
      BEGIN
        INSERT OR IGNORE INTO m5c_qa_stale_events(workspace_id, stale_event_id, qa_run_id, dependency_type, dependency_id, reason, occurred_at)
        SELECT dependency.workspace_id,
          'edit:' || dependency.qa_run_id || ':' || NEW.working_copy_revision_id,
          dependency.qa_run_id, 'segment-revision', NEW.working_copy_revision_id, 'target-segment-edited', NEW.created_at
        FROM m5c_qa_dependencies dependency
        WHERE dependency.workspace_id = NEW.workspace_id AND dependency.workflow_id = NEW.workflow_id
          AND dependency.dependency_type = 'segment-revision' AND dependency.segment_id = NEW.segment_id;
      END;

      CREATE TRIGGER target_revision_snapshots_no_update BEFORE UPDATE ON target_revision_snapshots BEGIN SELECT RAISE(ABORT, 'target revision snapshot is immutable'); END;
      CREATE TRIGGER target_revision_snapshots_no_delete BEFORE DELETE ON target_revision_snapshots BEGIN SELECT RAISE(ABORT, 'target revision snapshot is immutable'); END;
      CREATE TRIGGER target_revision_segments_no_update BEFORE UPDATE ON target_revision_segments BEGIN SELECT RAISE(ABORT, 'target revision segment is immutable'); END;
      CREATE TRIGGER target_revision_segments_no_delete BEFORE DELETE ON target_revision_segments BEGIN SELECT RAISE(ABORT, 'target revision segment is immutable'); END;
      CREATE TRIGGER m5c_qa_runs_no_update BEFORE UPDATE ON m5c_qa_runs BEGIN SELECT RAISE(ABORT, 'M5C QA run is immutable'); END;
      CREATE TRIGGER m5c_qa_runs_no_delete BEFORE DELETE ON m5c_qa_runs BEGIN SELECT RAISE(ABORT, 'M5C QA run is immutable'); END;
      CREATE TRIGGER m5c_qa_findings_no_update BEFORE UPDATE ON m5c_qa_findings BEGIN SELECT RAISE(ABORT, 'M5C QA finding is immutable'); END;
      CREATE TRIGGER m5c_qa_findings_no_delete BEFORE DELETE ON m5c_qa_findings BEGIN SELECT RAISE(ABORT, 'M5C QA finding is immutable'); END;
      CREATE TRIGGER m5c_qa_dependencies_no_update BEFORE UPDATE ON m5c_qa_dependencies BEGIN SELECT RAISE(ABORT, 'M5C QA dependency is immutable'); END;
      CREATE TRIGGER m5c_qa_dependencies_no_delete BEFORE DELETE ON m5c_qa_dependencies BEGIN SELECT RAISE(ABORT, 'M5C QA dependency is immutable'); END;
      CREATE TRIGGER m5c_qa_finding_decisions_no_update BEFORE UPDATE ON m5c_qa_finding_decisions BEGIN SELECT RAISE(ABORT, 'M5C QA decision is immutable'); END;
      CREATE TRIGGER m5c_qa_finding_decisions_no_delete BEFORE DELETE ON m5c_qa_finding_decisions BEGIN SELECT RAISE(ABORT, 'M5C QA decision is immutable'); END;
      CREATE TRIGGER m5c_qa_stale_events_no_update BEFORE UPDATE ON m5c_qa_stale_events BEGIN SELECT RAISE(ABORT, 'M5C QA stale event is append-only'); END;
      CREATE TRIGGER m5c_qa_stale_events_no_delete BEFORE DELETE ON m5c_qa_stale_events BEGIN SELECT RAISE(ABORT, 'M5C QA stale event is append-only'); END;
    `,
  }),
  Object.freeze({
    version: 25,
    name: "m5c-research-binding-and-context-disposition",
    sql: `
      CREATE TABLE m5c_research_bindings (
        workspace_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        plan_revision_id TEXT NOT NULL,
        anchor_task_id TEXT NOT NULL,
        origin_type TEXT NOT NULL CHECK(origin_type IN ('plan-item', 'qa-finding')),
        origin_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, request_id),
        UNIQUE (workspace_id, workflow_id, plan_revision_id, origin_type, origin_id),
        FOREIGN KEY (workspace_id, request_id) REFERENCES research_requests(workspace_id, request_id),
        FOREIGN KEY (workspace_id, anchor_task_id)
          REFERENCES translation_tasks(workspace_id, task_id),
        FOREIGN KEY (workspace_id, workflow_id, plan_revision_id)
          REFERENCES translation_context_plan_revisions(workspace_id, workflow_id, plan_revision_id)
      ) STRICT;

      CREATE TABLE context_disposition_decisions (
        workspace_id TEXT NOT NULL,
        disposition_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        context_revision_id TEXT NOT NULL,
        selected_item_ids_json TEXT NOT NULL CHECK(json_valid(selected_item_ids_json) AND json_type(selected_item_ids_json) = 'array'),
        selected_digest TEXT NOT NULL CHECK(length(selected_digest) = 71 AND substr(selected_digest, 1, 7) = 'sha256:'),
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, disposition_id),
        UNIQUE (workspace_id, workflow_id, context_revision_id),
        FOREIGN KEY (workspace_id, workflow_id, context_revision_id)
          REFERENCES temporary_context_revisions(workspace_id, workflow_id, context_revision_id)
      ) STRICT;

      CREATE TABLE context_persistence_proposals (
        workspace_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        disposition_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        context_revision_id TEXT NOT NULL,
        context_item_id TEXT NOT NULL,
        proposed_source_json TEXT NOT NULL CHECK(json_valid(proposed_source_json) AND json_type(proposed_source_json) = 'object'),
        proposed_source_digest TEXT NOT NULL CHECK(length(proposed_source_digest) = 71 AND substr(proposed_source_digest, 1, 7) = 'sha256:'),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, proposal_id),
        UNIQUE (workspace_id, disposition_id, context_item_id),
        FOREIGN KEY (workspace_id, disposition_id) REFERENCES context_disposition_decisions(workspace_id, disposition_id),
        FOREIGN KEY (workspace_id, context_item_id) REFERENCES temporary_context_items(workspace_id, context_item_id),
        FOREIGN KEY (workspace_id, workflow_id, context_revision_id)
          REFERENCES temporary_context_revisions(workspace_id, workflow_id, context_revision_id)
      ) STRICT;

      CREATE TABLE context_persistence_proposal_decisions (
        workspace_id TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('approved', 'rejected')),
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, decision_id),
        UNIQUE (workspace_id, proposal_id),
        FOREIGN KEY (workspace_id, proposal_id) REFERENCES context_persistence_proposals(workspace_id, proposal_id)
      ) STRICT;

      CREATE TABLE context_persistence_proposal_applications (
        workspace_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        fact_revision_id TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, application_id),
        UNIQUE (workspace_id, proposal_id),
        FOREIGN KEY (workspace_id, proposal_id) REFERENCES context_persistence_proposals(workspace_id, proposal_id),
        FOREIGN KEY (workspace_id, decision_id) REFERENCES context_persistence_proposal_decisions(workspace_id, decision_id),
        FOREIGN KEY (workspace_id, fact_id, fact_revision_id)
          REFERENCES knowledge_fact_revisions(workspace_id, fact_id, revision_id)
      ) STRICT;

      CREATE TRIGGER m5c_research_bindings_no_update BEFORE UPDATE ON m5c_research_bindings BEGIN SELECT RAISE(ABORT, 'M5C research binding is immutable'); END;
      CREATE TRIGGER m5c_research_bindings_no_delete BEFORE DELETE ON m5c_research_bindings BEGIN SELECT RAISE(ABORT, 'M5C research binding is immutable'); END;
      CREATE TRIGGER context_disposition_decisions_no_update BEFORE UPDATE ON context_disposition_decisions BEGIN SELECT RAISE(ABORT, 'context disposition decision is immutable'); END;
      CREATE TRIGGER context_disposition_decisions_no_delete BEFORE DELETE ON context_disposition_decisions BEGIN SELECT RAISE(ABORT, 'context disposition decision is immutable'); END;
      CREATE TRIGGER context_persistence_proposals_no_update BEFORE UPDATE ON context_persistence_proposals BEGIN SELECT RAISE(ABORT, 'context persistence proposal is immutable'); END;
      CREATE TRIGGER context_persistence_proposals_no_delete BEFORE DELETE ON context_persistence_proposals BEGIN SELECT RAISE(ABORT, 'context persistence proposal is immutable'); END;
      CREATE TRIGGER context_persistence_proposal_decisions_no_update BEFORE UPDATE ON context_persistence_proposal_decisions BEGIN SELECT RAISE(ABORT, 'context persistence proposal decision is immutable'); END;
      CREATE TRIGGER context_persistence_proposal_decisions_no_delete BEFORE DELETE ON context_persistence_proposal_decisions BEGIN SELECT RAISE(ABORT, 'context persistence proposal decision is immutable'); END;
      CREATE TRIGGER context_persistence_proposal_applications_no_update BEFORE UPDATE ON context_persistence_proposal_applications BEGIN SELECT RAISE(ABORT, 'context persistence proposal application is immutable'); END;
      CREATE TRIGGER context_persistence_proposal_applications_no_delete BEFORE DELETE ON context_persistence_proposal_applications BEGIN SELECT RAISE(ABORT, 'context persistence proposal application is immutable'); END;
    `,
  }),
  Object.freeze({
    version: 26,
    name: "m5c-cross-budget-research-operation-binding",
    sql: `
      CREATE TABLE m5c_research_operations (
        workspace_id TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        query_id TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('search', 'fetch', 'research')),
        operation_digest TEXT NOT NULL CHECK(length(operation_digest) = 71 AND substr(operation_digest, 1, 7) = 'sha256:'),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, reservation_id),
        UNIQUE (workspace_id, query_id),
        FOREIGN KEY (workspace_id, request_id) REFERENCES m5c_research_bindings(workspace_id, request_id),
        FOREIGN KEY (workspace_id, run_id) REFERENCES research_runs(workspace_id, run_id),
        FOREIGN KEY (workspace_id, query_id) REFERENCES research_queries(workspace_id, query_id),
        FOREIGN KEY (workspace_id, workflow_id) REFERENCES translation_flow_controls(workspace_id, workflow_id)
      ) STRICT;

      CREATE TABLE translation_flow_recovery_decisions (
        workspace_id TEXT NOT NULL,
        recovery_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        paused_version INTEGER NOT NULL CHECK(paused_version >= 0),
        action TEXT NOT NULL CHECK(action IN ('continue-local', 'retry', 'terminate')),
        pause_reason TEXT NOT NULL,
        request_digest TEXT NOT NULL CHECK(length(request_digest) = 71 AND substr(request_digest, 1, 7) = 'sha256:'),
        result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json) = 'object'),
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, recovery_id),
        UNIQUE (workspace_id, workflow_id, paused_version),
        FOREIGN KEY (workspace_id, workflow_id) REFERENCES translation_flow_controls(workspace_id, workflow_id)
      ) STRICT;

      CREATE TRIGGER m5c_research_operations_no_update BEFORE UPDATE ON m5c_research_operations BEGIN SELECT RAISE(ABORT, 'M5C research operation binding is immutable'); END;
      CREATE TRIGGER m5c_research_operations_no_delete BEFORE DELETE ON m5c_research_operations BEGIN SELECT RAISE(ABORT, 'M5C research operation binding is immutable'); END;
      CREATE TRIGGER translation_flow_recovery_decisions_no_update BEFORE UPDATE ON translation_flow_recovery_decisions BEGIN SELECT RAISE(ABORT, 'translation flow recovery decision is immutable'); END;
      CREATE TRIGGER translation_flow_recovery_decisions_no_delete BEFORE DELETE ON translation_flow_recovery_decisions BEGIN SELECT RAISE(ABORT, 'translation flow recovery decision is immutable'); END;
    `,
  }),
  Object.freeze({
    version: 27,
    name: "m5c-candidate-knowledge-needs",
    sql: `
      CREATE TABLE candidate_knowledge_needs (
        workspace_id TEXT NOT NULL,
        need_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        attempt_id TEXT,
        plan_revision_id TEXT NOT NULL,
        context_revision_id TEXT,
        context_digest TEXT NOT NULL CHECK(length(context_digest) = 71 AND substr(context_digest, 1, 7) = 'sha256:'),
        origin_type TEXT NOT NULL CHECK(origin_type IN ('plan-item', 'translation-attempt')),
        origin_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('term', 'entity', 'fact', 'relation', 'measurement')),
        impact TEXT NOT NULL CHECK(impact IN ('critical', 'high', 'medium', 'low')),
        question TEXT NOT NULL CHECK(length(question) BETWEEN 1 AND 512),
        question_digest TEXT NOT NULL CHECK(length(question_digest) = 71 AND substr(question_digest, 1, 7) = 'sha256:'),
        related_segment_ids_json TEXT NOT NULL CHECK(json_valid(related_segment_ids_json) AND json_type(related_segment_ids_json) = 'array'),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, need_id),
        UNIQUE (workspace_id, workflow_id, plan_revision_id, context_digest, question_digest),
        FOREIGN KEY (workspace_id, workflow_id, plan_revision_id)
          REFERENCES translation_context_plan_revisions(workspace_id, workflow_id, plan_revision_id),
        FOREIGN KEY (workspace_id, attempt_id) REFERENCES translation_attempts(workspace_id, attempt_id),
        FOREIGN KEY (workspace_id, segment_id) REFERENCES document_segments(workspace_id, segment_id)
      ) STRICT;

      CREATE TABLE candidate_knowledge_need_decisions (
        workspace_id TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        need_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('research', 'guidance', 'proceed-with-risk')),
        details_json TEXT NOT NULL CHECK(json_valid(details_json) AND json_type(details_json) = 'object'),
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, decision_id),
        UNIQUE (workspace_id, need_id),
        FOREIGN KEY (workspace_id, need_id) REFERENCES candidate_knowledge_needs(workspace_id, need_id)
      ) STRICT;

      CREATE TABLE candidate_knowledge_need_plan_bindings (
        workspace_id TEXT NOT NULL,
        need_id TEXT NOT NULL,
        plan_revision_id TEXT NOT NULL,
        plan_item_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, need_id),
        UNIQUE (workspace_id, plan_revision_id, plan_item_id),
        FOREIGN KEY (workspace_id, need_id) REFERENCES candidate_knowledge_needs(workspace_id, need_id),
        FOREIGN KEY (workspace_id, plan_revision_id, plan_item_id)
          REFERENCES translation_context_plan_items(workspace_id, plan_revision_id, item_id)
      ) STRICT;

      CREATE TABLE candidate_knowledge_need_research_bindings (
        workspace_id TEXT NOT NULL,
        need_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, need_id),
        UNIQUE (workspace_id, request_id),
        FOREIGN KEY (workspace_id, need_id) REFERENCES candidate_knowledge_needs(workspace_id, need_id),
        FOREIGN KEY (workspace_id, request_id) REFERENCES m5c_research_bindings(workspace_id, request_id)
      ) STRICT;

      CREATE TRIGGER candidate_knowledge_needs_no_update BEFORE UPDATE ON candidate_knowledge_needs BEGIN SELECT RAISE(ABORT, 'candidate knowledge need is immutable'); END;
      CREATE TRIGGER candidate_knowledge_needs_no_delete BEFORE DELETE ON candidate_knowledge_needs BEGIN SELECT RAISE(ABORT, 'candidate knowledge need is immutable'); END;
      CREATE TRIGGER candidate_knowledge_need_decisions_no_update BEFORE UPDATE ON candidate_knowledge_need_decisions BEGIN SELECT RAISE(ABORT, 'candidate knowledge need decision is immutable'); END;
      CREATE TRIGGER candidate_knowledge_need_decisions_no_delete BEFORE DELETE ON candidate_knowledge_need_decisions BEGIN SELECT RAISE(ABORT, 'candidate knowledge need decision is immutable'); END;
      CREATE TRIGGER candidate_knowledge_need_plan_bindings_no_update BEFORE UPDATE ON candidate_knowledge_need_plan_bindings BEGIN SELECT RAISE(ABORT, 'candidate knowledge need plan binding is immutable'); END;
      CREATE TRIGGER candidate_knowledge_need_plan_bindings_no_delete BEFORE DELETE ON candidate_knowledge_need_plan_bindings BEGIN SELECT RAISE(ABORT, 'candidate knowledge need plan binding is immutable'); END;
      CREATE TRIGGER candidate_knowledge_need_research_bindings_no_update BEFORE UPDATE ON candidate_knowledge_need_research_bindings BEGIN SELECT RAISE(ABORT, 'candidate knowledge need research binding is immutable'); END;
      CREATE TRIGGER candidate_knowledge_need_research_bindings_no_delete BEFORE DELETE ON candidate_knowledge_need_research_bindings BEGIN SELECT RAISE(ABORT, 'candidate knowledge need research binding is immutable'); END;
    `,
  }),
  Object.freeze({
    version: 28,
    name: "direct-research-fetch-snapshots",
    sql: `
      CREATE TABLE research_direct_fetch_snapshots (
        workspace_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        query_id TEXT NOT NULL,
        requested_url TEXT NOT NULL CHECK(length(requested_url) BETWEEN 1 AND 4096),
        final_url TEXT NOT NULL CHECK(length(final_url) BETWEEN 1 AND 4096),
        fetched_at TEXT NOT NULL,
        fetch_policy_version TEXT NOT NULL CHECK(length(fetch_policy_version) BETWEEN 1 AND 128),
        status_code INTEGER NOT NULL CHECK(status_code BETWEEN 200 AND 299),
        mime_type TEXT NOT NULL CHECK(mime_type IN ('text/html', 'text/plain')),
        title TEXT NOT NULL CHECK(length(title) <= 2048),
        extracted_text TEXT NOT NULL CHECK(length(extracted_text) BETWEEN 1 AND 262144),
        content_digest TEXT NOT NULL CHECK(length(content_digest) = 71 AND substr(content_digest, 1, 7) = 'sha256:'),
        snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest) = 71 AND substr(snapshot_digest, 1, 7) = 'sha256:'),
        truncated INTEGER NOT NULL CHECK(truncated IN (0, 1)),
        diagnostics_json TEXT NOT NULL CHECK(json_valid(diagnostics_json) AND json_type(diagnostics_json) = 'array'),
        redirects_json TEXT NOT NULL CHECK(json_valid(redirects_json) AND json_type(redirects_json) = 'array'),
        untrusted INTEGER NOT NULL CHECK(untrusted = 1),
        PRIMARY KEY (workspace_id, snapshot_id),
        UNIQUE (workspace_id, run_id, snapshot_id),
        UNIQUE (workspace_id, run_id, query_id, snapshot_digest),
        FOREIGN KEY (workspace_id, run_id, query_id) REFERENCES research_queries(workspace_id, run_id, query_id)
      ) STRICT;

      CREATE TRIGGER research_direct_fetch_snapshots_no_update BEFORE UPDATE ON research_direct_fetch_snapshots
      BEGIN SELECT RAISE(ABORT, 'direct research fetch snapshot is immutable'); END;
      CREATE TRIGGER research_direct_fetch_snapshots_no_delete BEFORE DELETE ON research_direct_fetch_snapshots
      BEGIN SELECT RAISE(ABORT, 'direct research fetch snapshot is immutable'); END;
    `,
  }),
  Object.freeze({
    version: 29,
    name: "generic-knowledge-proposal-evidence-origin",
    foreignKeysOff: true,
    sql: `
      DROP TRIGGER knowledge_proposals_no_update;
      DROP TRIGGER knowledge_proposals_no_delete;
      DROP TRIGGER knowledge_proposal_revisions_no_update;
      DROP TRIGGER knowledge_proposal_revisions_no_delete;
      DROP TRIGGER knowledge_proposal_heads_no_delete;
      DROP TRIGGER knowledge_proposal_heads_update_guard;
      DROP TRIGGER knowledge_proposal_decisions_no_update;
      DROP TRIGGER knowledge_proposal_decisions_no_delete;
      DROP TRIGGER knowledge_proposal_applications_no_update;
      DROP TRIGGER knowledge_proposal_applications_no_delete;
      DROP TRIGGER knowledge_proposal_research_evidence_no_update;
      DROP TRIGGER knowledge_proposal_research_evidence_no_delete;
      DROP INDEX knowledge_proposal_decision_scope;

      ALTER TABLE knowledge_proposal_research_evidence RENAME TO knowledge_proposal_research_evidence_v22;
      ALTER TABLE knowledge_proposal_applications RENAME TO knowledge_proposal_applications_v22;
      ALTER TABLE knowledge_proposal_decisions RENAME TO knowledge_proposal_decisions_v22;
      ALTER TABLE knowledge_proposal_heads RENAME TO knowledge_proposal_heads_v22;
      ALTER TABLE knowledge_proposal_revisions RENAME TO knowledge_proposal_revisions_v22;
      ALTER TABLE knowledge_proposals RENAME TO knowledge_proposals_v22;

      CREATE TABLE knowledge_proposals (
        workspace_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        origin_kind TEXT NOT NULL CHECK(origin_kind IN ('legacy-investigation', 'research-run')),
        investigation_id TEXT,
        research_run_id TEXT,
        workflow_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, proposal_id),
        UNIQUE (workspace_id, investigation_id, proposal_id),
        UNIQUE (workspace_id, research_run_id, proposal_id),
        CHECK((origin_kind = 'legacy-investigation' AND investigation_id IS NOT NULL AND research_run_id IS NULL)
          OR (origin_kind = 'research-run' AND investigation_id IS NULL AND research_run_id IS NOT NULL)),
        FOREIGN KEY (workspace_id, investigation_id, workflow_id, segment_id)
          REFERENCES internet_investigations(workspace_id, investigation_id, workflow_id, segment_id),
        FOREIGN KEY (workspace_id, research_run_id) REFERENCES research_runs(workspace_id, run_id)
      ) STRICT;

      CREATE TABLE knowledge_proposal_revisions (
        workspace_id TEXT NOT NULL,
        proposal_revision_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('legacy-fetch', 'direct-fetch')),
        investigation_id TEXT,
        fetch_snapshot_id TEXT,
        research_run_id TEXT,
        direct_snapshot_id TEXT,
        version INTEGER NOT NULL CHECK(version >= 1),
        operation TEXT NOT NULL CHECK(operation IN ('create', 'revise')),
        fact_id TEXT NOT NULL,
        base_fact_revision_id TEXT,
        proposed_source_json TEXT NOT NULL CHECK(json_valid(proposed_source_json) AND json_type(proposed_source_json) = 'object'),
        proposed_source_digest TEXT NOT NULL CHECK(length(proposed_source_digest) = 71 AND substr(proposed_source_digest, 1, 7) = 'sha256:'),
        proposal_policy_version TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'system', 'fixture')),
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, proposal_revision_id),
        UNIQUE (workspace_id, proposal_id, version),
        UNIQUE (workspace_id, proposal_id, proposal_revision_id),
        CHECK((operation = 'create' AND base_fact_revision_id IS NULL) OR (operation = 'revise' AND base_fact_revision_id IS NOT NULL)),
        CHECK((evidence_kind = 'legacy-fetch' AND investigation_id IS NOT NULL AND fetch_snapshot_id IS NOT NULL
          AND research_run_id IS NULL AND direct_snapshot_id IS NULL)
          OR (evidence_kind = 'direct-fetch' AND investigation_id IS NULL AND fetch_snapshot_id IS NULL
          AND research_run_id IS NOT NULL AND direct_snapshot_id IS NOT NULL)),
        FOREIGN KEY (workspace_id, proposal_id) REFERENCES knowledge_proposals(workspace_id, proposal_id),
        FOREIGN KEY (workspace_id, investigation_id, fetch_snapshot_id)
          REFERENCES internet_fetch_snapshots(workspace_id, investigation_id, fetch_snapshot_id),
        FOREIGN KEY (workspace_id, research_run_id, direct_snapshot_id)
          REFERENCES research_direct_fetch_snapshots(workspace_id, run_id, snapshot_id),
        FOREIGN KEY (workspace_id, fact_id, base_fact_revision_id)
          REFERENCES knowledge_fact_revisions(workspace_id, fact_id, revision_id)
      ) STRICT;

      CREATE TABLE knowledge_proposal_heads (
        workspace_id TEXT NOT NULL, proposal_id TEXT NOT NULL, proposal_revision_id TEXT NOT NULL,
        revision_version INTEGER NOT NULL CHECK(revision_version >= 1), version INTEGER NOT NULL CHECK(version >= 0),
        state TEXT NOT NULL CHECK(state IN ('draft', 'approved', 'rejected')), updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, proposal_id),
        FOREIGN KEY (workspace_id, proposal_id, proposal_revision_id)
          REFERENCES knowledge_proposal_revisions(workspace_id, proposal_id, proposal_revision_id)
      ) STRICT;

      CREATE TABLE knowledge_proposal_decisions (
        workspace_id TEXT NOT NULL, decision_id TEXT NOT NULL, proposal_id TEXT NOT NULL, proposal_revision_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('approved', 'rejected')), actor_type TEXT NOT NULL CHECK(actor_type = 'user'),
        actor_id TEXT NOT NULL, decided_at TEXT NOT NULL, PRIMARY KEY (workspace_id, decision_id), UNIQUE (workspace_id, proposal_id),
        FOREIGN KEY (workspace_id, proposal_id, proposal_revision_id)
          REFERENCES knowledge_proposal_revisions(workspace_id, proposal_id, proposal_revision_id)
      ) STRICT;
      CREATE UNIQUE INDEX knowledge_proposal_decision_scope
        ON knowledge_proposal_decisions(workspace_id, decision_id, proposal_id, proposal_revision_id);

      CREATE TABLE knowledge_proposal_applications (
        workspace_id TEXT NOT NULL, application_id TEXT NOT NULL, proposal_id TEXT NOT NULL, proposal_revision_id TEXT NOT NULL,
        decision_id TEXT NOT NULL, operation TEXT NOT NULL CHECK(operation IN ('create', 'revise')), fact_id TEXT NOT NULL,
        fact_revision_id TEXT NOT NULL, proposed_source_digest TEXT NOT NULL CHECK(length(proposed_source_digest) = 71 AND substr(proposed_source_digest, 1, 7) = 'sha256:'),
        actor_type TEXT NOT NULL CHECK(actor_type = 'user'), actor_id TEXT NOT NULL, applied_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, application_id), UNIQUE (workspace_id, proposal_id), UNIQUE (workspace_id, proposal_id, proposal_revision_id),
        FOREIGN KEY (workspace_id, proposal_id, proposal_revision_id)
          REFERENCES knowledge_proposal_revisions(workspace_id, proposal_id, proposal_revision_id),
        FOREIGN KEY (workspace_id, decision_id, proposal_id, proposal_revision_id)
          REFERENCES knowledge_proposal_decisions(workspace_id, decision_id, proposal_id, proposal_revision_id),
        FOREIGN KEY (workspace_id, fact_id, fact_revision_id) REFERENCES knowledge_fact_revisions(workspace_id, fact_id, revision_id)
      ) STRICT;

      CREATE TABLE knowledge_proposal_research_evidence (
        workspace_id TEXT NOT NULL, proposal_revision_id TEXT NOT NULL, report_id TEXT NOT NULL,
        claim_id TEXT NOT NULL, citation_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        PRIMARY KEY (workspace_id, proposal_revision_id, claim_id, citation_id), UNIQUE (workspace_id, proposal_revision_id, ordinal),
        FOREIGN KEY (workspace_id, proposal_revision_id) REFERENCES knowledge_proposal_revisions(workspace_id, proposal_revision_id),
        FOREIGN KEY (workspace_id, report_id, claim_id) REFERENCES research_report_claims(workspace_id, report_id, claim_id),
        FOREIGN KEY (workspace_id, claim_id, citation_id) REFERENCES research_claim_citations(workspace_id, claim_id, citation_id)
      ) STRICT;

      INSERT INTO knowledge_proposals
        SELECT workspace_id, proposal_id, 'legacy-investigation', investigation_id, NULL, workflow_id, segment_id, created_at
        FROM knowledge_proposals_v22;
      INSERT INTO knowledge_proposal_revisions
        SELECT workspace_id, proposal_revision_id, proposal_id, 'legacy-fetch', investigation_id, fetch_snapshot_id, NULL, NULL,
          version, operation, fact_id, base_fact_revision_id, proposed_source_json, proposed_source_digest,
          proposal_policy_version, actor_type, actor_id, created_at FROM knowledge_proposal_revisions_v22;
      INSERT INTO knowledge_proposal_heads SELECT * FROM knowledge_proposal_heads_v22;
      INSERT INTO knowledge_proposal_decisions SELECT * FROM knowledge_proposal_decisions_v22;
      INSERT INTO knowledge_proposal_applications SELECT * FROM knowledge_proposal_applications_v22;
      INSERT INTO knowledge_proposal_research_evidence SELECT * FROM knowledge_proposal_research_evidence_v22;

      DROP TABLE knowledge_proposal_research_evidence_v22;
      DROP TABLE knowledge_proposal_applications_v22;
      DROP TABLE knowledge_proposal_decisions_v22;
      DROP TABLE knowledge_proposal_heads_v22;
      DROP TABLE knowledge_proposal_revisions_v22;
      DROP TABLE knowledge_proposals_v22;

      CREATE TRIGGER knowledge_proposals_no_update BEFORE UPDATE ON knowledge_proposals BEGIN SELECT RAISE(ABORT, 'knowledge proposal is immutable'); END;
      CREATE TRIGGER knowledge_proposals_no_delete BEFORE DELETE ON knowledge_proposals BEGIN SELECT RAISE(ABORT, 'knowledge proposal is immutable'); END;
      CREATE TRIGGER knowledge_proposal_revisions_no_update BEFORE UPDATE ON knowledge_proposal_revisions BEGIN SELECT RAISE(ABORT, 'knowledge proposal revision is immutable'); END;
      CREATE TRIGGER knowledge_proposal_revisions_no_delete BEFORE DELETE ON knowledge_proposal_revisions BEGIN SELECT RAISE(ABORT, 'knowledge proposal revision is immutable'); END;
      CREATE TRIGGER knowledge_proposal_heads_no_delete BEFORE DELETE ON knowledge_proposal_heads BEGIN SELECT RAISE(ABORT, 'knowledge proposal head is immutable'); END;
      CREATE TRIGGER knowledge_proposal_heads_update_guard BEFORE UPDATE ON knowledge_proposal_heads
      WHEN NEW.version <> OLD.version + 1 OR NOT (
        (OLD.state = 'draft' AND NEW.state = 'draft' AND NEW.proposal_revision_id <> OLD.proposal_revision_id AND NEW.revision_version = OLD.revision_version + 1) OR
        (OLD.state = 'draft' AND NEW.state IN ('approved', 'rejected') AND NEW.proposal_revision_id = OLD.proposal_revision_id AND NEW.revision_version = OLD.revision_version))
      BEGIN SELECT RAISE(ABORT, 'invalid knowledge proposal head update'); END;
      CREATE TRIGGER knowledge_proposal_decisions_no_update BEFORE UPDATE ON knowledge_proposal_decisions BEGIN SELECT RAISE(ABORT, 'knowledge proposal decision is immutable'); END;
      CREATE TRIGGER knowledge_proposal_decisions_no_delete BEFORE DELETE ON knowledge_proposal_decisions BEGIN SELECT RAISE(ABORT, 'knowledge proposal decision is immutable'); END;
      CREATE TRIGGER knowledge_proposal_applications_no_update BEFORE UPDATE ON knowledge_proposal_applications BEGIN SELECT RAISE(ABORT, 'knowledge proposal application is immutable'); END;
      CREATE TRIGGER knowledge_proposal_applications_no_delete BEFORE DELETE ON knowledge_proposal_applications BEGIN SELECT RAISE(ABORT, 'knowledge proposal application is immutable'); END;
      CREATE TRIGGER knowledge_proposal_research_evidence_no_update BEFORE UPDATE ON knowledge_proposal_research_evidence BEGIN SELECT RAISE(ABORT, 'proposal research evidence is immutable'); END;
      CREATE TRIGGER knowledge_proposal_research_evidence_no_delete BEFORE DELETE ON knowledge_proposal_research_evidence BEGIN SELECT RAISE(ABORT, 'proposal research evidence is immutable'); END;
    `,
  }),
  Object.freeze({
    version: 30,
    name: "translation-reference-tools",
    sql: `
      CREATE TABLE translation_tool_configurations (
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        schema_version TEXT NOT NULL CHECK(schema_version = 'translation-tool-configuration-v1'),
        configuration_json TEXT NOT NULL CHECK(json_valid(configuration_json) AND json_type(configuration_json) = 'object'),
        configuration_digest TEXT NOT NULL CHECK(length(configuration_digest) = 71 AND substr(configuration_digest, 1, 7) = 'sha256:'),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, task_id),
        UNIQUE (workspace_id, task_id, configuration_digest),
        FOREIGN KEY (workspace_id, task_id) REFERENCES translation_tasks(workspace_id, task_id)
      ) STRICT;

      CREATE TABLE translation_calculation_receipts (
        workspace_id TEXT NOT NULL,
        receipt_digest TEXT NOT NULL CHECK(length(receipt_digest) = 71 AND substr(receipt_digest, 1, 7) = 'sha256:'),
        task_id TEXT NOT NULL,
        request_digest TEXT NOT NULL CHECK(length(request_digest) = 71 AND substr(request_digest, 1, 7) = 'sha256:'),
        request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json) = 'object'),
        receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json) = 'object'),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, task_id, receipt_digest),
        UNIQUE (workspace_id, task_id, request_digest),
        FOREIGN KEY (workspace_id, task_id) REFERENCES translation_tool_configurations(workspace_id, task_id)
      ) STRICT;

      CREATE TABLE translation_reference_cache_entries (
        workspace_id TEXT NOT NULL,
        cache_entry_digest TEXT NOT NULL CHECK(length(cache_entry_digest) = 71 AND substr(cache_entry_digest, 1, 7) = 'sha256:'),
        task_id TEXT NOT NULL,
        tool_kind TEXT NOT NULL CHECK(tool_kind IN ('dictionary', 'entity')),
        provider_id TEXT NOT NULL CHECK(length(provider_id) BETWEEN 1 AND 128),
        provider_version TEXT NOT NULL CHECK(length(provider_version) BETWEEN 1 AND 128),
        request_digest TEXT NOT NULL CHECK(length(request_digest) = 71 AND substr(request_digest, 1, 7) = 'sha256:'),
        request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json) = 'object'),
        result_digest TEXT NOT NULL CHECK(length(result_digest) = 71 AND substr(result_digest, 1, 7) = 'sha256:'),
        result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json) = 'object'),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, task_id, cache_entry_digest),
        UNIQUE (workspace_id, task_id, tool_kind, provider_id, provider_version, request_digest),
        FOREIGN KEY (workspace_id, task_id) REFERENCES translation_tool_configurations(workspace_id, task_id)
      ) STRICT;

      CREATE TRIGGER translation_tool_configurations_no_update BEFORE UPDATE ON translation_tool_configurations
      BEGIN SELECT RAISE(ABORT, 'translation tool configuration is immutable'); END;
      CREATE TRIGGER translation_tool_configurations_no_delete BEFORE DELETE ON translation_tool_configurations
      BEGIN SELECT RAISE(ABORT, 'translation tool configuration is immutable'); END;
      CREATE TRIGGER translation_calculation_receipts_no_update BEFORE UPDATE ON translation_calculation_receipts
      BEGIN SELECT RAISE(ABORT, 'translation calculation receipt is immutable'); END;
      CREATE TRIGGER translation_calculation_receipts_no_delete BEFORE DELETE ON translation_calculation_receipts
      BEGIN SELECT RAISE(ABORT, 'translation calculation receipt is immutable'); END;
      CREATE TRIGGER translation_reference_cache_entries_no_update BEFORE UPDATE ON translation_reference_cache_entries
      BEGIN SELECT RAISE(ABORT, 'translation reference cache entry is immutable'); END;
      CREATE TRIGGER translation_reference_cache_entries_no_delete BEFORE DELETE ON translation_reference_cache_entries
      BEGIN SELECT RAISE(ABORT, 'translation reference cache entry is immutable'); END;
    `,
  }),
]);

export function migrationChecksum(migration) {
  return createHash("sha256")
    .update(`${migration.version}\n${migration.name}\n${migration.sql}${migration.foreignKeysOff ? "\nforeign-keys-off" : ""}`, "utf8")
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
      if (migration.foreignKeysOff && database.pragma("foreign_key_check").length !== 0) {
        throw new Error(`migration ${migration.version} introduced foreign key violations`);
      }
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
    if (migration.foreignKeysOff) database.pragma("foreign_keys = OFF");
    try {
      apply();
    } finally {
      if (migration.foreignKeysOff) database.pragma("foreign_keys = ON");
    }
    inject(`after-commit-${migration.version}`);
  }

  const userVersion = database.pragma("user_version", { simple: true });
  if (userVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`expected schema ${CURRENT_SCHEMA_VERSION}, got ${userVersion}`);
  }
}
