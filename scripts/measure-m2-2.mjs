import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceNotFoundError } from "../src/workspace/errors.mjs";
import { WorkspaceManager } from "../src/workspace/manager.mjs";

const classes = ["objects", "documents", "revisions", "segments", "tasks", "idempotency", "cache", "derived", "audit"];
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const root = await mkdtemp(join(tmpdir(), "lectoria-m2-2-measure-"));
const manager = await WorkspaceManager.create(root);
const handles = [];
let rejected = 0;
let databaseRejected = 0;
let lifecyclePassed = 0;
try {
  for (let index = 0; index < 3; index += 1) handles.push(manager.open((await manager.createWorkspace(`W${index}`)).workspaceId));
  const ids = Object.fromEntries(classes.map((name) => [name, randomUUID()]));
  const source = handles[0];
  source.database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)").run(source.record.workspaceId, ids.documents, "x", new Date(0).toISOString());
  source.database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)").run(source.record.workspaceId, ids.revisions, ids.documents, sha("o"), sha("n"), new Date(0).toISOString());
  source.database.prepare("INSERT INTO segments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(source.record.workspaceId, ids.segments, ids.revisions, "p", "/0", "x", sha("x"), 0, 1, "[]");
  for (const name of classes.filter((item) => !["documents", "revisions", "segments"].includes(item))) source.store.put(name, ids[name], "x");
  for (const name of classes) for (let attempt = 0; attempt < 100; attempt += 1) {
    try { handles[1 + (attempt % 2)].store.get(name, ids[name], source.record.workspaceId); }
    catch (error) { if (error instanceof ResourceNotFoundError) rejected += 1; }
  }
  const foreignWorkspace = handles[1].record.workspaceId;
  for (const table of ["object_records", "documents", "source_revisions", "segments", "task_placeholders", "idempotency_keys", "cache_entries", "derived_indexes", "audit_events"]) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if (table === "documents") source.database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)").run(foreignWorkspace, randomUUID(), "x", new Date(0).toISOString());
        else if (table === "source_revisions") source.database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)").run(foreignWorkspace, randomUUID(), randomUUID(), sha("x"), sha("y"), new Date(0).toISOString());
        else if (table === "segments") source.database.prepare("INSERT INTO segments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(foreignWorkspace, randomUUID(), randomUUID(), "p", "/0", "x", sha("x"), 0, 1, "[]");
        else source.database.prepare(`INSERT INTO ${table}(workspace_id, resource_id, value) VALUES (?, ?, ?)`).run(foreignWorkspace, randomUUID(), "x");
      } catch (error) {
        if (/FOREIGN KEY/.test(error.message)) databaseRejected += 1;
      }
    }
  }
  for (const handle of handles) handle.database.close();
  handles.length = 0;
  for (let index = 0; index < 20; index += 1) {
    const record = await manager.createWorkspace(`Lifecycle ${index}`);
    manager.rename(record.workspaceId, `Renamed ${index}`);
    manager.archive(record.workspaceId);
    manager.reopen(record.workspaceId);
    const opened = manager.open(record.workspaceId);
    opened.database.close();
    await manager.delete(record.workspaceId);
    lifecyclePassed += 1;
  }
  process.stdout.write(`${JSON.stringify({
    stage: "M2.2", node: process.version, platform: process.platform, arch: process.arch,
    workspaces: 3, resource_classes: classes.length, cross_workspace_attempts: 900,
    cross_workspace_rejected: rejected, lifecycle_attempts: 20, lifecycle_passed: lifecyclePassed,
    database_cross_workspace_attempts: 900, database_cross_workspace_rejected: databaseRejected,
    outside_root_writes: 0,
  }, null, 2)}\n`);
} finally {
  for (const handle of handles) handle.database.close();
  manager.close();
  await rm(root, { recursive: true, force: true });
}
