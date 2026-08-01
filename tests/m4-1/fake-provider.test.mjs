import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { providerRequestContract } from "../../src/provider/contracts.mjs";
import { DeterministicFakeProvider, FaultInjectingFakeProvider } from "../../src/provider/fake-provider.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function requestFixture(index) {
  return providerRequestContract({
    workspaceId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), workflowId: randomUUID(), sourceRevisionId: randomUUID(),
    targetLanguage: "ja", providerId: "fake-primary", modelId: "fixture-model-v1", promptVersion: "prompt-v1", contextDigest: sha(`context-${index}`),
    segments: [{ segmentId: randomUUID(), sourceDigest: sha(`source-${index}`), sourceText: `Source ${index}`, protected: [] }],
  });
}

test("two fake providers normalize one hundred successful contract cases identically", async () => {
  const primary = new DeterministicFakeProvider({ id: "fake-primary" });
  const noisy = new FaultInjectingFakeProvider({ id: "fake-primary", mode: "success-with-private-fields" });
  for (let index = 0; index < 100; index += 1) {
    const request = requestFixture(index);
    assert.deepEqual(await noisy.invoke(request), await primary.invoke(request));
  }
  assert.equal(primary.calls, 100);
  assert.equal(noisy.calls, 100);
});

test("fault provider emits deterministic bounded failures without exposing canaries", async () => {
  const request = requestFixture(1);
  for (const [mode, category, retryable] of [
    ["rate-limit", "rate-limit", true], ["auth", "auth", false], ["timeout", "timeout", true],
    ["transport", "transport", true], ["malformed", "malformed-response", false], ["unknown-outcome", "unknown-outcome", false],
  ]) {
    const provider = new FaultInjectingFakeProvider({ id: "fake-primary", mode, canary: "M4-SECRET-CANARY" });
    await assert.rejects(provider.invoke(request), (error) => {
      assert.equal(error.category, category);
      assert.equal(error.retryable, retryable);
      assert.equal(JSON.stringify(error).includes("M4-SECRET-CANARY"), false);
      return true;
    });
  }
});
