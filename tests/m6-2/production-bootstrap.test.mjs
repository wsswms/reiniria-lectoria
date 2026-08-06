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
    const csrfToken = login.json().data.csrfToken;
    const authHeaders = { cookie, "content-type": "application/json", "x-csrf-token": csrfToken };
    const importedResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ command: "document:import", payload: { workspaceId: workspace.workspaceId, format: "markdown", title: "Hello", content: "# Hello\n\nWorld" } }),
    });
    assert.equal(importedResponse.status, 200);
    const imported = importedResponse.json().data;
    const confirmedResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ command: "document:confirm", payload: { workspaceId: workspace.workspaceId, importId: imported.importId } }),
    });
    assert.equal(confirmedResponse.status, 200);
    const workflowId = randomUUID();
    const workflowResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ command: "workflow:create", payload: { workspaceId: workspace.workspaceId, importId: imported.importId, workflowId, targetLanguage: "zh-CN" } }),
    });
    assert.equal(workflowResponse.status, 200, JSON.stringify(workflowResponse.json()));
    let flow = workflowResponse.json().data;
    assert.equal(flow.workflow.workflowId, workflowId);
    const listedWorkflowsResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ command: "workflow:list", payload: { workspaceId: workspace.workspaceId } }),
    });
    assert.equal(listedWorkflowsResponse.status, 200); assert.equal(listedWorkflowsResponse.json().data.some((item) => item.workflowId === workflowId), true);
    const submittedResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ command: "plan:submit", payload: { workspaceId: workspace.workspaceId, workflowId, expectedVersion: flow.planHead.version, actor: { type: "user", id: "forged" } } }),
    });
    assert.equal(submittedResponse.status, 200); flow = submittedResponse.json().data;
    assert.equal(flow.planHead.state, "pending-user");
    const approvedResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ command: "plan:decide", payload: { workspaceId: workspace.workspaceId, workflowId, expectedVersion: flow.planHead.version, decision: "approved", actor: { type: "system", id: "forged" } } }),
    });
    assert.equal(approvedResponse.status, 200); assert.equal(approvedResponse.json().data.planHead.state, "approved");
    const assembledResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ command: "context:assemble", payload: { workspaceId: workspace.workspaceId, workflowId, actor: { type: "user", id: "forged" } } }),
    });
    assert.equal(assembledResponse.status, 200); let context = assembledResponse.json().data;
    assert.equal(context.head.state, "pending-user");
    const contextDecision = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ command: "context:decide", payload: { workspaceId: workspace.workspaceId, workflowId, expectedVersion: context.head.version, decision: "approved", actor: { type: "system", id: "forged" } } }),
    });
    assert.equal(contextDecision.status, 200); context = contextDecision.json().data;
    assert.equal(context.head.state, "approved");
    const queuedResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ command: "translation:enqueue", payload: { workspaceId: workspace.workspaceId, workflowId, request: { providerId: "deepseek", modelId: "deepseek-v4-flash", idempotencyKey: "web-slice-translation-1" } } }),
    });
    assert.equal(queuedResponse.status, 200); const queued = queuedResponse.json().data;
    assert.equal(queued.task.task.state, "queued");
    const taskResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ command: "translation:task-get", payload: { workspaceId: workspace.workspaceId, taskId: queued.task.task.task_id } }),
    });
    assert.equal(taskResponse.status, 200); assert.equal(taskResponse.json().data.task.state, "queued");
    const runResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ command: "translation:run-next", payload: { workspaceId: workspace.workspaceId } }),
    });
    assert.equal(runResponse.status, 200, JSON.stringify(runResponse.json()));
    assert.equal(runResponse.json().data.status, "completed");
    const completedTaskResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ command: "translation:task-get", payload: { workspaceId: workspace.workspaceId, taskId: queued.task.task.task_id } }),
    });
    assert.equal(completedTaskResponse.status, 200);
    assert.equal(completedTaskResponse.json().data.task.state, "running");
    const secondRunResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ command: "translation:run-next", payload: { workspaceId: workspace.workspaceId } }),
    });
    assert.equal(secondRunResponse.status, 200); assert.equal(secondRunResponse.json().data.status, "completed");
    const finalTaskResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ command: "translation:task-get", payload: { workspaceId: workspace.workspaceId, taskId: queued.task.task.task_id } }),
    });
    assert.equal(finalTaskResponse.json().data.task.state, "completed");
    const bundleResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ command: "working-copy:get", payload: { workspaceId: workspace.workspaceId, workflowId } }),
    });
    assert.equal(bundleResponse.status, 200); let bundle = bundleResponse.json().data;
    for (const segment of bundle.segments) {
      const candidatesResponse = await request(`${base}/api/v1/execute`, {
        method: "POST", headers: authHeaders,
        body: JSON.stringify({ command: "candidate:list", payload: { workspaceId: workspace.workspaceId, workflowId, segmentId: segment.segmentId } }),
      });
      const candidate = candidatesResponse.json().data[0]; assert.ok(candidate);
      const selectedResponse = await request(`${base}/api/v1/execute`, {
        method: "POST", headers: authHeaders,
        body: JSON.stringify({ command: "candidate:select", payload: { workspaceId: workspace.workspaceId, workflowId, segmentId: segment.segmentId, candidateId: candidate.candidateId, expectedHeadVersion: segment.version ?? null } }),
      });
      assert.equal(selectedResponse.status, 200, JSON.stringify(selectedResponse.json()));
    }
    const validationResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ command: "validate", payload: { workspaceId: workspace.workspaceId, workflowId } }),
    });
    assert.equal(validationResponse.status, 200); const validation = validationResponse.json().data;
    assert.equal(validation.findings.some((item) => item.severity === "error"), false);
    const qualityResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ command: "quality:run", payload: { workspaceId: workspace.workspaceId, workflowId } }),
    });
    assert.equal(qualityResponse.status, 200, JSON.stringify(qualityResponse.json())); const quality = qualityResponse.json().data;
    assert.equal(quality.findings.some((item) => item.severity === "error"), false);
    const currentResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ command: "working-copy:get", payload: { workspaceId: workspace.workspaceId, workflowId } }),
    });
    let current = currentResponse.json().data.workflow;
    const reviewResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ command: "review", payload: { workspaceId: workspace.workspaceId, workflowId, validationRunId: validation.validationRunId, qualityRunId: quality.qualityRunId, expectedWorkflowVersion: current.version } }),
    });
    assert.equal(reviewResponse.status, 200, JSON.stringify(reviewResponse.json())); current = reviewResponse.json().data;
    assert.equal(current.state, "human-reviewed");
    const approveResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ command: "approve", payload: { workspaceId: workspace.workspaceId, workflowId, validationRunId: validation.validationRunId, qualityRunId: quality.qualityRunId, expectedWorkflowVersion: current.version } }),
    });
    assert.equal(approveResponse.status, 200, JSON.stringify(approveResponse.json()));
    assert.equal(approveResponse.json().data.state, "approved-for-export");
    const exportResponse = await request(`${base}/api/v1/execute`, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ command: "export", payload: { workspaceId: workspace.workspaceId, workflowId, validationRunId: validation.validationRunId, qualityRunId: quality.qualityRunId, format: "markdown" } }),
    });
    assert.equal(exportResponse.status, 200, JSON.stringify(exportResponse.json())); assert.ok(exportResponse.json().data.exportId);
    const handle = manager.open(workspace.workspaceId);
    try {
      const snapshot = handle.database.prepare("SELECT provider_id AS providerId, model_id AS modelId, config_digest AS configDigest, snapshot_json AS snapshotJson FROM translation_attempt_config_snapshots WHERE workspace_id = ? AND task_id = ?").get(workspace.workspaceId, queued.task.task.task_id);
      assert.equal(snapshot.providerId, "deepseek"); assert.equal(snapshot.modelId, "deepseek-v4-flash"); assert.match(snapshot.configDigest, /^sha256:[0-9a-f]{64}$/); assert.equal(JSON.parse(snapshot.snapshotJson).configDigest, snapshot.configDigest);
    } finally { handle.database.close(); }
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
