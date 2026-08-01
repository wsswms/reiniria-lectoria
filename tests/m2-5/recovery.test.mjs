import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { assertDatabaseIntegrity, openWorkspaceDatabase } from "../../src/db/connection.mjs";
import { applyMigrations, CURRENT_SCHEMA_VERSION, MIGRATIONS, migrationChecksum } from "../../src/db/migrations.mjs";
import { createWorkspaceBackup, restoreWorkspaceBackup, validateWorkspaceBackup } from "../../src/storage/backup.mjs";
import { ObjectStore } from "../../src/storage/object-store.mjs";
import { WorkspaceManager } from "../../src/workspace/manager.mjs";

function createHistorical(filename, version, workspaceId, documentCount = 2) {
  const database = new Database(filename);
  database.pragma("foreign_keys = ON");
  database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;");
  for (const migration of MIGRATIONS.filter((item) => item.version <= version)) {
    database.exec(migration.sql);
    database.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)").run(migration.version, migration.name, migrationChecksum(migration), new Date(0).toISOString());
    database.pragma(`user_version = ${migration.version}`);
  }
  database.prepare("INSERT INTO workspace_meta(workspace_id, created_at) VALUES (?, ?)").run(workspaceId, new Date(0).toISOString());
  for (let index = 0; index < documentCount; index += 1) database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)").run(workspaceId, randomUUID(), `Document ${index}`, new Date(0).toISOString());
  return database;
}

