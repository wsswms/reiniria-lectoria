import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { openWorkspaceDatabase } from "../../src/db/connection.mjs";
import { applyMigrations, CURRENT_SCHEMA_VERSION, MIGRATIONS, migrationChecksum } from "../../src/db/migrations.mjs";
import { DocumentImportService, ImportConflictError } from "../../src/document/import-service.mjs";
import { validFixtures } from "../fixtures/m3-2/corpus.mjs";

async function workspace(prefix, options = {}) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  for (const path of ["private/objects", "private/ledger", "derived", "staging"]) await mkdir(join(root, path), { recursive: true });
  const workspaceId = randomUUID();
  const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId });
  const service = new DocumentImportService({ database, root, trustedWorkspaceId: workspaceId, now: () => new Date(0), ...options });
  return { root, workspaceId, database, service, close: async () => { database.close(); await rm(root, { recursive: true, force: true }); } };
}

test("raw snapshots remain immutable while sanitized HTML requires user confirmation", async () => {
  const fixture = await workspace("lectoria-m3-2-import-");
  const raw = '<article><p onclick="alert(1)">Visible</p><script>secret()</script><a href="javascript:bad()">link</a></article>';
  try {
    const imported = await fixture.service.import({ format: "html", content: raw, title: "Unsafe fixture" });
    assert.equal(imported.requiresConfirmation, true);
    assert.equal(imported.confirmed, false);
    assert.deepEqual(imported.diagnostics.map((finding) => finding.code).sort(), [
      "HTML_ACTIVE_TAG_REMOVED", "HTML_EVENT_HANDLER_REMOVED", "HTML_EXECUTABLE_URL_REMOVED",
    ]);
    const record = fixture.database.prepare("SELECT raw_object_id AS objectId, normalized_text AS normalized FROM document_imports WHERE import_id = ?").get(imported.importId);
    const object = fixture.database.prepare("SELECT relative_path AS relativePath FROM committed_objects WHERE object_id = ?").get(record.objectId);
    assert.equal((await readFile(join(fixture.root, ...object.relativePath.split("/")), "utf8")), raw);
    assert.equal(/script|onclick|javascript:/i.test(record.normalized), false);
    assert.throws(() => fixture.service.confirm(imported.importId, { type: "system", id: "system" }), /user actor/);
    assert.equal(fixture.service.confirm(imported.importId, { type: "user", id: "reviewer" }).confirmed, true);
    assert.throws(() => fixture.service.confirm(imported.importId, { type: "user", id: "reviewer" }), ImportConflictError);
    assert.throws(() => fixture.database.prepare("UPDATE document_imports SET normalized_text = 'tampered'").run(), /immutable/);
  } finally { await fixture.close(); }
});

test("all import failure points expose no partial document graph", async () => {
  const points = [
    "after-normalize", "object:after-temp", "object:after-rename", "object:after-db-insert",
    "object:after-db-commit", "after-snapshot", "after-import-record", "after-segment", "before-import-commit",
  ];
  for (const point of points) for (let attempt = 0; attempt < 10; attempt += 1) {
    const fixture = await workspace("lectoria-m3-2-fault-", { inject(current) { if (current === point) throw new Error(`injected ${point}`); } });
    try {
      await assert.rejects(fixture.service.import({ format: "markdown", content: "# Title\n\nBody.", title: "Fault" }), /injected/);
      for (const table of ["documents", "source_revisions", "document_imports", "document_segments", "source_segment_versions", "import_diagnostics"]) {
        assert.equal(fixture.database.prepare(`SELECT count(*) AS total FROM ${table}`).get().total, 0, `${point}:${table}`);
      }
      assert.equal(fixture.database.pragma("foreign_key_check").length, 0);
    } finally { await fixture.close(); }
  }
});

test("trusted workspace scope hides imports and reuses identical raw snapshots safely", async () => {
  const first = await workspace("lectoria-m3-2-scope-a-");
  const second = await workspace("lectoria-m3-2-scope-b-");
  try {
    const source = "First paragraph.\n\nSecond paragraph.";
    const one = await first.service.import({ format: "text", content: source, title: "One" });
    const two = await first.service.import({ format: "text", content: source, title: "Two" });
    assert.notEqual(one.documentId, two.documentId);
    assert.equal(first.database.prepare("SELECT count(*) AS total FROM committed_objects").get().total, 1);
    assert.equal(first.database.prepare("SELECT count(*) AS total FROM document_imports").get().total, 2);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      assert.throws(() => second.service.get(one.importId, first.workspaceId), ImportConflictError);
    }
  } finally {
    await first.close();
    await second.close();
  }
});

test("all thirty-six valid fixtures preserve exact raw snapshots and complete import graphs", async () => {
  const fixture = await workspace("lectoria-m3-2-corpus-");
  try {
    for (const source of validFixtures) {
      const imported = await fixture.service.import({ format: source.format, content: source.content, title: source.id });
      const record = fixture.database.prepare(`
        SELECT raw_object_id AS rawObjectId, normalized_digest AS normalizedDigest
        FROM document_imports WHERE import_id = ?
      `).get(imported.importId);
      assert.equal((await fixture.service.objects.read(record.rawObjectId)).equals(Buffer.from(source.content)), true, source.id);
      assert.equal(record.normalizedDigest, imported.normalizedDigest, source.id);
      assert.ok(fixture.database.prepare("SELECT count(*) AS total FROM source_segment_versions WHERE source_revision_id = ?").get(imported.sourceRevisionId).total > 0, source.id);
    }
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM documents").get().total, 36);
    assert.equal(fixture.database.pragma("foreign_key_check").length, 0);
  } finally { await fixture.close(); }
});

test("schema 7 migration fault points leave only retryable v6 or complete v7", async () => {
  for (const point of ["before-migration-7", "after-sql-7", "after-commit-7"]) for (let attempt = 0; attempt < 10; attempt += 1) {
    const root = await mkdtemp(join(tmpdir(), "lectoria-m3-2-migration-"));
    const filename = join(root, "app.sqlite3");
    const workspaceId = randomUUID();
    const database = new Database(filename);
    database.pragma("foreign_keys = ON");
    database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;");
    for (const migration of MIGRATIONS.filter((item) => item.version <= 6)) {
      database.exec(migration.sql);
      database.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)").run(migration.version, migration.name, migrationChecksum(migration), new Date(0).toISOString());
      database.pragma(`user_version = ${migration.version}`);
    }
    database.prepare("INSERT INTO workspace_meta VALUES (1, ?, ?)").run(workspaceId, new Date(0).toISOString());
    try {
      assert.throws(() => applyMigrations(database, { inject(current) { if (current === point) throw new Error(`injected ${point}`); } }), /injected/);
      const version = database.pragma("user_version", { simple: true });
      assert.ok([6, 7].includes(version));
      assert.equal(database.prepare("SELECT count(*) AS total FROM sqlite_master WHERE type='table' AND name='document_imports'").get().total, version === 7 ? 1 : 0);
    } finally { database.close(); }
    const reopened = openWorkspaceDatabase(filename, { workspaceId });
    assert.equal(reopened.pragma("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
    assert.equal(reopened.prepare("SELECT count(*) AS total FROM document_imports").get().total, 0);
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});
