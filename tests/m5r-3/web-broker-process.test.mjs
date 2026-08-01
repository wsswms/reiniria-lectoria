import assert from "node:assert/strict";
import { open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { invokeResearchWebBroker } from "../../src/research/web-broker-process.mjs";

test("independent Search and Content Broker receive credentials only through fd 3 and return secret-free normalized output", async () => {
  const path = join(tmpdir(), `m5r3-broker-${process.pid}.key`); const canary = "M5R3-FD-CANARY";
  await writeFile(path, canary, { mode: 0o600 }); const handle = await open(path, "r");
  try {
    const entry = new URL("./web-broker-fixture.mjs", import.meta.url);
    const search = await invokeResearchWebBroker({ providerId: "serper-search", capability: "search",
      request: { query: "public", count: 1, country: "US", searchLanguage: "en" },
      credentialRef: "external-file:serper-search/m5r", credentialFd: handle.fd }, { entry });
    const extract = await invokeResearchWebBroker({ providerId: "tavily-extract", capability: "extract",
      request: { url: "https://example.com/" }, credentialRef: "external-file:tavily-extract/m5r", credentialFd: handle.fd }, { entry });
    assert.equal(JSON.stringify({ search, extract }).includes(canary), false);
    for (let repeat = 0; repeat < 200; repeat += 1) assert.throws(() => invokeResearchWebBroker({ providerId: "serper-search", capability: "search",
      request: { query: "public", count: 1, country: "US", searchLanguage: "en" }, credentialRef: "external-file:forged", credentialFd: handle.fd }, { entry }), TypeError);
  } finally { await handle.close(); await rm(path, { force: true }); }
});
