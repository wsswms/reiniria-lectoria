import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { assertDatabaseIntegrity, databaseDiagnostics, openWorkspaceDatabase } from "../../src/db/connection.mjs";
import { CURRENT_SCHEMA_VERSION } from "../../src/db/migrations.mjs";
import { documentContract, segmentContract, sourceRevisionContract, stableJson, workspaceContract } from "../../src/domain/contracts.mjs";

function sha(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function insertFixture(database, ids) {
  database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)")
    .run(ids.workspace, ids.document, "Fixture", new Date(0).toISOString());
  database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)")
    .run(ids.workspace, ids.revision, ids.document, sha("original"), sha("normalized"), new Date(0).toISOString());
  database.prepare("INSERT INTO document_segments VALUES (?, ?, ?, ?)")
    .run(ids.workspace, ids.document, ids.segment, new Date(0).toISOString());
  database.prepare("INSERT INTO source_segment_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(ids.workspace, ids.document, ids.revision, ids.segment, "paragraph", "/0", "fixture", sha("fixture"), 0, 1, "[]", "initial");
}

test("twenty clean linux database lifecycles migrate, transact, roll back and reopen", async () => {
  for (let index = 0; index < 20; index += 1) {
    const root = await mkdtemp(join(tmpdir(), "lectoria-m2-1-"));
    const filename = join(root, "app.sqlite3");
    const ids = { workspace: randomUUID(), document: randomUUID(), revision: randomUUID(), segment: randomUUID() };
    try {
      let database = openWorkspaceDatabase(filename, { workspaceId: ids.workspace, now: () => new Date(0) });
      const diagnostics = assertDatabaseIntegrity(database);
      assert.equal(diagnostics.schemaVersion, CURRENT_SCHEMA_VERSION);
      assert.equal(diagnostics.foreignKeys, true);
      assert.equal(diagnostics.journalMode, "wal");

      database.transaction(() => insertFixture(database, ids))();
      assert.throws(() => database.transaction(() => {
        database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)")
          .run(ids.workspace, randomUUID(), "rollback", new Date(0).toISOString());
        throw new Error("forced rollback");
      })(), /forced rollback/);
      assert.equal(database.prepare("SELECT count(*) AS total FROM documents").get().total, 1);
      database.close();

      database = openWorkspaceDatabase(filename, { workspaceId: ids.workspace });
      assert.equal(database.prepare("SELECT count(*) AS total FROM source_segment_versions").get().total, 1);
      assertDatabaseIntegrity(database);
      database.close();
      assert.throws(() => openWorkspaceDatabase(filename, { workspaceId: randomUUID() }), /identity mismatch/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("database constraints reject foreign-key and uniqueness violations", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m2-1-constraints-"));
  const filename = join(root, "app.sqlite3");
  const workspace = randomUUID();
  const database = openWorkspaceDatabase(filename, { workspaceId: workspace });
  try {
    assert.throws(() => database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)")
      .run(workspace, randomUUID(), randomUUID(), sha("a"), sha("b"), new Date(0).toISOString()), /FOREIGN KEY/);
    const document = randomUUID();
    database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)").run(workspace, document, "one", new Date(0).toISOString());
    assert.throws(() => database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)")
      .run(workspace, document, "duplicate", new Date(0).toISOString()), /UNIQUE/);
    assert.throws(() => database.prepare("INSERT INTO workspace_meta(workspace_id, created_at) VALUES (?, ?)")
      .run(randomUUID(), new Date(0).toISOString()), /UNIQUE|CHECK/);
    assertDatabaseIntegrity(database);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("migration checksums detect schema history tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m2-1-migration-"));
  const filename = join(root, "app.sqlite3");
  const workspace = randomUUID();
  let database = openWorkspaceDatabase(filename, { workspaceId: workspace });
  database.close();
  database = new Database(filename);
  database.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("tampered");
  database.close();
  try {
    assert.throws(() => openWorkspaceDatabase(filename, { workspaceId: workspace }), /integrity mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("domain contract fixtures serialize deterministically", () => {
  const ids = { workspace: randomUUID(), document: randomUUID(), revision: randomUUID(), segment: randomUUID() };
  const contracts = [
    workspaceContract({ schemaVersion: 1, displayName: "Fixture", workspaceId: ids.workspace }),
    documentContract({ title: "Document", documentId: ids.document, workspaceId: ids.workspace }),
    sourceRevisionContract({ normalizedDigest: sha("n"), workspaceId: ids.workspace, sourceRevisionId: ids.revision, originalDigest: sha("o"), documentId: ids.document }),
    segmentContract({ protected: [], translatable: true, ordinal: 0, sourceDigest: sha("s"), sourceText: "Segment", structuralPath: "/0", kind: "paragraph", segmentId: ids.segment, sourceRevisionId: ids.revision, workspaceId: ids.workspace }),
  ];
  for (const contract of contracts) {
    const reversed = Object.fromEntries(Object.entries(contract).reverse());
    assert.equal(stableJson(contract), stableJson(reversed));
  }
  assert.throws(() => stableJson({ value: undefined }), /undefined/);
});

test("database diagnostics expose the selected engine invariants", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m2-1-diagnostics-"));
  const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId: randomUUID() });
  try {
    const diagnostics = databaseDiagnostics(database);
    assert.match(diagnostics.sqliteVersion, /^3\./);
    assert.equal(diagnostics.integrity, "ok");
    assert.equal(diagnostics.foreignKeyViolations, 0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
