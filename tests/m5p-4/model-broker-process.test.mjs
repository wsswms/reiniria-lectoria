import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { invokeAgentModelBroker } from "../../src/agent/model-broker-process.mjs";

test("Agent Model Broker accepts credentials only through fd 3 and returns normalized data", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5p4-broker-"));
  const path = join(root, "credential");
  await writeFile(path, "fixture-agent-secret\n", { mode: 0o600 });
  const handle = await open(path, "r");
  try {
    const request = { modelId: "deepseek-chat", context: { messages: [{ segmentId: "segment-1" }] }, mode: "normal", toolNames: [], maxOutputTokens: 128 };
    const response = await invokeAgentModelBroker({ request, credentialFd: handle.fd },
      { entry: new URL("./model-broker-fixture.mjs", import.meta.url) });
    assert.equal(response.responseId, "fixture-agent");
    assert.equal(response.candidates[0].text, "离线译文");
  } finally { await handle.close(); await rm(root, { recursive: true, force: true }); }
});
