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
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), json: () => JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }));
    });
    req.on("error", reject); if (options.body) req.write(options.body); req.end();
  });
}

test("HTTP core translation/export flow preserves Markdown, HTML and text formats", async () => {
  const root = await mkdtemp(`${tmpdir()}/lectoria-m6-format-`); const manager = await WorkspaceManager.create(root);
  const server = await createProductionWorkflowHttpServer({ workspaceManager: manager, config: { authToken: "token", adminPassword: "password", sessionTtlSeconds: 3600, maxBodyBytes: 2 * 1024 * 1024, allowedOrigins: [] } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await request(`${base}/api/v1/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "password" }) });
    const headers = { cookie: login.headers["set-cookie"][0].split(";", 1)[0], "content-type": "application/json", "x-csrf-token": login.json().data.csrfToken };
    const fixtures = { markdown: "# Hello\n\nWorld", html: "<h1>Hello</h1><p>World</p>", text: "Hello\nWorld" };
    for (const [format, content] of Object.entries(fixtures)) {
      const workspace = (await request(`${base}/api/v1/workspaces`, { method: "POST", headers, body: JSON.stringify({ displayName: `${format} flow` }) })).json().data;
      const execute = (command, payload) => request(`${base}/api/v1/execute`, { method: "POST", headers, body: JSON.stringify({ command, payload: { workspaceId: workspace.workspaceId, ...payload } }) });
      const imported = (await execute("document:import", { format, title: `${format} document`, content })).json().data;
      assert.equal((await execute("document:confirm", { importId: imported.importId })).status, 200);
      const workflowId = randomUUID(); let flow = (await execute("workflow:create", { importId: imported.importId, workflowId, targetLanguage: "zh-CN" })).json().data;
      flow = (await execute("plan:submit", { workflowId, expectedVersion: flow.planHead.version })).json().data;
      flow = (await execute("plan:decide", { workflowId, expectedVersion: flow.planHead.version, decision: "approved" })).json().data;
      let context = (await execute("context:assemble", { workflowId })).json().data;
      context = (await execute("context:decide", { workflowId, expectedVersion: context.head.version, decision: "approved" })).json().data;
      assert.equal(context.head.state, "approved");
      const queued = (await execute("translation:enqueue", { workflowId, request: { providerId: "deepseek", modelId: "deepseek-v4-flash", idempotencyKey: `${format}-translation` } })).json().data;
      let executed = false;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const result = (await execute("translation:run-next", {})).json().data;
        if (result.status === "completed") executed = true;
        if (result.status === "idle") break;
      }
      assert.equal(executed, true);
      assert.equal((await execute("translation:task-get", { taskId: queued.task.task.task_id })).json().data.task.state, "completed");
      const bundle = (await execute("working-copy:get", { workflowId })).json().data;
      for (const segment of bundle.segments) {
        const candidates = (await execute("candidate:list", { workflowId, segmentId: segment.segmentId })).json().data;
        assert.ok(candidates[0]);
        assert.equal((await execute("candidate:select", { workflowId, segmentId: segment.segmentId, candidateId: candidates[0].candidateId, expectedHeadVersion: segment.version ?? null })).status, 200);
      }
      const validation = (await execute("validate", { workflowId })).json().data; assert.equal(validation.findings.some((item) => item.severity === "error"), false);
      const quality = (await execute("quality:run", { workflowId })).json().data; assert.equal(quality.findings.some((item) => item.severity === "error"), false);
      const current = (await execute("working-copy:get", { workflowId })).json().data.workflow;
      const reviewed = (await execute("review", { workflowId, validationRunId: validation.validationRunId, qualityRunId: quality.qualityRunId, expectedWorkflowVersion: current.version })).json().data;
      const approved = (await execute("approve", { workflowId, validationRunId: validation.validationRunId, qualityRunId: quality.qualityRunId, expectedWorkflowVersion: reviewed.version })).json().data;
      assert.equal(approved.state, "approved-for-export");
      const exported = (await execute("export", { workflowId, validationRunId: validation.validationRunId, qualityRunId: quality.qualityRunId, format })).json().data;
      const download = await request(`${base}/api/v1/workspaces/${workspace.workspaceId}/exports/${exported.exportId}/download`, { headers: { cookie: headers.cookie } });
      assert.equal(download.status, 200); assert.ok(download.body.length > 0); assert.match(download.headers["content-disposition"], /attachment/);
    }
  } finally { await new Promise((resolve) => server.close(resolve)); manager.close(); await rm(root, { recursive: true, force: true }); }
});
