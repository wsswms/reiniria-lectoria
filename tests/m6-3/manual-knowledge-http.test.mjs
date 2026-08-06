import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { WorkspaceManager } from "../../src/workspace/manager.mjs";
import { createProductionWorkflowHttpServer } from "../../src/http/production-server.mjs";

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, options, (response) => { const chunks = []; response.on("data", (chunk) => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, json: () => JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") })); });
    req.on("error", reject); if (options.body) req.write(options.body); req.end();
  });
}

test("authenticated WebUI can create, list and activate manual knowledge without accepting a forged actor", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m6-knowledge-http-")); const manager = await WorkspaceManager.create(root);
  const workspace = await manager.createWorkspace("knowledge http");
  const server = await createProductionWorkflowHttpServer({ workspaceManager: manager, config: { authToken: "token", adminPassword: "password", sessionTtlSeconds: 3600, maxBodyBytes: 1024 * 1024, allowedOrigins: [] } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await request(`${base}/api/v1/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "password" }) });
    const cookie = login.headers["set-cookie"][0].split(";", 1)[0]; const headers = { cookie, "content-type": "application/json", "x-csrf-token": login.json().data.csrfToken };
    const create = await request(`${base}/api/v1/execute`, { method: "POST", headers, body: JSON.stringify({ command: "knowledge:fact-create", payload: { workspaceId: workspace.workspaceId, actor: { type: "system", id: "forged" }, kind: "knowledge", language: "zh-CN", initialState: "draft", content: { title: "手动事实", body: "内容", tags: [], source: "user" } } }) });
    assert.equal(create.status, 200, JSON.stringify(create.json())); assert.equal(create.json().data.revision.actorId, "owner");
    const listed = await request(`${base}/api/v1/execute`, { method: "POST", headers, body: JSON.stringify({ command: "knowledge:fact-list", payload: { workspaceId: workspace.workspaceId } }) });
    assert.equal(listed.status, 200); const fact = listed.json().data[0]; assert.equal(fact.head.state, "inactive");
    const activate = await request(`${base}/api/v1/execute`, { method: "POST", headers, body: JSON.stringify({ command: "knowledge:fact-state", payload: { workspaceId: workspace.workspaceId, factId: fact.source.factId, expectedHeadVersion: fact.head.version, state: "active" } }) });
    assert.equal(activate.status, 200); assert.equal(activate.json().data.state, "active");
  } finally { await new Promise((resolve) => server.close(resolve)); manager.close(); await rm(root, { recursive: true, force: true }); }
});
