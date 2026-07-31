import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { openWorkspaceDatabase } from "../../src/db/connection.mjs";
import { applyMigrations, CURRENT_SCHEMA_VERSION, MIGRATIONS, migrationChecksum } from "../../src/db/migrations.mjs";
import { DocumentImportService } from "../../src/document/import-service.mjs";
import { ReimportConflictError, ReimportService } from "../../src/document/reimport-service.mjs";
import { normalizeDocument } from "../../src/document/parser.mjs";
import { DomainStateService } from "../../src/domain/state-service.mjs";

async function workspace(prefix, reimportOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  for (const path of ["private/objects", "private/ledger", "derived", "staging"]) await mkdir(join(root, path), { recursive: true });
  const workspaceId = randomUUID();
  const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId });
  const options = { database, root, trustedWorkspaceId: workspaceId, now: () => new Date(0) };
  return {
    root, workspaceId, database,
    imports: new DocumentImportService(options),
    reimports: new ReimportService({ ...options, ...reimportOptions }),
    states: new DomainStateService(database, workspaceId, { now: () => new Date(0) }),
    close: async () => { database.close(); await rm(root, { recursive: true, force: true }); },
  };
}

async function confirmedBase(fixture, content = "First stable paragraph.\n\nSecond original paragraph.") {
  const imported = await fixture.imports.import({ format: "text", content, title: "Fixture" });
  fixture.imports.confirm(imported.importId, { type: "user", id: "owner" });
  return imported;
}

test("finalized reimport reuses only proven identities and propagates stale impacts", async () => {
  const fixture = await workspace("lectoria-m3-3-finalize-");
  try {
    const base = await confirmedBase(fixture);
    const old = fixture.database.prepare("SELECT segment_id AS segmentId FROM source_segment_versions WHERE source_revision_id = ? ORDER BY ordinal").all(base.sourceRevisionId);
    const workflowId = randomUUID();
    fixture.states.create({ workflowId, documentId: base.documentId, sourceRevisionId: base.sourceRevisionId, targetLanguage: "en" }, {}, "human-reviewed");
    const operation = await fixture.reimports.prepare({
      documentId: base.documentId,
      baseRevisionId: base.sourceRevisionId,
      format: "text",
      content: "First stable paragraph.\n\nSecond original paragraph updated.\n\nNew paragraph.",
    });
    assert.deepEqual(operation.candidates.map((candidate) => candidate.status), ["unchanged", "changed", "inserted"]);
    assert.throws(() => fixture.reimports.confirmSemanticUnchanged(operation.operationId, 0, 1, { type: "system", id: "worker" }), /user actor/);
    const confirmed = fixture.reimports.confirmSemanticUnchanged(operation.operationId, 0, 1, { type: "user", id: "reviewer" });
    const finalized = fixture.reimports.finalize(operation.operationId, confirmed.version);
    assert.equal(finalized.status, "finalized");
    const next = fixture.database.prepare("SELECT segment_id AS segmentId FROM source_segment_versions WHERE source_revision_id = ? ORDER BY ordinal").all(finalized.newRevisionId);
    assert.deepEqual(next.slice(0, 2), old);
    assert.notEqual(next[2].segmentId, old[0].segmentId);
    assert.deepEqual(fixture.database.prepare("SELECT change_kind AS kind FROM source_revision_impacts WHERE to_revision_id = ? ORDER BY kind").all(finalized.newRevisionId), [{ kind: "changed" }, { kind: "inserted" }]);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM reimport_semantic_confirmations WHERE operation_id = ?").get(operation.operationId).total, 1);
    const changedImpact = fixture.database.prepare("SELECT details_json AS details FROM source_revision_impacts WHERE to_revision_id = ? AND change_kind = 'changed'").get(finalized.newRevisionId);
    assert.equal(JSON.parse(changedImpact.details).semanticUnchangedConfirmed, true);
    assert.equal(fixture.states.get(workflowId).state, "stale");
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM domain_audit_events WHERE action = 'source-revision-stale'").get().total, 1);
  } finally { await fixture.close(); }
});

test("unchanged reimport preserves segment identity and reviewed workflow history", async () => {
  const fixture = await workspace("lectoria-m3-3-unchanged-");
  try {
    const content = "First stable paragraph.\n\nSecond original paragraph.";
    const base = await confirmedBase(fixture, content);
    const original = fixture.database.prepare("SELECT segment_id AS segmentId, source_text AS sourceText FROM source_segment_versions WHERE source_revision_id = ? ORDER BY ordinal").all(base.sourceRevisionId);
    const workflowId = randomUUID();
    fixture.states.create({ workflowId, documentId: base.documentId, sourceRevisionId: base.sourceRevisionId, targetLanguage: "en" }, {}, "human-reviewed");
    await assert.rejects(
      fixture.reimports.prepare({ documentId: base.documentId, baseRevisionId: base.sourceRevisionId, format: "text", content }),
      ReimportConflictError,
    );
    const operation = await fixture.reimports.prepare({ documentId: base.documentId, baseRevisionId: base.sourceRevisionId, format: "text", content: content.replaceAll("\n", "\r\n") });
    const finalized = fixture.reimports.finalize(operation.operationId, operation.version);
    const next = fixture.database.prepare("SELECT segment_id AS segmentId, source_text AS sourceText FROM source_segment_versions WHERE source_revision_id = ? ORDER BY ordinal").all(finalized.newRevisionId);
    assert.deepEqual(next, original);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM source_revision_impacts WHERE to_revision_id = ?").get(finalized.newRevisionId).total, 0);
    assert.equal(fixture.states.get(workflowId).state, "human-reviewed");
  } finally { await fixture.close(); }
});

