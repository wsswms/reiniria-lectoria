import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { WorkspaceManager } from "../../src/workspace/manager.mjs";
import { ProviderConfigurationService } from "../../src/provider/configuration-service.mjs";
import { createProductionWorkflowHttpServer } from "../../src/http/production-server.mjs";

const enabled = process.env.M6_REAL_PROVIDER_E2E === "1";
const keyFile = process.env.DEEPSEEK_KEY_FILE;

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, options, (response) => {
      const chunks = []; response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, json: () => JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }));
    });
    req.on("error", reject); if (options.body) req.write(options.body); req.end();
  });
}

test("production HTTP real mode executes one DeepSeek translation through Broker and Pi Runner", { skip: !enabled || !keyFile }, async () => {
  const root = await mkdtemp(`${tmpdir()}/lectoria-m6-real-`); const manager = await WorkspaceManager.create(root); const workspace = await manager.createWorkspace("Real provider smoke");
  const provider = new ProviderConfigurationService(root); await provider.createSource({ sourceId: "deepseek-smoke", displayName: "DeepSeek smoke", adapterId: "deepseek", modelId: "deepseek-v4-flash", credential: (await readFile(keyFile, "utf8")).trim() });
  await provider.setPreset({ presetId: "translation-smoke", stage: "translation", sourceId: "deepseek-smoke", thinking: false, temperature: 0.2, toolNames: [] }, 1);
  const config = { authToken: "test-token", adminPassword: "test-password", sessionTtlSeconds: 3600, maxBodyBytes: 2 * 1024 * 1024, allowedOrigins: [], dataRoot: root,
    translationMode: "real", realProviderTimeoutMs: 180_000, realMaxOutputTokens: 2_048, realPricingVersion: "m6-real-smoke-v1", realInputMicrosPerMillion: 2_800_000,
    realOutputMicrosPerMillion: 5_600_000, realCachedInputMicrosPerMillion: 56_000, realSoftLimitMicros: 5_000_000, realHardLimitMicros: 10_000_000, realRunnerUid: 65_532, realRunnerGid: 65_532 };
  const server = await createProductionWorkflowHttpServer({ config, workspaceManager: manager }); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await request(`${base}/api/v1/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-password" }) }); const cookie = login.headers["set-cookie"][0].split(";", 1)[0]; const csrf = login.json().data.csrfToken; const headers = { cookie, "content-type": "application/json", "x-csrf-token": csrf };
    const execute = (command, payload) => request(`${base}/api/v1/execute`, { method: "POST", headers, body: JSON.stringify({ command, payload: { workspaceId: workspace.workspaceId, ...payload } }) });
    const imported = (await (await execute("document:import", { format: "text", title: "Real smoke", content: "A public smoke translation sentence." })).json()).data;
    assert.equal((await execute("document:confirm", { importId: imported.importId })).status, 200);
    const workflowId = randomUUID(); let flow = (await (await execute("workflow:create", { importId: imported.importId, workflowId, targetLanguage: "zh-CN" })).json()).data;
    flow = (await (await execute("plan:submit", { workflowId, expectedVersion: flow.planHead.version })).json()).data;
    flow = (await (await execute("plan:decide", { workflowId, expectedVersion: flow.planHead.version, decision: "approved" })).json()).data;
    let context = (await (await execute("context:assemble", { workflowId })).json()).data; context = (await (await execute("context:decide", { workflowId, expectedVersion: context.head.version, decision: "approved" })).json()).data; assert.equal(context.head.state, "approved");
    const queuedResponse = await execute("translation:enqueue", { workflowId, request: { presetId: "translation-smoke", idempotencyKey: "real-smoke-1" } }); assert.equal(queuedResponse.status, 200, JSON.stringify(queuedResponse.json()));
    const run = await execute("translation:run-next", {}); const body = run.json(); assert.equal(run.status, 200, JSON.stringify(body)); assert.equal(body.data.status, "completed", JSON.stringify(body));
  } finally { await new Promise((resolve) => server.close(resolve)); manager.close(); await rm(root, { recursive: true, force: true }); }
});
