import assert from "node:assert/strict";
import { open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DEEPSEEK_RESEARCH_CREDENTIAL_REF, invokeDeepSeekResearchBroker } from "../../src/research/deepseek-research-broker-process.mjs";

const researchCase = { schemaVersion: "deepseek-server-research-case-v1", caseId: "broker-case", question: "Find a public synthetic fact.",
  responseLanguage: "zh-CN", maxOutputTokens: 1000, reasoningEffort: "low" };

test("DeepSeek research Broker receives its credential only through fd 3 and emits a normalized secret-free result", async () => {
  const path = join(tmpdir(), `m5f1-broker-${process.pid}.key`); const canary = "M5F1-FD-CANARY";
  await writeFile(path, canary, { mode: 0o600 }); const handle = await open(path, "r");
  try {
    const result = await invokeDeepSeekResearchBroker({ researchCase, credentialRef: DEEPSEEK_RESEARCH_CREDENTIAL_REF,
      credentialFd: handle.fd }, { entry: new URL("./deepseek-broker-fixture.mjs", import.meta.url), timeoutMs: 5_000 });
    assert.equal(result.outcome, "not-found");
    assert.equal(JSON.stringify(result).includes(canary), false);
    for (let repeat = 0; repeat < 100; repeat += 1) assert.throws(() => invokeDeepSeekResearchBroker({ researchCase,
      credentialRef: "external-file:forged", credentialFd: handle.fd }, { entry: new URL("./deepseek-broker-fixture.mjs", import.meta.url) }), TypeError);
  } finally { await handle.close(); await rm(path, { force: true }); }
});

test("broker cancellation terminates the child and returns a bounded category", async () => {
  const path = join(tmpdir(), `m5f1-broker-cancel-${process.pid}.key`);
  await writeFile(path, "M5F1-FD-CANARY", { mode: 0o600 }); const handle = await open(path, "r");
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => invokeDeepSeekResearchBroker({ researchCase, credentialRef: DEEPSEEK_RESEARCH_CREDENTIAL_REF,
      credentialFd: handle.fd, signal: controller.signal }, { entry: new URL("./deepseek-broker-fixture.mjs", import.meta.url), timeoutMs: 5_000 }),
    (error) => error.category === "canceled" && !error.retryable);
  } finally { await handle.close(); await rm(path, { force: true }); }
});