test("deletion preserves the old revision and marks dependent work stale", async () => {
  const fixture = await workspace("lectoria-m3-3-delete-");
  try {
    const base = await confirmedBase(fixture);
    const old = fixture.database.prepare("SELECT segment_id AS segmentId FROM source_segment_versions WHERE source_revision_id = ? ORDER BY ordinal").all(base.sourceRevisionId);
    const workflowId = randomUUID();
    fixture.states.create({ workflowId, documentId: base.documentId, sourceRevisionId: base.sourceRevisionId, targetLanguage: "en" }, {}, "approved-for-export");
    const operation = await fixture.reimports.prepare({ documentId: base.documentId, baseRevisionId: base.sourceRevisionId, format: "text", content: "First stable paragraph." });
    const finalized = fixture.reimports.finalize(operation.operationId, operation.version);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM source_segment_versions WHERE source_revision_id = ? AND segment_id = ?").get(finalized.newRevisionId, old[1].segmentId).total, 0);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM source_segment_versions WHERE source_revision_id = ? AND segment_id = ?").get(base.sourceRevisionId, old[1].segmentId).total, 1);
    assert.deepEqual(fixture.database.prepare("SELECT change_kind AS kind, stale_required AS stale FROM source_revision_impacts WHERE to_revision_id = ?").all(finalized.newRevisionId), [{ kind: "deleted", stale: 1 }]);
    assert.equal(fixture.states.get(workflowId).state, "stale");
  } finally { await fixture.close(); }
});

test("parser version changes stale otherwise unchanged segments", async () => {
  const fixture = await workspace("lectoria-m3-3-parser-");
  try {
    const base = await confirmedBase(fixture);
    const workflowId = randomUUID();
    fixture.states.create({ workflowId, documentId: base.documentId, sourceRevisionId: base.sourceRevisionId, targetLanguage: "en" }, {}, "human-reviewed");
    const reimports = new ReimportService({
      database: fixture.database,
      root: fixture.root,
      trustedWorkspaceId: fixture.workspaceId,
      now: () => new Date(0),
      normalize(format, content, options) {
        return { ...normalizeDocument(format, content, options), parserVersion: "lectoria-parser-v2-test" };
      },
    });
    const operation = await reimports.prepare({ documentId: base.documentId, baseRevisionId: base.sourceRevisionId, format: "text", content: "First stable paragraph.\n\nSecond original paragraph." });
    const finalized = reimports.finalize(operation.operationId, operation.version);
    const impacts = fixture.database.prepare("SELECT change_kind AS kind, stale_required AS stale FROM source_revision_impacts WHERE to_revision_id = ? ORDER BY segment_id").all(finalized.newRevisionId);
    assert.equal(impacts.length, 2);
    assert.ok(impacts.every((impact) => impact.kind === "parser-changed" && impact.stale === 1));
    assert.equal(fixture.states.get(workflowId).state, "stale");
  } finally { await fixture.close(); }
});

test("finalization failure exposes no partial revision, impact or stale state", async () => {
  const fixture = await workspace("lectoria-m3-3-finalize-fault-", {
    inject(point) { if (point === "before-finalize-commit") throw new Error("injected finalize failure"); },
  });
  try {
    const base = await confirmedBase(fixture);
    const workflowId = randomUUID();
    fixture.states.create({ workflowId, documentId: base.documentId, sourceRevisionId: base.sourceRevisionId, targetLanguage: "en" }, {}, "human-reviewed");
    const operation = await fixture.reimports.prepare({
      documentId: base.documentId,
      baseRevisionId: base.sourceRevisionId,
      format: "text",
      content: "First stable paragraph changed.\n\nSecond original paragraph.",
    });
    assert.throws(() => fixture.reimports.finalize(operation.operationId, operation.version), /injected finalize failure/);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM source_revisions WHERE source_revision_id = ?").get(operation.newRevisionId).total, 0);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM source_revision_impacts WHERE to_revision_id = ?").get(operation.newRevisionId).total, 0);
    assert.equal(fixture.reimports.get(operation.operationId).status, "pending");
    assert.equal(fixture.states.get(workflowId).state, "human-reviewed");
  } finally { await fixture.close(); }
});

