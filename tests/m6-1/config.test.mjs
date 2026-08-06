import assert from "node:assert/strict";
import test from "node:test";
import { loadHttpConfig } from "../../src/runtime/config.mjs";

test("HTTP config fails closed without an auth token", () => {
  assert.throws(() => loadHttpConfig({ NODE_ENV: "production" }), /AUTH_TOKEN/);
  assert.throws(() => loadHttpConfig({ LECTORIA_ALLOW_INSECURE: "true" }), /AUTH_TOKEN/);
});

test("HTTP config defaults to loopback and validates bounded settings", () => {
  const config = loadHttpConfig({ LECTORIA_AUTH_TOKEN: "secret" });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8787);
  assert.equal(config.maxBodyBytes, 4 * 1024 * 1024);
  assert.equal(config.loginMaxAttempts, 5);
  assert.equal(config.loginWindowSeconds, 300);
  assert.equal(config.cookieSecure, false);
  assert.deepEqual(config.allowedOrigins, []);
  assert.throws(() => loadHttpConfig({ LECTORIA_AUTH_TOKEN: "secret", LECTORIA_PORT: "0" }), /positive integer/);
  assert.throws(() => loadHttpConfig({ LECTORIA_AUTH_TOKEN: "secret", LECTORIA_COOKIE_SECURE: "yes" }), /true or false/);
});
