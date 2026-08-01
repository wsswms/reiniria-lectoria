import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResourceNotFoundError } from "../../src/workspace/errors.mjs";
import { WorkspaceManager } from "../../src/workspace/manager.mjs";

const FIXTURE_CANARIES = ["fixture-body-secret", "object-payload-secret", "term-secret", "search-text-secret"];
const RESOURCE_CLASSES = ["objects", "documents", "revisions", "segments", "tasks", "idempotency", "cache", "derived", "audit"];

function sha(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }

function seedStructured(handle, ids) {
  handle.database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)")
    .run(handle.record.workspaceId, ids.documents, "Fixture", new Date(0).toISOString());
  handle.database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)")
    .run(handle.record.workspaceId, ids.revisions, ids.documents, sha("o"), sha("n"), new Date(0).toISOString());
  handle.database.prepare("INSERT INTO document_segments VALUES (?, ?, ?, ?)")
    .run(handle.record.workspaceId, ids.documents, ids.segments, new Date(0).toISOString());
  handle.database.prepare("INSERT INTO source_segment_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(handle.record.workspaceId, ids.documents, ids.revisions, ids.segments, "paragraph", "/0", "fixture", sha("s"), 0, 1, "[]", "initial");
}

test("twenty complete workspace lifecycle rounds preserve identity", async () => {
  for (let round = 0; round < 20; round += 1) {
    const root = await mkdtemp(join(tmpdir(), "lectoria-m2-2-life-"));
    const manager = await WorkspaceManager.create(root);
    try {
      const created = await manager.createWorkspace(`Workspace ${round}`);
      const workspaceId = created.workspaceId;
      assert.equal(manager.rename(workspaceId, `Renamed ${round}`).workspaceId, workspaceId);
      assert.equal(manager.archive(workspaceId).state, "archived");
      assert.throws(() => manager.open(workspaceId), ResourceNotFoundError);
      assert.equal(manager.reopen(workspaceId).workspaceId, workspaceId);
      assert.deepEqual(manager.registry.listAudit(workspaceId).map((event) => event.action), ["created", "renamed", "archived", "reopened"]);
      assert.throws(() => manager.registry.database.prepare("UPDATE workspace_lifecycle_audit SET action = 'tampered' WHERE workspace_id = ?").run(workspaceId), /append-only/);
      const handle = manager.open(workspaceId);
      assert.equal(handle.store.workspaceId, workspaceId);
      handle.database.close();
      await manager.delete(workspaceId);
      assert.throws(() => manager.get(workspaceId), ResourceNotFoundError);
    } finally {
      manager.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("nine resource classes reject 900 cross-workspace attacks uniformly", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m2-2-isolation-"));
  const manager = await WorkspaceManager.create(root);
  const handles = [];
  try {
    for (let index = 0; index < 3; index += 1) {
      const workspace = await manager.createWorkspace(`Workspace ${index}`);
      handles.push(manager.open(workspace.workspaceId));
    }
    const ids = Object.fromEntries(RESOURCE_CLASSES.map((resourceClass) => [resourceClass, randomUUID()]));
    seedStructured(handles[0], ids);
    for (const resourceClass of RESOURCE_CLASSES.filter((item) => !["documents", "revisions", "segments"].includes(item))) {
      handles[0].store.put(resourceClass, ids[resourceClass], FIXTURE_CANARIES[1]);
    }

    let rejected = 0;
    const signatures = new Set();
    for (const resourceClass of RESOURCE_CLASSES) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          handles[1 + (attempt % 2)].store.get(resourceClass, ids[resourceClass], handles[0].record.workspaceId);
          assert.fail("cross-workspace read unexpectedly succeeded");
        } catch (error) {
          assert.ok(error instanceof ResourceNotFoundError);
          signatures.add(JSON.stringify({ name: error.name, code: error.code, message: error.message }));
          rejected += 1;
        }
      }
    }
    assert.equal(rejected, 900);
    assert.equal(signatures.size, 1);

    let databaseRejected = 0;
    const foreignWorkspace = handles[1].record.workspaceId;
    for (const table of ["object_records", "documents", "source_revisions", "document_segments", "task_placeholders", "idempotency_keys", "cache_entries", "derived_indexes", "audit_events"]) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          if (table === "documents") handles[0].database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)").run(foreignWorkspace, randomUUID(), "x", new Date(0).toISOString());
          else if (table === "source_revisions") handles[0].database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)").run(foreignWorkspace, randomUUID(), randomUUID(), sha("x"), sha("y"), new Date(0).toISOString());
          else if (table === "document_segments") handles[0].database.prepare("INSERT INTO document_segments VALUES (?, ?, ?, ?)").run(foreignWorkspace, randomUUID(), randomUUID(), new Date(0).toISOString());
          else handles[0].database.prepare(`INSERT INTO ${table}(workspace_id, resource_id, value) VALUES (?, ?, ?)`)
            .run(foreignWorkspace, randomUUID(), "x");
          assert.fail("cross-workspace database write unexpectedly succeeded");
        } catch (error) {
          assert.match(error.message, /FOREIGN KEY/);
          databaseRejected += 1;
        }
      }
    }
    assert.equal(databaseRejected, 900);

    const registryBytes = await readFile(join(root, "registry.sqlite3"));
    for (const canary of FIXTURE_CANARIES) assert.equal(registryBytes.includes(Buffer.from(canary)), false);
  } finally {
    for (const handle of handles) handle.database.close();
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("registry rejects content-shaped workspace creation payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m2-2-registry-"));
  const manager = await WorkspaceManager.create(root);
  try {
    await assert.rejects(manager.createWorkspace({ displayName: "Workspace", body: FIXTURE_CANARIES[0] }), /displayName/);
    assert.equal(manager.list().length, 0);
  } finally {
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("archive and delete failures fail closed", async () => {
  for (const point of ["archive:after-state", "delete:after-state", "delete:after-rename"]) {
    const root = await mkdtemp(join(tmpdir(), "lectoria-m2-2-fault-"));
    let armed = true;
    const manager = await WorkspaceManager.create(root, { inject(current) { if (armed && current === point) throw new Error(`injected ${point}`); } });
    try {
      const first = await manager.createWorkspace("First");
      const second = await manager.createWorkspace("Second");
      if (point.startsWith("archive")) assert.throws(() => manager.archive(first.workspaceId), /injected/);
      else await assert.rejects(manager.delete(first.workspaceId), /injected/);
      assert.throws(() => manager.open(first.workspaceId), ResourceNotFoundError);
      const secondHandle = manager.open(second.workspaceId);
      assert.equal(secondHandle.store.workspaceId, second.workspaceId);
      secondHandle.database.close();
      armed = false;
    } finally {
      manager.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("workspace roots and database files cannot be replaced by symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m2-2-root-link-"));
  const manager = await WorkspaceManager.create(root);
  try {
    const record = await manager.createWorkspace("Workspace");
    const target = join(root, "workspaces", record.rootKey, "state", "app.sqlite3");
    await rm(target);
    await symlink("/dev/null", target);
    assert.throws(() => manager.open(record.workspaceId), ResourceNotFoundError);
  } finally {
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});
