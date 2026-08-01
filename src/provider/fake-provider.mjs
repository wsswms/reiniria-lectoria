import { createHash } from "node:crypto";
import { providerErrorContract, providerRequestContract, providerResponseContract } from "./contracts.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");

function successfulResponse(request, extras = {}) {
  const inputTokens = request.segments.reduce((total, segment) => total + Math.max(1, Math.ceil(segment.sourceText.length / 4)), 0);
  const outputTokens = request.segments.reduce((total, segment) => total + Math.max(1, Math.ceil((request.targetLanguage.length + segment.sourceText.length + 1) / 4)), 0);
  return providerResponseContract({
    responseId: `fake-${sha(`${request.attemptId}:${request.contextDigest}`).slice(0, 24)}`,
    providerId: request.providerId,
    modelId: request.modelId,
    candidates: request.segments.map((segment) => ({ segmentId: segment.segmentId, text: `${request.targetLanguage}:${segment.sourceText}` })),
    usage: { inputTokens, outputTokens, cachedInputTokens: 0, totalTokens: inputTokens + outputTokens },
    ...extras,
  }, request);
}

export class ProviderInvocationError extends Error {
  constructor(contract) {
    super(contract.message);
    this.name = "ProviderInvocationError";
    this.category = contract.category;
    this.retryable = contract.retryable;
    if (contract.providerCode !== undefined) this.providerCode = contract.providerCode;
  }
}

export class DeterministicFakeProvider {
  constructor({ id = "fake-primary" } = {}) {
    this.id = id;
    this.calls = 0;
  }

  async invoke(input) {
    const request = providerRequestContract(input);
    if (request.providerId !== this.id) throw new TypeError("providerId does not match adapter");
    this.calls += 1;
    return successfulResponse(request);
  }
}

const FAULTS = Object.freeze({
  "rate-limit": { category: "rate-limit", message: "fake provider rate limited", retryable: true, providerCode: "429" },
  auth: { category: "auth", message: "fake provider authentication failed", retryable: false, providerCode: "401" },
  timeout: { category: "timeout", message: "fake provider timed out", retryable: true },
  transport: { category: "transport", message: "fake provider transport failed", retryable: true },
  malformed: { category: "malformed-response", message: "fake provider returned malformed data", retryable: false },
  "unknown-outcome": { category: "unknown-outcome", message: "fake provider outcome is unknown", retryable: false },
});

export class FaultInjectingFakeProvider extends DeterministicFakeProvider {
  constructor({ mode, canary: _canary, ...options } = {}) {
    super(options);
    this.mode = mode;
  }

  async invoke(input) {
    const request = providerRequestContract(input);
    if (request.providerId !== this.id) throw new TypeError("providerId does not match adapter");
    this.calls += 1;
    if (this.mode === "success-with-private-fields") {
      return successfulResponse(request, { rawResponse: "private", authorization: "private", providerInternal: { token: "private" } });
    }
    const failure = FAULTS[this.mode];
    if (!failure) throw new TypeError("unknown fake provider mode");
    throw new ProviderInvocationError(providerErrorContract(failure));
  }
}
