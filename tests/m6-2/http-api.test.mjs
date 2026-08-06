import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createWorkflowHttpServer } from "../../src/http/server.mjs";

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const requestInstance = httpRequest(url, options, (response) => {
      const chunks = []; response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers,
        async json() { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } }));
    });
    requestInstance.on("error", reject); if (options.body) requestInstance.write(options.body); requestInstance.end();
  });
}

async function withServer(api, config, fn, extras = {}) {
  const server = createWorkflowHttpServer({ api, config, ...extras });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
}

const config = { authToken: "test-token", adminPassword: "test-password", sessionTtlSeconds: 3600, maxBodyBytes: 1024, allowedOrigins: [] };

test("HTTP API authenticates and delegates through one application API", async () => {
  const calls = [];
  await withServer({ execute(command, payload) { calls.push({ command, payload }); return { workflowId: "w" }; } }, config, async (base) => {
    const denied = await request(`${base}/api/v1/execute`, { method: "POST", body: JSON.stringify({ command: "workflow:get", payload: { workflowId: "w" } }) });
    assert.equal(denied.status, 401);
    const response = await request(`${base}/api/v1/execute`, { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json", "x-lectoria-user": "alice" }, body: JSON.stringify({ command: "review", payload: { workflowId: "w", actor: { type: "system", id: "forged" } } }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, data: { workflowId: "w" } });
  });
  assert.deepEqual(calls, [{ command: "review", payload: { workflowId: "w", actor: { type: "user", id: "owner" } } }]);
});

test("quality QA commands are authenticated and warning confirmation always uses the login user", async () => {
  const calls = [];
  await withServer({ execute(command, payload) { calls.push({ command, payload }); return { qualityRunId: "quality-1" }; } }, config, async (base) => {
    const response = await request(`${base}/api/v1/execute`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ command: "quality:confirm-warning", payload: { workflowId: "workflow-1", qualityRunId: "quality-1", findingId: "finding-1", actor: { type: "system", id: "forged" } } }),
    });
    assert.equal(response.status, 200);
  });
  assert.deepEqual(calls, [{ command: "quality:confirm-warning", payload: { workflowId: "workflow-1", qualityRunId: "quality-1", findingId: "finding-1", actor: { type: "user", id: "owner" } } }]);
});

test("login creates an HttpOnly session cookie and logout revokes it", async () => {
  await withServer({ execute() { return { ok: true }; } }, config, async (base) => {
    const login = await request(`${base}/api/v1/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-password" }) });
    assert.equal(login.status, 200);
    const cookie = login.headers["set-cookie"][0].split(";", 1)[0];
    const csrfToken = (await login.json()).data.csrfToken;
    const session = await request(`${base}/api/v1/session`, { headers: { cookie } });
    assert.equal(session.status, 200);
    const deniedLogout = await request(`${base}/api/v1/session/logout`, { method: "POST", headers: { cookie } });
    assert.equal(deniedLogout.status, 403); assert.equal((await deniedLogout.json()).error.code, "CSRF_DENIED");
    const logout = await request(`${base}/api/v1/session/logout`, { method: "POST", headers: { cookie, "x-csrf-token": csrfToken } });
    assert.equal(logout.status, 200);
    assert.equal((await request(`${base}/api/v1/session`, { headers: { cookie } })).status, 401);
  });
});

test("workspace HTTP routes require login and delegate to WorkspaceManager", async () => {
  const calls = [];
  const manager = { list() { calls.push(["list"]); return [{ workspaceId: "w", displayName: "Demo" }]; }, async createWorkspace(name) { calls.push(["create", name]); return { workspaceId: "new", displayName: name }; }, get(id) { calls.push(["get", id]); return { workspaceId: id, displayName: "Demo" }; } };
  await withServer({ execute() {} }, config, async (base) => {
    assert.equal((await request(`${base}/api/v1/workspaces`)).status, 401);
    const login = await request(`${base}/api/v1/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-password" }) });
    const cookie = login.headers["set-cookie"][0].split(";", 1)[0];
    const csrfToken = (await login.json()).data.csrfToken;
    const listed = await request(`${base}/api/v1/workspaces`, { headers: { cookie } });
    assert.equal(listed.status, 200); assert.deepEqual((await listed.json()).data, [{ workspaceId: "w", displayName: "Demo" }]);
    const created = await request(`${base}/api/v1/workspaces`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ displayName: "New" }) });
    assert.equal(created.status, 201); assert.equal((await created.json()).data.displayName, "New");
    const fetched = await request(`${base}/api/v1/workspaces/w`, { headers: { cookie } });
    assert.equal(fetched.status, 200); assert.equal((await fetched.json()).data.workspaceId, "w");
  }, { workspaceManager: manager });
  assert.deepEqual(calls, [["list"], ["create", "New"], ["get", "w"]]);
});

test("HTTP API returns bounded JSON errors and health status", async () => {
  await withServer({ execute() { throw new TypeError("unknown workflow command"); } }, config, async (base) => {
    assert.equal((await request(`${base}/healthz`)).status, 200);
    const response = await request(`${base}/api/v1/execute`, { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: JSON.stringify({ command: "bad", payload: {} }) });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: { code: "UNKNOWN_COMMAND", message: "unknown workflow command" } });
  });
});

test("diagnostics are authenticated and expose only bounded runtime metadata", async () => {
  await withServer({ execute() {} }, config, async (base) => {
    assert.equal((await request(`${base}/api/v1/diagnostics`)).status, 401);
    const response = await request(`${base}/api/v1/diagnostics`, { headers: { authorization: "Bearer test-token" } });
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    assert.equal(data.status, "ok"); assert.equal(typeof data.node, "string"); assert.equal(typeof data.uptimeSeconds, "number");
    assert.equal("dataRoot" in data, false); assert.equal("adminPassword" in data, false); assert.equal("authToken" in data, false);
  });
});

test("login attempts are bounded per remote address", async () => {
  await withServer({ execute() {} }, { ...config, loginMaxAttempts: 2, loginWindowSeconds: 60 }, async (base) => {
    const attempt = (password) => request(`${base}/api/v1/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    assert.equal((await attempt("wrong-1")).status, 401);
    assert.equal((await attempt("wrong-2")).status, 401);
    const limited = await attempt("test-password");
    assert.equal(limited.status, 429); assert.equal((await limited.json()).error.code, "LOGIN_RATE_LIMITED");
  });
});

test("HTTP translation enqueue resolves a registered StagePreset and ignores client provider fields", async () => {
  const calls = [];
  await withServer({ execute(command, payload) { calls.push({ command, payload }); return { ok: true }; } }, config, async (base) => {
    const response = await request(`${base}/api/v1/execute`, { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: JSON.stringify({ command: "translation:enqueue", payload: { workflowId: "w", request: { presetId: "translation-default", providerId: "forged", modelId: "forged", idempotencyKey: "idempotent" } } }) });
    assert.equal(response.status, 200);
  }, { providerConfiguration: { async resolvePreset() { return { sourceId: "registered-source", modelId: "registered-model", thinking: true, temperature: 0.4, toolNames: ["number"], configDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }; } } });
  assert.equal(calls[0].payload.request.providerId, "registered-source"); assert.equal(calls[0].payload.request.modelId, "registered-model");
  assert.equal(calls[0].payload.request.configDigest, "sha256:" + "a".repeat(64)); assert.equal("presetId" in calls[0].payload.request, false);
});
