import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  BrokerInvocationError,
  createCredentialResolver,
  createProviderBroker,
  credentialReferenceContract,
} from "../../src/provider/broker-contract.mjs";
import { DeterministicFakeProvider } from "../../src/provider/fake-provider.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function requestFixture() {
  return {
    workspaceId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), workflowId: randomUUID(), sourceRevisionId: randomUUID(),
    targetLanguage: "zh-CN", providerId: "fake-primary", modelId: "fixture-model-v1", promptVersion: "prompt-v1", contextDigest: sha("context"),
    segments: [{ segmentId: randomUUID(), sourceDigest: sha("source"), sourceText: "Hello", protected: [] }],
  };
}

test("credential references are opaque identifiers rather than credential values", () => {
  assert.equal(credentialReferenceContract("env:provider/fake-primary"), "env:provider/fake-primary");
  for (const invalid of ["", "raw secret", "Bearer abc", "API_KEY=abc", "https://user:pass@example.test"]) {
    assert.throws(() => credentialReferenceContract(invalid), /credentialRef/);
  }
});

test("broker resolves credentials only around the selected adapter invocation", async () => {
  const canary = "M4-SECRET-CANARY-7f27";
  const observations = [];
  const provider = new DeterministicFakeProvider({ id: "fake-primary" });
  const adapter = {
    async invoke(request, context) {
      observations.push({ providerId: request.providerId, credential: context.credential });
      return provider.invoke(request);
    },
  };
  const resolver = createCredentialResolver(async (reference) => {
    observations.push(reference);
    return canary;
  });
  const broker = createProviderBroker({ adapters: new Map([["fake-primary", adapter]]), credentialResolver: resolver });
  const response = await broker.invoke({ request: requestFixture(), credentialRef: "env:provider/fake-primary" });

  assert.equal(observations[0].credentialRef, "env:provider/fake-primary");
  assert.equal(observations[1].credential, canary);
  assert.equal(JSON.stringify({ broker, resolver, response }).includes(canary), false);
  assert.equal(JSON.stringify(response).includes(canary), false);
});

test("broker fails closed and redacts provider-private errors", async () => {
  const canary = "M4-SECRET-CANARY-private-error";
  const resolver = createCredentialResolver(async () => canary);
  const broker = createProviderBroker({
    adapters: new Map([["fake-primary", { async invoke() { throw new Error(`upstream rejected ${canary}`); } }]]),
    credentialResolver: resolver,
  });
  await assert.rejects(
    broker.invoke({ request: requestFixture(), credentialRef: "memory:test" }),
    (error) => error instanceof BrokerInvocationError
      && error.category === "provider"
      && error.retryable === false
      && !error.message.includes(canary)
      && !JSON.stringify(error).includes(canary),
  );
});

test("broker rejects unregistered providers before credential resolution", async () => {
  let resolutions = 0;
  const resolver = createCredentialResolver(async () => { resolutions += 1; return "unused"; });
  const broker = createProviderBroker({
    adapters: new Map([["other", new DeterministicFakeProvider({ id: "other" })]]),
    credentialResolver: resolver,
  });
  await assert.rejects(broker.invoke({ request: requestFixture(), credentialRef: "env:unused" }), (error) => error.category === "policy");
  assert.equal(resolutions, 0);
});
