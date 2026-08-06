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
    const req = httpRequest(url, options, (response) => {
      const chunks = []; response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, json: () => JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }));
    });
    req.on("error", reject); if (options.body) req.write(options.body); req.end();
  });
}

test("authenticated workspace API exposes scoped knowledge proposal review without exposing actor control", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m6-proposals-")); const manager = await WorkspaceManager.create(root);
  const workspace = await manager.createWorkspace("proposal review");
  const server = await createProductionWorkflowHttpServer({ workspaceManager: manager, config: { authToken: "token", adminPassword: "password", sessionTtlSeconds: 3600, maxBodyBytes: 1024 * 1024, allowedOrigins: [] } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await request(`${base}/api/v1/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "password" }) });
    const headers = { cookie: login.headers["set-cookie"][0].split(";", 1)[0], "content-type": "application/json", "x-csrf-token": login.json().data.csrfToken };
    const execute = (command, payload = {}) => request(`${base}/api/v1/execute`, { method: "POST", headers, body: JSON.stringify({ command, payload: { workspaceId: workspace.workspaceId, ...payload, actor: { type: "system", id: "forged" } } }) });
    const listed = await execute("knowledge-proposal:list");
    assert.equal(listed.status, 200, JSON.stringify(listed.json())); assert.deepEqual(listed.json().data, []);
    const invalid = await execute("knowledge-proposal:list", { state: "unknown" });
    assert.equal(invalid.status, 422); assert.equal(invalid.json().error.code, "WORKFLOW_ERROR");
  } finally { await new Promise((resolve) => server.close(resolve)); manager.close(); await rm(root, { recursive: true, force: true }); }
});
