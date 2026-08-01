import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { providerResponseContract } from "../../src/provider/contracts.mjs";
import { CapabilityAuthority } from "../../src/runner/capability.mjs";
import { invokeProviderThroughRunner } from "../../src/runner/provider-runner.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

test("normalized Broker responses pass through the isolated Pi Runner before returning to the control plane", async () => {
  const request = {
    workspaceId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), workflowId: randomUUID(), sourceRevisionId: randomUUID(),
    targetLanguage: "zh-CN", providerId: "fake-primary", modelId: "fixture-model-v1", maxOutputTokens: 64,
    promptVersion: "prompt-v1", contextDigest: sha("context"),
    segments: [{ segmentId: randomUUID(), sourceDigest: sha("source"), sourceText: "Public source", protected: [] }],
  };
  let brokerCalls = 0;
  const response = await invokeProviderThroughRunner({
    request,
    capabilityAuthority: new CapabilityAuthority(randomBytes(32)),
    invokeProvider: async (actual) => {
      brokerCalls += 1;
      return providerResponseContract({
        responseId: "broker-response",
        providerId: actual.providerId,
        modelId: actual.modelId,
        candidates: [{ segmentId: actual.segments[0].segmentId, text: "公开译文" }],
        usage: { inputTokens: 8, outputTokens: 4, cachedInputTokens: 0, totalTokens: 12 },
      }, actual);
    },
  });
  assert.equal(brokerCalls, 1);
  assert.equal(response.responseId, "broker-response");
  assert.equal(response.candidates[0].text, "公开译文");
});
