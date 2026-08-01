import { createHash } from "node:crypto";

export const CURRENT_SCHEMA_VERSION = 15;

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
