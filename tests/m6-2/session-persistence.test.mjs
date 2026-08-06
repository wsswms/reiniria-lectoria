import assert from "node:assert/strict";
import { mkdtemp, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createWorkflowHttpServer } from "../../src/http/server.mjs";

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, options, (response) => {
      const chunks = []; response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, json: () => JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }));
    });
    req.on("error", reject); if (options.body) req.write(options.body); req.end();
  });
}

async function listen(config) {
  const server = createWorkflowHttpServer({ config, api: { execute() { return { ok: true }; } } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("cookie sessions survive control-plane restart without storing raw bearer tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-session-"));
  const sessionStoreFile = join(root, "state", "sessions.json");
  const config = { authToken: "token", adminPassword: "password", sessionTtlSeconds: 3600, maxBodyBytes: 1024 * 1024, allowedOrigins: [], sessionStoreFile };
  const first = await listen(config);
  const login = await request(`${first.base}/api/v1/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "password" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"][0].split(";", 1)[0];
  const csrf = login.json().data.csrfToken;
  await new Promise((resolve) => first.server.close(resolve));

  const persisted = await readFile(sessionStoreFile, "utf8");
  assert.equal(persisted.includes(cookie.split("=", 2)[1]), false);
  assert.equal((await (await import("node:fs/promises")).stat(sessionStoreFile)).mode & 0o077, 0);

  const second = await listen(config);
  assert.equal((await request(`${second.base}/api/v1/session`, { headers: { cookie } })).status, 200);
  const logout = await request(`${second.base}/api/v1/session/logout`, { method: "POST", headers: { cookie, "x-csrf-token": csrf } });
  assert.equal(logout.status, 200);
  await new Promise((resolve) => second.server.close(resolve));

  const third = await listen(config);
  assert.equal((await request(`${third.base}/api/v1/session`, { headers: { cookie } })).status, 401);
  await new Promise((resolve) => third.server.close(resolve));
});

test("session store rejects a symlink or broad permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-session-invalid-"));
  const file = join(root, "sessions.json");
  const config = { authToken: "token", adminPassword: "password", sessionTtlSeconds: 3600, maxBodyBytes: 1024, allowedOrigins: [], sessionStoreFile: file };
  const first = await listen(config);
  await request(`${first.base}/api/v1/session/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "password" }) });
  await new Promise((resolve) => first.server.close(resolve));
  await chmod(file, 0o644);
  assert.throws(() => createWorkflowHttpServer({ config, api: { execute() {} } }), /private regular file/);
});
