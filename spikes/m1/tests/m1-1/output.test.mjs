import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeOutput } from "../../src/m1-1/output.mjs";

test("output is truncated on a valid UTF-8 boundary", () => {
  const result = sanitizeOutput("摄影".repeat(100), 64);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text) <= 64);
  assert.match(result.text, /\[truncated\]$/);
});

test("invalid UTF-8 output is rejected", () => {
  assert.throws(() => sanitizeOutput(Uint8Array.from([0xc3, 0x28]), 64));
});

test("long exceptions are truncated without leaking the tail", () => {
  const value = `failure:${"x".repeat(4096)}:secret-tail`;
  const result = sanitizeOutput(value, 128);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text) <= 128);
  assert.equal(result.text.includes("secret-tail"), false);
});

test("binary output with an incomplete multibyte tail truncates cleanly", () => {
  const bytes = new TextEncoder().encode("日本語".repeat(64));
  const result = sanitizeOutput(bytes, 65);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text) <= 65);
  assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(result.text)));
});
