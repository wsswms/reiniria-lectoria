import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  providerErrorContract,
  providerRequestContract,
  providerResponseContract,
  providerUsageContract,
} from "../../src/provider/contracts.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function requestFixture(overrides = {}) {
  return {
    workspaceId: randomUUID(),
    taskId: randomUUID(),
    attemptId: randomUUID(),
    workflowId: randomUUID(),
    sourceRevisionId: randomUUID(),
    targetLanguage: "ZH-hans-cn",
    providerId: "fake-primary",
    modelId: "fixture-model-v1",
    promptVersion: "prompt-v1",
    contextDigest: sha("context"),
    segments: [
      { segmentId: randomUUID(), sourceDigest: sha("source-1"), sourceText: "Hello", protected: [] },
      { segmentId: randomUUID(), sourceDigest: sha("source-2"), sourceText: "World", protected: [{ kind: "code", value: "x" }] },
    ],
    ...overrides,
  };
}

test("provider requests are canonical, immutable and exclude unrecognized secret fields", () => {
  const canary = "M4-SECRET-CANARY";
  const request = providerRequestContract({
    ...requestFixture(),
    apiKey: canary,
    providerRequest: canary,
    nested: { authorization: canary },
  });
  assert.equal(request.targetLanguage, "zh-Hans-CN");
  assert.equal(JSON.stringify(request).includes(canary), false);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.segments), true);
  assert.equal(Object.isFrozen(request.segments[0]), true);
  assert.equal(Object.isFrozen(request.segments[1].protected[0]), true);
});

test("provider responses require an exact one-to-one segment set and normalized usage", () => {
  const request = providerRequestContract(requestFixture());
  const usage = { inputTokens: 25, outputTokens: 11, cachedInputTokens: 5, totalTokens: 36 };
  const response = providerResponseContract({
    responseId: "fake-response-1",
    providerId: request.providerId,
    modelId: request.modelId,
    candidates: request.segments.map((segment) => ({ segmentId: segment.segmentId, text: `target:${segment.sourceText}` })),
    usage,
    rawResponse: "must-not-survive",
  }, request);
  assert.deepEqual(response.usage, usage);
  assert.equal("rawResponse" in response, false);
  assert.throws(() => providerResponseContract({ ...response, candidates: response.candidates.slice(1) }, request), /segment set/);
  assert.throws(() => providerResponseContract({ ...response, candidates: [response.candidates[0], response.candidates[0]] }, request), /segment set/);
  assert.throws(() => providerResponseContract({ ...response, candidates: [...response.candidates, { segmentId: randomUUID(), text: "x" }] }, request), /segment set/);
});

test("usage and errors use provider-neutral bounded classifications", () => {
  assert.deepEqual(providerUsageContract({ inputTokens: 10, outputTokens: 4, cachedInputTokens: 3, totalTokens: 14 }), {
    inputTokens: 10, outputTokens: 4, cachedInputTokens: 3, totalTokens: 14,
  });
  assert.throws(() => providerUsageContract({ inputTokens: 10, outputTokens: 4, cachedInputTokens: 11, totalTokens: 14 }), /cachedInputTokens/);
  assert.throws(() => providerUsageContract({ inputTokens: 10, outputTokens: 4, cachedInputTokens: 0, totalTokens: 99 }), /totalTokens/);
  assert.deepEqual(providerErrorContract({ category: "rate-limit", message: "limited", retryable: true, providerCode: "429", apiKey: "secret" }), {
    category: "rate-limit", message: "limited", retryable: true, providerCode: "429",
  });
  assert.throws(() => providerErrorContract({ category: "auth", message: "bad key", retryable: true }), /retryable/);
  assert.throws(() => providerErrorContract({ category: "mystery", message: "x", retryable: false }), /category/);
});

test("malformed provider identities and segment contracts fail closed", () => {
  const fixture = requestFixture();
  assert.throws(() => providerRequestContract({ ...fixture, workspaceId: "workspace" }), /workspaceId/);
  assert.throws(() => providerRequestContract({ ...fixture, providerId: "" }), /providerId/);
  assert.throws(() => providerRequestContract({ ...fixture, segments: [] }), /segments/);
  assert.throws(() => providerRequestContract({ ...fixture, segments: [fixture.segments[0], fixture.segments[0]] }), /duplicate segmentId/);
  assert.throws(() => providerRequestContract({ ...fixture, contextDigest: "sha256:bad" }), /contextDigest/);
});
