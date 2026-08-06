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

async function withServer(api, config, fn) {
  const server = createWorkflowHttpServer({ api, config });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
}

const config = { authToken: "test-token", allowInsecure: false, maxBodyBytes: 1024, allowedOrigins: [] };

test("HTTP API authenticates and delegates through one application API", async () => {
  const calls = [];
  await withServer({ execute(command, payload) { calls.push({ command, payload }); return { workflowId: "w" }; } }, config, async (base) => {
    const denied = await request(`${base}/api/v1/execute`, { method: "POST", body: JSON.stringify({ command: "workflow:get", payload: { workflowId: "w" } }) });
    assert.equal(denied.status, 401);
    const response = await request(`${base}/api/v1/execute`, { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json", "x-lectoria-user": "alice" }, body: JSON.stringify({ command: "review", payload: { workflowId: "w", actor: { type: "system", id: "forged" } } }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, data: { workflowId: "w" } });
  });
  assert.deepEqual(calls, [{ command: "review", payload: { workflowId: "w", actor: { type: "user", id: "alice" } } }]);
});

test("HTTP API returns bounded JSON errors and health status", async () => {
  await withServer({ execute() { throw new TypeError("unknown workflow command"); } }, config, async (base) => {
    assert.equal((await request(`${base}/healthz`)).status, 200);
    const response = await request(`${base}/api/v1/execute`, { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: JSON.stringify({ command: "bad", payload: {} }) });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: { code: "UNKNOWN_COMMAND", message: "unknown workflow command" } });
  });
});
