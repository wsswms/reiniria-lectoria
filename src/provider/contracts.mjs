const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ERROR_CATEGORIES = new Set([
  "rate-limit", "auth", "timeout", "transport", "malformed-response",
  "policy", "budget", "canceled", "unknown-outcome", "provider",
]);
const NEVER_RETRY = new Set(["auth", "malformed-response", "policy", "budget", "canceled", "unknown-outcome"]);

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function id(value, name) {
  if (!UUID.test(value)) throw new TypeError(`${name} must be a lowercase UUID`);
  return value;
}

function digest(value, name) {
  if (!SHA256.test(value)) throw new TypeError(`${name} must be a sha256 digest`);
  return value;
}

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function language(value) {
  requiredString(value, "targetLanguage");
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    if (!canonical) throw new RangeError();
    return canonical;
  } catch {
    throw new TypeError("targetLanguage must be a valid language tag");
  }
}

function protectedItem(input) {
  if (!input || typeof input !== "object") throw new TypeError("protected item must be an object");
  const output = {};
  if (input.index !== undefined) output.index = integer(input.index, "protected.index");
  output.kind = requiredString(input.kind, "protected.kind");
  if (input.marker !== undefined) output.marker = requiredString(input.marker, "protected.marker");
  output.value = typeof input.value === "string" ? input.value : (() => { throw new TypeError("protected.value must be a string"); })();
  if (input.digest !== undefined) output.digest = digest(input.digest, "protected.digest");
  return Object.freeze(output);
}

function requestSegment(input) {
  if (!input || typeof input !== "object") throw new TypeError("segment must be an object");
  if (typeof input.sourceText !== "string") throw new TypeError("sourceText must be a string");
  if (!Array.isArray(input.protected)) throw new TypeError("protected must be an array");
  return Object.freeze({
    segmentId: id(input.segmentId, "segmentId"),
    sourceDigest: digest(input.sourceDigest, "sourceDigest"),
    sourceText: input.sourceText,
    protected: Object.freeze(input.protected.map(protectedItem)),
  });
}

export function providerRequestContract(input) {
  if (!input || typeof input !== "object") throw new TypeError("provider request must be an object");
  if (!Array.isArray(input.segments) || input.segments.length === 0) throw new TypeError("segments must be a non-empty array");
  const segments = input.segments.map(requestSegment);
  if (new Set(segments.map((segment) => segment.segmentId)).size !== segments.length) throw new TypeError("duplicate segmentId");
  return Object.freeze({
    workspaceId: id(input.workspaceId, "workspaceId"),
    taskId: id(input.taskId, "taskId"),
    attemptId: id(input.attemptId, "attemptId"),
    workflowId: id(input.workflowId, "workflowId"),
    sourceRevisionId: id(input.sourceRevisionId, "sourceRevisionId"),
    targetLanguage: language(input.targetLanguage),
    providerId: requiredString(input.providerId, "providerId"),
    modelId: requiredString(input.modelId, "modelId"),
    promptVersion: requiredString(input.promptVersion, "promptVersion"),
    contextDigest: digest(input.contextDigest, "contextDigest"),
    segments: Object.freeze(segments),
  });
}

export function providerUsageContract(input) {
  if (!input || typeof input !== "object") throw new TypeError("usage must be an object");
  const usage = {
    inputTokens: integer(input.inputTokens, "inputTokens"),
    outputTokens: integer(input.outputTokens, "outputTokens"),
    cachedInputTokens: integer(input.cachedInputTokens, "cachedInputTokens"),
    totalTokens: integer(input.totalTokens, "totalTokens"),
  };
  if (usage.cachedInputTokens > usage.inputTokens) throw new TypeError("cachedInputTokens cannot exceed inputTokens");
  if (usage.totalTokens !== usage.inputTokens + usage.outputTokens) throw new TypeError("totalTokens must equal inputTokens plus outputTokens");
  return Object.freeze(usage);
}

export function providerResponseContract(input, requestInput) {
  if (!input || typeof input !== "object") throw new TypeError("provider response must be an object");
  const request = providerRequestContract(requestInput);
  if (!Array.isArray(input.candidates)) throw new TypeError("candidates must be an array");
  const expected = request.segments.map((segment) => segment.segmentId).sort();
  const candidates = input.candidates.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || typeof candidate.text !== "string") throw new TypeError("candidate text must be a string");
    return Object.freeze({ segmentId: id(candidate.segmentId, "segmentId"), text: candidate.text });
  });
  const actual = candidates.map((candidate) => candidate.segmentId).sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new TypeError("provider response segment set does not match request segment set");
  }
  if (input.providerId !== request.providerId) throw new TypeError("providerId does not match request");
  if (input.modelId !== request.modelId) throw new TypeError("modelId does not match request");
  return Object.freeze({
    responseId: requiredString(input.responseId, "responseId"),
    providerId: request.providerId,
    modelId: request.modelId,
    candidates: Object.freeze(candidates),
    usage: providerUsageContract(input.usage),
  });
}

export function providerErrorContract(input) {
  if (!input || typeof input !== "object") throw new TypeError("provider error must be an object");
  if (!ERROR_CATEGORIES.has(input.category)) throw new TypeError("provider error category is invalid");
  if (typeof input.retryable !== "boolean") throw new TypeError("retryable must be boolean");
  if (input.retryable && NEVER_RETRY.has(input.category)) throw new TypeError(`${input.category} errors cannot be retryable`);
  const output = {
    category: input.category,
    message: requiredString(input.message, "message"),
    retryable: input.retryable,
  };
  if (input.providerCode !== undefined) output.providerCode = requiredString(input.providerCode, "providerCode");
  return Object.freeze(output);
}
