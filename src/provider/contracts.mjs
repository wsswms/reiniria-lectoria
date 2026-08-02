import { createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ERROR_CATEGORIES = new Set([
  "rate-limit", "auth", "timeout", "transport", "malformed-response",
  "policy", "budget", "canceled", "unknown-outcome", "provider",
]);
const NEVER_RETRY = new Set(["auth", "malformed-response", "policy", "budget", "canceled", "unknown-outcome"]);
const MAX_OUTPUT_TOKENS = 1_000_000;
const EVIDENCE_KINDS = new Set(["term", "style", "knowledge"]);
const EVIDENCE_FIELDS = new Set(["title", "body", "terms", "tags"]);
const CONTEXT_INSTRUCTION_TYPES = new Set(["hard-constraint", "preferred", "background", "disputed", "warning-only"]);
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

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

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_OUTPUT_TOKENS) {
    throw new TypeError(`${name} must be a positive safe integer no greater than ${MAX_OUTPUT_TOKENS}`);
  }
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

function evidenceHit(input) {
  if (!input || typeof input !== "object" || typeof input.snippet !== "string" || Buffer.byteLength(input.snippet) > 4096) {
    throw new TypeError("evidence hit is invalid");
  }
  if (!EVIDENCE_KINDS.has(input.kind) || !EVIDENCE_FIELDS.has(input.matchedField)
    || input.snippetDigest !== sha(input.snippet)) throw new TypeError("evidence hit identity is invalid");
  return Object.freeze({
    rank: positiveInteger(input.rank, "evidence.rank"),
    factId: id(input.factId, "evidence.factId"),
    revisionId: id(input.revisionId, "evidence.revisionId"),
    kind: input.kind,
    language: language(input.language),
    matchedField: input.matchedField,
    snippet: input.snippet,
    snippetDigest: digest(input.snippetDigest, "evidence.snippetDigest"),
    contentDigest: digest(input.contentDigest, "evidence.contentDigest"),
  });
}

function requestEvidence(input) {
  if (!input || typeof input !== "object" || input.untrusted !== true || !input.query || Object.keys(input.query).sort().join(",") !== "language,text"
    || typeof input.query.text !== "string"
    || input.query.text.length < 1 || input.query.text.length > 512 || !Array.isArray(input.hits) || input.hits.length > 20) {
    throw new TypeError("evidence is invalid");
  }
  const hits = input.hits.map(evidenceHit);
  if (hits.some((hit, index) => hit.rank !== index + 1)
    || new Set(hits.map((hit) => `${hit.factId}:${hit.revisionId}`)).size !== hits.length) throw new TypeError("evidence hits must be ordered and unique");
  return Object.freeze({
    evidenceId: id(input.evidenceId, "evidenceId"),
    evidenceDigest: digest(input.evidenceDigest, "evidenceDigest"),
    segmentId: id(input.segmentId, "evidence.segmentId"),
    query: Object.freeze({ text: input.query.text, language: language(input.query.language) }),
    retrieverVersion: requiredString(input.retrieverVersion, "retrieverVersion"),
    queryPolicyVersion: requiredString(input.queryPolicyVersion, "queryPolicyVersion"),
    indexDigest: digest(input.indexDigest, "indexDigest"),
    untrusted: true,
    hits: Object.freeze(hits),
  });
}

function requestTranslationContext(input, segmentIds) {
  if (!input || typeof input !== "object" || input.schemaVersion !== "m5c-temporary-context-v1"
    || !UUID.test(input.contextRevisionId ?? "") || !SHA256.test(input.contextDigest ?? "")
    || !Array.isArray(input.items) || input.items.length > 256) throw new TypeError("translationContext is invalid");
  const allowed = new Set(segmentIds);
  const items = input.items.map((item) => {
    if (!item || typeof item !== "object" || !UUID.test(item.contextItemId ?? "") || !CONTEXT_INSTRUCTION_TYPES.has(item.instructionType)
      || !["plan-item", "research-claim", "user-guidance"].includes(item.sourceType) || !SHA256.test(item.sourceDigest ?? "")
      || !SHA256.test(item.contentDigest ?? "") || !Array.isArray(item.segmentIds) || item.segmentIds.some((id) => !UUID.test(id) || !allowed.has(id))
      || !item.content || typeof item.content !== "object" || Array.isArray(item.content) || typeof item.affirmative !== "boolean"
      || (["disputed", "warning-only"].includes(item.instructionType) && item.affirmative)) throw new TypeError("translationContext item is invalid");
    return Object.freeze({ ...item, segmentIds: Object.freeze([...item.segmentIds]), content: Object.freeze({ ...item.content }) });
  });
  if (Buffer.byteLength(JSON.stringify(items)) > 128 * 1024) throw new TypeError("translationContext exceeds limits");
  return Object.freeze({ schemaVersion: input.schemaVersion, contextRevisionId: input.contextRevisionId, contextDigest: input.contextDigest, items: Object.freeze(items) });
}

export function providerRequestContract(input) {
  if (!input || typeof input !== "object") throw new TypeError("provider request must be an object");
  if (!Array.isArray(input.segments) || input.segments.length === 0) throw new TypeError("segments must be a non-empty array");
  const segments = input.segments.map(requestSegment);
  if (new Set(segments.map((segment) => segment.segmentId)).size !== segments.length) throw new TypeError("duplicate segmentId");
  const output = {
    workspaceId: id(input.workspaceId, "workspaceId"),
    taskId: id(input.taskId, "taskId"),
    attemptId: id(input.attemptId, "attemptId"),
    workflowId: id(input.workflowId, "workflowId"),
    sourceRevisionId: id(input.sourceRevisionId, "sourceRevisionId"),
    targetLanguage: language(input.targetLanguage),
    providerId: requiredString(input.providerId, "providerId"),
    modelId: requiredString(input.modelId, "modelId"),
    maxOutputTokens: positiveInteger(input.maxOutputTokens ?? 1_024, "maxOutputTokens"),
    promptVersion: requiredString(input.promptVersion, "promptVersion"),
    contextDigest: digest(input.contextDigest, "contextDigest"),
    segments: Object.freeze(segments),
  };
  if (input.evidence !== undefined) {
    if (!Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 8) throw new TypeError("evidence must be a bounded array");
    const evidence = input.evidence.map(requestEvidence);
    const segmentIds = new Set(segments.map((segment) => segment.segmentId));
    if (new Set(evidence.map((item) => item.evidenceId)).size !== evidence.length
      || evidence.some((item) => !segmentIds.has(item.segmentId))
      || evidence.some((item) => item.query.language !== output.targetLanguage || item.hits.some((hit) => hit.language !== output.targetLanguage))
      || evidence.reduce((sum, item) => sum + item.hits.length, 0) > 64
      || Buffer.byteLength(JSON.stringify(evidence)) > 128 * 1024) throw new TypeError("evidence scope or limits are invalid");
    output.evidence = Object.freeze(evidence);
  }
  if (input.translationContext !== undefined) output.translationContext = requestTranslationContext(input.translationContext, segments.map((segment) => segment.segmentId));
  return Object.freeze(output);
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
  const usage = providerUsageContract(input.usage);
  if (usage.outputTokens > request.maxOutputTokens) throw new TypeError("outputTokens cannot exceed maxOutputTokens");
  return Object.freeze({
    responseId: requiredString(input.responseId, "responseId"),
    providerId: request.providerId,
    modelId: request.modelId,
    candidates: Object.freeze(candidates),
    usage,
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
