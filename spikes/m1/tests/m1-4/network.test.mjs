import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { networkInterfaces } from "node:os";
import test from "node:test";
import { OwnerAuth } from "../../src/m1-4/auth.mjs";
import { ListenerConfigManager } from "../../src/m1-4/config.mjs";
import { createSpikeServer } from "../../src/m1-4/server.mjs";

const fixtureRoot = new URL("../fixtures/m1-4/", import.meta.url);
const cert = await readFile(new URL("server-cert.fixture", fixtureRoot), "utf8");
const key = await readFile(new URL("server-key.fixture", fixtureRoot), "utf8");
const mismatchKey = await readFile(new URL("mismatch-key.fixture", fixtureRoot), "utf8");
const password = "owner-test-password";

function request({ protocol = "http:", address, port, method = "GET", path = "/private", headers = {}, body }) {
  const client = protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const call = client.request({
      protocol,
      hostname: address,
      port,
      method,
      path,
      rejectUnauthorized: false,
      headers: { Host: "localhost", ...headers },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    call.on("error", reject);
    if (body) call.write(JSON.stringify(body));
    call.end();
  });
}

function baseConfig(mode, bindAddress = "127.0.0.1") {
  return {
    mode,
    bindAddress,
    port: 0,
    allowedHosts: ["localhost"],
    allowedOrigins: [mode === "http" ? "http://localhost" : "https://localhost"],
    trustedProxies: mode === "https-proxy" ? ["127.0.0.1"] : [],
    cert: mode === "https-direct" ? cert : undefined,
    key: mode === "https-direct" ? key : undefined,
  };
}

function cookie(response) {
  return response.headers["set-cookie"][0].split(";")[0];
}

async function exerciseMode(mode) {
  const config = baseConfig(mode);
  const auth = new OwnerAuth({ password });
  const server = createSpikeServer({ config, auth });
  const address = await server.start();
  const protocol = mode === "https-direct" ? "https:" : "http:";
  const proxyHeaders = mode === "https-proxy" ? { "X-Forwarded-Proto": "https" } : {};
  const origin = mode === "http" ? "http://localhost" : "https://localhost";
  try {
    const unauthorized = await request({ protocol, address: address.address, port: address.port, headers: proxyHeaders });
    assert.equal(unauthorized.status, 401, mode);
    const badLogin = await request({ protocol, address: address.address, port: address.port, method: "POST", path: "/login", headers: { Origin: origin, ...proxyHeaders }, body: { password: "wrong" } });
    assert.equal(badLogin.status, 401, mode);
    const login = await request({ protocol, address: address.address, port: address.port, method: "POST", path: "/login", headers: { Origin: origin, ...proxyHeaders }, body: { password } });
    assert.equal(login.status, 200, mode);
    assert.match(login.headers["set-cookie"][0], /HttpOnly; SameSite=Strict/);
    if (mode === "http") assert.doesNotMatch(login.headers["set-cookie"][0], /Secure/);
    else assert.match(login.headers["set-cookie"][0], /Secure/);
    const authenticated = await request({ protocol, address: address.address, port: address.port, headers: { Cookie: cookie(login), ...proxyHeaders } });
    assert.equal(authenticated.status, 200, mode);
    assert.equal(authenticated.body.httpRisk, mode === "http");
    const missingCsrf = await request({ protocol, address: address.address, port: address.port, method: "POST", path: "/state", headers: { Origin: origin, Cookie: cookie(login), ...proxyHeaders }, body: {} });
    assert.equal(missingCsrf.status, 403, mode);
    const wrongCsrf = await request({ protocol, address: address.address, port: address.port, method: "POST", path: "/state", headers: { Origin: origin, Cookie: cookie(login), "X-CSRF-Token": "wrong", ...proxyHeaders }, body: {} });
    assert.equal(wrongCsrf.status, 403, mode);
    const changed = await request({ protocol, address: address.address, port: address.port, method: "POST", path: "/state", headers: { Origin: origin, Cookie: cookie(login), "X-CSRF-Token": login.body.csrf, ...proxyHeaders }, body: {} });
    assert.equal(changed.status, 200, mode);
    const badHost = await request({ protocol, address: address.address, port: address.port, headers: { Host: "attacker.invalid", Cookie: cookie(login), ...proxyHeaders } });
    assert.equal(badHost.status, 400, mode);
    const badOrigin = await request({ protocol, address: address.address, port: address.port, method: "POST", path: "/state", headers: { Origin: "https://attacker.invalid", Cookie: cookie(login), "X-CSRF-Token": login.body.csrf, ...proxyHeaders }, body: {} });
    assert.equal(badOrigin.status, 403, mode);
  } finally {
    await server.stop();
  }
}

