import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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

test("production HTTP bootstrap executes document and workflow commands in the selected workspace", async () => {
  const root = await mkdtemp(`${tmpdir()}/lectoria-m6-`);
  const manager = await WorkspaceManager.create(root);
  const workspace = await manager.createWorkspace("Production slice");
  const config = { authToken: "test-token", adminPassword: "test-password", sessionTtlSeconds: 3600, maxBodyBytes: 1024 * 1024, allowedOrigins: [] };
  const server = await createProductionWorkflowHttpServer({ config, workspaceManager: manager });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await request(`${base}/api/v1/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-password" }) });
    const cookie = login.headers["set-cookie"][0].split(";", 1)[0];
    const importedResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ command: "document:import", payload: { workspaceId: workspace.workspaceId, format: "markdown", title: "Hello", content: "# Hello\n\nWorld" } }),
    });
    assert.equal(importedResponse.status, 200);
    const imported = importedResponse.json().data;
    const confirmedResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ command: "document:confirm", payload: { workspaceId: workspace.workspaceId, importId: imported.importId } }),
    });
    assert.equal(confirmedResponse.status, 200);
    const workflowId = randomUUID();
    const workflowResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ command: "workflow:create", payload: { workspaceId: workspace.workspaceId, importId: imported.importId, workflowId, targetLanguage: "zh-CN" } }),
    });
    assert.equal(workflowResponse.status, 200, JSON.stringify(workflowResponse.json()));
    let flow = workflowResponse.json().data;
    assert.equal(flow.workflow.workflowId, workflowId);
    const submittedResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ command: "plan:submit", payload: { workspaceId: workspace.workspaceId, workflowId, expectedVersion: flow.planHead.version, actor: { type: "user", id: "forged" } } }),
    });
    assert.equal(submittedResponse.status, 200); flow = submittedResponse.json().data;
    assert.equal(flow.planHead.state, "pending-user");
    const approvedResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ command: "plan:decide", payload: { workspaceId: workspace.workspaceId, workflowId, expectedVersion: flow.planHead.version, decision: "approved", actor: { type: "system", id: "forged" } } }),
    });
    assert.equal(approvedResponse.status, 200); assert.equal(approvedResponse.json().data.planHead.state, "approved");
  } finally {
    await new Promise((resolve) => server.close(resolve)); manager.close(); await rm(root, { recursive: true, force: true });
  }
});

test("production workspace commands require an explicit workspace id", async () => {
  const root = await mkdtemp(`${tmpdir()}/lectoria-m6-`);
  const manager = await WorkspaceManager.create(root);
  const config = { authToken: "test-token", adminPassword: "test-password", sessionTtlSeconds: 3600, maxBodyBytes: 1024 * 1024, allowedOrigins: [] };
  const server = await createProductionWorkflowHttpServer({ config, workspaceManager: manager });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await request(`${base}/api/v1/execute`, { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: JSON.stringify({ command: "document:get", payload: { importId: "x" } }) });
    assert.equal(response.status, 400); assert.equal(response.json().error.code, "WORKSPACE_REQUIRED");
  } finally { await new Promise((resolve) => server.close(resolve)); manager.close(); await rm(root, { recursive: true, force: true }); }
});
