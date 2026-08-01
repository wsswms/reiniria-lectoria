import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { assertDatabaseIntegrity, openWorkspaceDatabase } from "../../src/db/connection.mjs";
import { applyMigrations, CURRENT_SCHEMA_VERSION, MIGRATIONS, migrationChecksum } from "../../src/db/migrations.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const timestamp = new Date(0).toISOString();

function createHistorical(filename, version, { ambiguousWorkflow = false } = {}) {
  const ids = {
    workspaceId: randomUUID(),
    documentId: randomUUID(),
    sourceRevisionId: randomUUID(),
    secondRevisionId: randomUUID(),
    segmentId: randomUUID(),
    packageId: randomUUID(),
  };
  const database = new Database(filename);
  database.pragma("foreign_keys = ON");
  database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;");
  for (const migration of MIGRATIONS.filter((item) => item.version <= version)) {
    database.exec(migration.sql);
    database.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)")
      .run(migration.version, migration.name, migrationChecksum(migration), timestamp);
    database.pragma(`user_version = ${migration.version}`);
  }
  database.prepare("INSERT INTO workspace_meta VALUES (1, ?, ?)").run(ids.workspaceId, timestamp);
  database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)").run(ids.workspaceId, ids.documentId, "Historical", timestamp);
  database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)")
    .run(ids.workspaceId, ids.sourceRevisionId, ids.documentId, sha("original"), sha("normalized"), timestamp);
  database.prepare("INSERT INTO segments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(ids.workspaceId, ids.segmentId, ids.sourceRevisionId, "paragraph", "/0", "historical text", sha("historical text"), 0, 1, '[{"kind":"code","value":"x"}]');
  if (version >= 3) {
    database.prepare("INSERT INTO canonical_import_origins VALUES (?, ?, ?, ?, ?, ?)")
      .run(ids.workspaceId, ids.segmentId, ids.documentId, ids.sourceRevisionId, ids.packageId, "origin-0");
    database.prepare("INSERT INTO working_translations VALUES (?, ?, ?, ?, ?, ?)")
      .run(ids.workspaceId, ids.documentId, 7, "editing", '{"text":"legacy target"}', timestamp);
    if (ambiguousWorkflow) {
      database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)")
        .run(ids.workspaceId, ids.secondRevisionId, ids.documentId, sha("second-original"), sha("second-normalized"), timestamp);
    }
  }
  return { database, ids };
}

function factSummary(database) {
  return {
    documents: database.prepare("SELECT document_id, title FROM documents ORDER BY document_id").all(),
    revisions: database.prepare("SELECT source_revision_id, document_id, original_digest, normalized_digest FROM source_revisions ORDER BY source_revision_id").all(),
    stableSegments: database.prepare("SELECT document_id, segment_id FROM document_segments ORDER BY segment_id").all(),
    segmentVersions: database.prepare("SELECT document_id, source_revision_id, segment_id, kind, structural_path, source_text, source_digest, ordinal, translatable, protected_json, alignment_status FROM source_segment_versions ORDER BY source_revision_id, segment_id").all(),
    origins: database.prepare("SELECT document_id, source_revision_id, segment_id, origin_package_id, origin_segment_ref FROM canonical_import_origins ORDER BY origin_segment_ref").all(),
    workflows: database.prepare("SELECT workflow_id, document_id, source_revision_id, target_language, version, state, legacy_content_json, origin_type, updated_at FROM translation_workflows ORDER BY workflow_id").all(),
  };
}

test("schema v1 through v5 migrate ten times without losing historical facts", async () => {
  for (let version = 1; version <= 5; version += 1) {
    let expected;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const root = await mkdtemp(join(tmpdir(), `lectoria-m3-1-v${version}-`));
      const filename = join(root, "app.sqlite3");
      const { database: historical, ids } = createHistorical(filename, version);
      historical.close();
      const database = openWorkspaceDatabase(filename, { workspaceId: ids.workspaceId });
      try {
        assert.equal(database.pragma("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
        assertDatabaseIntegrity(database);
        const summary = factSummary(database);
        assert.equal(summary.documents.length, 1);
        assert.equal(summary.revisions.length, 1);
        assert.equal(summary.stableSegments.length, 1);
        assert.equal(summary.segmentVersions.length, 1);
        assert.equal(summary.segmentVersions[0].source_text, "historical text");
        assert.equal(summary.segmentVersions[0].alignment_status, "initial");
        assert.equal(summary.origins.length, version >= 3 ? 1 : 0);
        assert.equal(summary.workflows.length, version >= 3 ? 1 : 0);
        if (version >= 3) {
          assert.equal(summary.workflows[0].target_language, "und");
          assert.equal(summary.workflows[0].version, 7);
          assert.equal(summary.workflows[0].state, "editing");
          assert.equal(summary.workflows[0].legacy_content_json, '{"text":"legacy target"}');
        }
        const normalized = JSON.stringify(summary, (key, value) => key.endsWith("_id") || key.endsWith("Id") ? "<id>" : value);
        expected ??= normalized;
        assert.equal(normalized, expected);
      } finally {
        database.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});

test("migration 6 fault points leave only retryable v5 or complete v6", async () => {
  for (const point of ["before-migration-6", "after-sql-6", "after-commit-6"]) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const root = await mkdtemp(join(tmpdir(), "lectoria-m3-1-fault-"));
      const filename = join(root, "app.sqlite3");
      const { database, ids } = createHistorical(filename, 5);
      try {
        assert.throws(() => applyMigrations(database, { inject(current) { if (current === point) throw new Error(`injected ${point}`); } }), /injected/);
        const version = database.pragma("user_version", { simple: true });
        assert.ok([5, 6].includes(version));
        assert.equal(database.prepare("SELECT count(*) AS total FROM sqlite_master WHERE type='table' AND name='source_segment_versions'").get().total, version === 6 ? 1 : 0);
        if (version === 5) assert.equal(database.prepare("SELECT count(*) AS total FROM segments").get().total, 1);
        else assert.equal(factSummary(database).segmentVersions.length, 1);
      } finally {
        database.close();
      }
      const reopened = openWorkspaceDatabase(filename, { workspaceId: ids.workspaceId });
      assert.equal(reopened.pragma("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
      assert.equal(factSummary(reopened).segmentVersions.length, 1);
      assertDatabaseIntegrity(reopened);
      reopened.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("ambiguous legacy workflow migration fails closed and preserves v5", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m3-1-ambiguous-"));
  const filename = join(root, "app.sqlite3");
  const { database } = createHistorical(filename, 5, { ambiguousWorkflow: true });
  try {
    assert.throws(() => applyMigrations(database), /CHECK constraint failed/);
    assert.equal(database.pragma("user_version", { simple: true }), 5);
    assert.equal(database.prepare("SELECT count(*) AS total FROM working_translations").get().total, 1);
    assert.equal(database.prepare("SELECT count(*) AS total FROM segments").get().total, 1);
    assert.equal(database.prepare("SELECT count(*) AS total FROM sqlite_master WHERE type='table' AND name='translation_workflows'").get().total, 0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
