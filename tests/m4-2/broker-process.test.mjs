import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { invokeBrokerProcess, BrokerProcessError } from "../../src/provider/broker-process.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function request(providerId = "fake-primary") {
  return {
    workspaceId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), workflowId: randomUUID(), sourceRevisionId: randomUUID(),
    targetLanguage: "zh-CN", providerId, modelId: "fixture-model-v1", promptVersion: "prompt-v1", contextDigest: sha("context"),
    segments: [{ segmentId: randomUUID(), sourceDigest: sha("source"), sourceText: "Hello", protected: [] }],
  };
}

test("independent Broker receives credentials through a dedicated descriptor and returns only normalized data", async () => {
  const canary = `M4-BROKER-SECRET-${randomUUID()}`;
  for (let index = 0; index < 20; index += 1) {
    const response = await invokeBrokerProcess({ request: request(), credentialRef: "test:fake-primary", credential: canary });
    assert.equal(response.providerId, "fake-primary");
    assert.equal(JSON.stringify(response).includes(canary), false);
  }
});

test("Broker fixed allowlist and fault normalization fail closed without secret leakage", async () => {
  const canary = `M4-BROKER-SECRET-${randomUUID()}`;
  await assert.rejects(invokeBrokerProcess({ request: request("not-allowed"), credentialRef: "test:no", credential: canary }), (error) => error instanceof BrokerProcessError && error.category === "policy" && !error.message.includes(canary));
  await assert.rejects(invokeBrokerProcess({ request: request("fake-fault"), credentialRef: "test:fault", credential: canary, faultMode: "auth" }), (error) => error instanceof BrokerProcessError && error.category === "auth" && !error.message.includes(canary));
});