test("two historical schemas migrate ten times to identical current facts", async () => {
  for (const version of [3, 4]) for (let attempt = 0; attempt < 10; attempt += 1) {
    const root = await mkdtemp(join(tmpdir(), "lectoria-m2-5-migrate-"));
    const workspaceId = randomUUID();
    createHistorical(join(root, "app.sqlite3"), version, workspaceId).close();
    const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId });
    try {
      assert.equal(database.pragma("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
      assert.equal(database.prepare("SELECT document_count AS total FROM workspace_summary").get().total, 2);
      assertDatabaseIntegrity(database);
      applyMigrations(database);
      assert.equal(database.prepare("SELECT count(*) AS total FROM schema_migrations").get().total, CURRENT_SCHEMA_VERSION);
    } finally { database.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("migration fault points produce only retryable old or complete new schemas", async () => {
  for (const point of ["before-migration-5", "after-sql-5", "after-commit-5"]) for (let attempt = 0; attempt < 10; attempt += 1) {
    const root = await mkdtemp(join(tmpdir(), "lectoria-m2-5-migrate-fault-"));
    const filename = join(root, "app.sqlite3");
    const workspaceId = randomUUID();
    const database = createHistorical(filename, 4, workspaceId);
    try {
      assert.throws(() => applyMigrations(database, { inject(current) { if (current === point) throw new Error(`injected ${point}`); } }), /injected/);
      const version = database.pragma("user_version", { simple: true });
      assert.ok([4, 5].includes(version));
      assert.equal(database.prepare("SELECT count(*) AS total FROM sqlite_master WHERE type='table' AND name='workspace_summary'").get().total, version === 5 ? 1 : 0);
    } finally { database.close(); }
    const reopened = openWorkspaceDatabase(filename, { workspaceId });
    assert.equal(reopened.pragma("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
    assertDatabaseIntegrity(reopened);
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("three workspaces each complete ten consistent backup and restore rounds including WAL", async () => {
  for (let workspaceIndex = 0; workspaceIndex < 3; workspaceIndex += 1) {
    const sourceRoot = await mkdtemp(join(tmpdir(), "lectoria-m2-5-source-"));
    const sourceManager = await WorkspaceManager.create(sourceRoot);
    try {
      const record = await sourceManager.createWorkspace(`Source ${workspaceIndex}`);
      const handle = sourceManager.open(record.workspaceId);
      const documentId = randomUUID();
      handle.database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)").run(record.workspaceId, documentId, "WAL fact", new Date(0).toISOString());
      handle.database.prepare("INSERT INTO domain_audit_events(workspace_id,event_id,entity_type,entity_id,action,actor_type,actor_id,succeeded,details_json,occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(record.workspaceId, randomUUID(), "document", documentId, "created", "user", "fixture", 1, "{}", new Date(0).toISOString());
      const object = await new ObjectStore(handle.root, handle.database, record.workspaceId).commit(`workspace-${workspaceIndex}`);
      for (let round = 0; round < 10; round += 1) {
        const backup = join(sourceRoot, `backup-${round}`);
        await createWorkspaceBackup({ database: handle.database, workspaceRoot: handle.root, destination: backup });
        const targetRoot = await mkdtemp(join(tmpdir(), "lectoria-m2-5-target-"));
        const targetManager = await WorkspaceManager.create(targetRoot);
        try {
          const restored = await restoreWorkspaceBackup({ backupRoot: backup, manager: targetManager });
          assert.equal(restored.workspaceId, record.workspaceId);
          const restoredHandle = targetManager.open(record.workspaceId);
          assert.equal(restoredHandle.database.prepare("SELECT count(*) AS total FROM documents").get().total, 1);
          assert.equal(restoredHandle.database.prepare("SELECT count(*) AS total FROM domain_audit_events").get().total, 1);
          assert.equal((await new ObjectStore(restoredHandle.root, restoredHandle.database, record.workspaceId).read(object.objectId)).toString(), `workspace-${workspaceIndex}`);
          assertDatabaseIntegrity(restoredHandle.database);
          restoredHandle.database.close();
        } finally { targetManager.close(); await rm(targetRoot, { recursive: true, force: true }); }
      }
      handle.database.close();
    } finally { sourceManager.close(); await rm(sourceRoot, { recursive: true, force: true }); }
  }
});

test("all manifest, object, database and conflict corruptions reject before activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m2-5-corrupt-"));
  const manager = await WorkspaceManager.create(join(root, "source"));
  try {
    const record = await manager.createWorkspace("Source");
    const handle = manager.open(record.workspaceId);
    const object = await new ObjectStore(handle.root, handle.database, record.workspaceId).commit("backup-object");
    const backup = join(root, "backup");
    await createWorkspaceBackup({ database: handle.database, workspaceRoot: handle.root, destination: backup });
    handle.database.close();
    const cases = ["missing-object", "extra-object", "tampered-object", "manifest", "schema", "database"];
    for (const name of cases) {
      const damaged = join(root, `damaged-${name}`);
      await cp(backup, damaged, { recursive: true });
      if (name === "missing-object") await rm(join(damaged, "objects", object.digest.slice(7)));
      if (name === "extra-object") await writeFile(join(damaged, "objects", "extra"), "extra");
      if (name === "tampered-object") await writeFile(join(damaged, "objects", object.digest.slice(7)), "tampered");
      if (["manifest", "schema"].includes(name)) {
        const manifest = JSON.parse(await readFile(join(damaged, "manifest.json"), "utf8"));
        if (name === "manifest") manifest.workspace_id = randomUUID(); else manifest.schema_version = 999;
        await writeFile(join(damaged, "manifest.json"), JSON.stringify(manifest));
      }
      if (name === "database") await writeFile(join(damaged, "database.sqlite3"), "not sqlite");
      await assert.rejects(validateWorkspaceBackup(damaged), /backup validation failed|file is not a database/);
    }
    const targetRoot = await mkdtemp(join(tmpdir(), "lectoria-m2-5-conflict-"));
    const target = await WorkspaceManager.create(targetRoot);
    try {
      target.registry.insert({ workspaceId: record.workspaceId, displayName: "Conflict", rootKey: record.workspaceId, state: "active", schemaVersion: 5, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
      await assert.rejects(restoreWorkspaceBackup({ backupRoot: backup, manager: target }), /conflict/);
      assert.equal(target.registry.list().length, 1);
    } finally { target.close(); await rm(targetRoot, { recursive: true, force: true }); }
    const rootConflict = await mkdtemp(join(tmpdir(), "lectoria-m2-5-root-conflict-"));
    const rootConflictManager = await WorkspaceManager.create(rootConflict);
    try {
      const occupied = join(rootConflict, "workspaces", record.workspaceId);
      await mkdir(occupied, { recursive: true });
      await writeFile(join(occupied, "sentinel"), "preserve");
      await assert.rejects(restoreWorkspaceBackup({ backupRoot: backup, manager: rootConflictManager }), /conflict/);
      assert.equal(await readFile(join(occupied, "sentinel"), "utf8"), "preserve");
      assert.equal(rootConflictManager.registry.list().length, 0);
    } finally { rootConflictManager.close(); await rm(rootConflict, { recursive: true, force: true }); }
    const backupFiles = await readdir(backup);
    assert.equal(backupFiles.includes("derived"), false);
    assert.equal(backupFiles.includes("staging"), false);
    assert.equal(backupFiles.includes("private"), false);
  } finally { manager.close(); await rm(root, { recursive: true, force: true }); }
});
