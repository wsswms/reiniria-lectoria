import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { WorkspaceManager } from "../../src/workspace/manager.mjs";
import { createProductionWorkflowHttpServer } from "../../src/http/production-server.mjs";

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, options, (response) => {
      const chunks = []; response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, json: () => JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }));
    });
    req.on("error", reject); if (options.body) req.write(options.body); req.end();
  });
}

async function start(manager, dataRoot) {
  const server = await createProductionWorkflowHttpServer({ workspaceManager: manager, config: { authToken: "token", adminPassword: "password", sessionTtlSeconds: 3600, maxBodyBytes: 1024 * 1024, allowedOrigins: [], dataRoot } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await request(`${base}/api/v1/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "password" }) });
  const headers = { cookie: login.headers["set-cookie"][0].split(";", 1)[0], "content-type": "application/json", "x-csrf-token": login.json().data.csrfToken };
  return { server, base, headers };
}

test("authenticated backup API creates, lists and restores a workspace without accepting arbitrary paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m6-backup-api-")); const restoreRoot = await mkdtemp(join(tmpdir(), "lectoria-m6-backup-restore-"));
  const manager = await WorkspaceManager.create(root); const workspace = await manager.createWorkspace("backup source");
  const first = await start(manager, root);
  try {
    const created = await request(`${first.base}/api/v1/workspaces/${workspace.workspaceId}/backups`, { method: "POST", headers: first.headers, body: "{}" });
    assert.equal(created.status, 201, JSON.stringify(created.json())); const backup = created.json().data;
    assert.equal(backup.workspaceId, workspace.workspaceId); assert.match(backup.manifestDigest, /^sha256:[0-9a-f]{64}$/);
    const listed = await request(`${first.base}/api/v1/workspaces/${workspace.workspaceId}/backups`, { headers: { cookie: first.headers.cookie } });
    assert.equal(listed.status, 200, JSON.stringify(listed.json())); assert.equal(listed.json().data[0].backupId, backup.backupId);
    const invalid = await request(`${first.base}/api/v1/backups/restore`, { method: "POST", headers: first.headers, body: JSON.stringify({ backupId: "../escape" }) });
    assert.equal(invalid.status, 400); assert.equal(invalid.json().error.code, "INVALID_BACKUP_ID");
    const sameControlPlane = await request(`${first.base}/api/v1/backups/restore`, { method: "POST", headers: first.headers, body: JSON.stringify({ backupId: backup.backupId }) });
    assert.equal(sameControlPlane.status, 201, JSON.stringify(sameControlPlane.json()));
    const reboundWorkspaceId = sameControlPlane.json().data.workspaceId;
    assert.notEqual(reboundWorkspaceId, workspace.workspaceId);
    const rebound = manager.open(reboundWorkspaceId);
    try { assert.equal(rebound.database.prepare("SELECT workspace_id AS workspaceId FROM workspace_meta").get().workspaceId, reboundWorkspaceId); }
    finally { rebound.database.close(); }
    await new Promise((resolve) => first.server.close(resolve));
    manager.close();
    const restoredManager = await WorkspaceManager.create(restoreRoot); const second = await start(restoredManager, root);
    try {
      const restored = await request(`${second.base}/api/v1/backups/restore`, { method: "POST", headers: second.headers, body: JSON.stringify({ backupId: backup.backupId }) });
      assert.equal(restored.status, 201, JSON.stringify(restored.json())); assert.notEqual(restored.json().data.workspaceId, workspace.workspaceId);
      assert.equal(restoredManager.list().some((item) => item.workspaceId === restored.json().data.workspaceId), true);
    } finally { await new Promise((resolve) => second.server.close(resolve)); restoredManager.close(); }
  } finally { await rm(root, { recursive: true, force: true }); await rm(restoreRoot, { recursive: true, force: true }); }
});