test("http, direct TLS and trusted reverse-proxy TLS enforce the same auth boundary", async () => {
  for (const mode of ["http", "https-direct", "https-proxy"]) await exerciseMode(mode);
});

test("untrusted forwarded headers are rejected in proxy mode", async () => {
  const config = { ...baseConfig("https-proxy"), trustedProxies: ["192.0.2.10"] };
  const server = createSpikeServer({ config, auth: new OwnerAuth({ password }) });
  const address = await server.start();
  try {
    const response = await request({ address: address.address, port: address.port, headers: { "X-Forwarded-Proto": "https" } });
    assert.equal(response.status, 400);
  } finally {
    await server.stop();
  }
});

test("expired sessions are rejected", async () => {
  for (const mode of ["http", "https-direct", "https-proxy"]) {
    let now = 1_000;
    const config = baseConfig(mode);
    const auth = new OwnerAuth({ password, sessionTtlMs: 10, now: () => now });
    const server = createSpikeServer({ config, auth });
    const address = await server.start();
    const protocol = mode === "https-direct" ? "https:" : "http:";
    const proxyHeaders = mode === "https-proxy" ? { "X-Forwarded-Proto": "https" } : {};
    const origin = mode === "http" ? "http://localhost" : "https://localhost";
    try {
      const login = await request({ protocol, address: address.address, port: address.port, method: "POST", path: "/login", headers: { Origin: origin, ...proxyHeaders }, body: { password } });
      now += 11;
      const expired = await request({ protocol, address: address.address, port: address.port, headers: { Cookie: cookie(login), ...proxyHeaders } });
      assert.equal(expired.status, 401, mode);
    } finally {
      await server.stop();
    }
  }
});

test("default binds loopback and explicit LAN binds only the selected container address", async () => {
  const loopback = baseConfig("http");
  assert.equal(loopback.bindAddress, "127.0.0.1");
  const lanAddress = Object.values(networkInterfaces()).flat().find((item) => item && item.family === "IPv4" && !item.internal)?.address;
  assert.ok(lanAddress, "container LAN address required");
  const config = baseConfig("http", lanAddress);
  const server = createSpikeServer({ config, auth: new OwnerAuth({ password }) });
  const address = await server.start();
  try {
    assert.equal(address.address, lanAddress);
  } finally {
    await server.stop();
  }
});

test("ten invalid config classes repeated ten times preserve the last known good listener", () => {
  const good = baseConfig("http");
  const manager = new ListenerConfigManager(good);
  const invalid = [
    { ...baseConfig("https-direct"), cert: undefined },
    { ...baseConfig("https-direct"), key: undefined },
    { ...baseConfig("https-direct"), key: mismatchKey },
    { ...baseConfig("https-direct"), cert: "not a certificate" },
    { ...baseConfig("https-direct"), key: "not a key" },
    { ...good, bindAddress: "0.0.0.0" },
    { ...good, mode: "invalid" },
    { ...baseConfig("https-proxy"), trustedProxies: [] },
    { ...good, port: 70_000 },
    { ...good, allowedHosts: [] },
  ];
  for (const candidate of invalid) {
    for (let index = 0; index < 10; index += 1) {
      const result = manager.apply(candidate);
      assert.equal(result.applied, false);
      assert.deepEqual(result.config, manager.current);
      assert.deepEqual(manager.current, good);
    }
  }
});