test("ambiguous split requires explicit user decisions with CAS", async () => {
  const fixture = await workspace("lectoria-m3-3-confirm-");
  try {
    const base = await confirmedBase(fixture, "First part second part");
    const oldSegmentId = fixture.database.prepare("SELECT segment_id AS id FROM source_segment_versions WHERE source_revision_id = ?").get(base.sourceRevisionId).id;
    const operation = await fixture.reimports.prepare({ documentId: base.documentId, baseRevisionId: base.sourceRevisionId, format: "text", content: "First part\n\nsecond part" });
    assert.deepEqual(operation.candidates.map((candidate) => candidate.status), ["ambiguous", "ambiguous"]);
    assert.throws(() => fixture.reimports.finalize(operation.operationId, 0), /ambiguous/);
    const attempts = await Promise.all(Array.from({ length: 100 }, async (_, index) => {
      try {
        fixture.reimports.confirmAlignment(operation.operationId, 0, 0, oldSegmentId, { type: "user", id: `user-${index}` });
        return "success";
      } catch (error) {
        assert.ok(error instanceof ReimportConflictError, `${error?.name}: ${error?.message}`);
        return "conflict";
      }
    }));
    assert.equal(attempts.filter((result) => result === "success").length, 1);
    assert.equal(attempts.filter((result) => result === "conflict").length, 99);
    assert.throws(() => fixture.reimports.confirmAlignment(operation.operationId, 1, 1, oldSegmentId, { type: "user", id: "owner" }), /already assigned/);
    const confirmed = fixture.reimports.confirmAlignment(operation.operationId, 1, 1, null, { type: "user", id: "owner" });
    const finalized = fixture.reimports.finalize(operation.operationId, confirmed.version);
    const ids = fixture.database.prepare("SELECT segment_id AS id FROM source_segment_versions WHERE source_revision_id = ? ORDER BY ordinal").all(finalized.newRevisionId);
    assert.equal(ids[0].id, oldSegmentId);
    assert.notEqual(ids[1].id, oldSegmentId);
  } finally { await fixture.close(); }
});

test("one hundred concurrent prepares allow one pending operation and preserve scope", async () => {
  const first = await workspace("lectoria-m3-3-race-a-");
  const second = await workspace("lectoria-m3-3-race-b-");
  try {
    const base = await confirmedBase(first);
    const attempts = await Promise.all(Array.from({ length: 100 }, async (_, index) => {
      try {
        const result = await first.reimports.prepare({
          documentId: base.documentId,
          baseRevisionId: base.sourceRevisionId,
          format: "text",
          content: `First stable paragraph.\n\nWriter ${index}.`,
        });
        return { status: "success", result };
      } catch (error) {
        assert.ok(error instanceof ReimportConflictError, `${error?.name}: ${error?.message}`);
        return { status: "conflict" };
      }
    }));
    const successes = attempts.filter((attempt) => attempt.status === "success");
    assert.equal(successes.length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "conflict").length, 99);
    assert.equal(first.database.prepare("SELECT count(*) AS total FROM reimport_operations WHERE status = 'pending'").get().total, 1);
    for (let attempt = 0; attempt < 100; attempt += 1) assert.throws(() => second.reimports.get(successes[0].result.operationId, first.workspaceId), ReimportConflictError);
  } finally {
    await first.close();
    await second.close();
  }
});

test("schema 8 migration fault points leave only retryable v7 or complete v8", async () => {
  for (const point of ["before-migration-8", "after-sql-8", "after-commit-8"]) for (let attempt = 0; attempt < 10; attempt += 1) {
    const root = await mkdtemp(join(tmpdir(), "lectoria-m3-3-migration-"));
    const filename = join(root, "app.sqlite3");
    const workspaceId = randomUUID();
    const database = new Database(filename);
    database.pragma("foreign_keys = ON");
    database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;");
    for (const migration of MIGRATIONS.filter((item) => item.version <= 7)) {
      database.exec(migration.sql);
      database.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)").run(migration.version, migration.name, migrationChecksum(migration), new Date(0).toISOString());
      database.pragma(`user_version = ${migration.version}`);
    }
    database.prepare("INSERT INTO workspace_meta VALUES (1, ?, ?)").run(workspaceId, new Date(0).toISOString());
    try {
      assert.throws(() => applyMigrations(database, { inject(current) { if (current === point) throw new Error(`injected ${point}`); } }), /injected/);
      const version = database.pragma("user_version", { simple: true });
      assert.ok([7, 8].includes(version));
      assert.equal(database.prepare("SELECT count(*) AS total FROM sqlite_master WHERE type='table' AND name='reimport_operations'").get().total, version === 8 ? 1 : 0);
    } finally { database.close(); }
    const reopened = openWorkspaceDatabase(filename, { workspaceId });
    assert.equal(reopened.pragma("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
    assert.equal(reopened.prepare("SELECT count(*) AS total FROM reimport_operations").get().total, 0);
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});
