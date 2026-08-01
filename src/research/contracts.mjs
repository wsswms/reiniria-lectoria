import { digest, opaqueId, stableJson } from "../domain/contracts.mjs";

export const RESEARCH_CONTRACT_VERSION = "1.0";
export const RESEARCH_LIMITS = Object.freeze({
  defaults: Object.freeze({ maxRounds: 5, maxSearchCalls: 12, maxResultsPerSearch: 10, maxContentUrls: 16, maxDurationSeconds: 1_800, maxRuns: 2, maxModelTokens: 0, maxCostMicrosUsd: 0 }),
  maxima: Object.freeze({ maxRounds: 10, maxSearchCalls: 30, maxResultsPerSearch: 10, maxContentUrls: 40, maxDurationSeconds: 5_400, maxRuns: 3, maxModelTokens: 10_000_000, maxCostMicrosUsd: 1_000_000 }),
});

const CAPABILITIES = new Set(["search", "fetch", "extract", "research-model"]);
const RUN_STATES = new Set(["queued", "running", "paused", "completed", "failed", "canceled"]);
const RUN_OUTCOMES = new Set(["supported", "disputed", "insufficient", "partial"]);
const LINEAGE = new Set(["direct", "provider-processed", "search-snippet"]);
const SOURCE_TIERS = new Set(["S1", "S2", "S3", "S4", "S5"]);
const CLAIM_LEVELS = new Set(["C0", "C1", "C2", "C3", "CD", "CI"]);

function exact(input, keys, name) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw new TypeError(`${name} contains an unknown field`);
}

function text(value, name, max = 16_384) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) throw new TypeError(`${name} must be a bounded non-empty string`);
  return value;
}

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${name} is outside its hard limit`);
  return value;
}

function iso(value, name) {
  text(value, name, 64);
  if (new Date(value).toISOString() !== value) throw new TypeError(`${name} must be a canonical ISO timestamp`);
  return value;
}

function language(value, name) {
  text(value, name, 63);
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    if (!canonical) throw new RangeError();
    return canonical;
  } catch { throw new TypeError(`${name} must be a valid language tag`); }
}

function uniqueStrings(value, name, { min = 0, max = 64, itemMax = 2_048, sort = true } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new TypeError(`${name} must be a bounded array`);
  const output = value.map((item) => text(item, name, itemMax));
  if (new Set(output).size !== output.length) throw new TypeError(`${name} must not contain duplicates`);
  if (sort) output.sort((left, right) => left.localeCompare(right));
  return Object.freeze(output);
}

function version(input, name) {
  if (input.schemaVersion !== RESEARCH_CONTRACT_VERSION) throw new TypeError(`${name} has an unsupported version`);
}

function actor(input, name, allowed) {
  exact(input, ["type", "id"], name);
  if (!allowed.includes(input.type)) throw new TypeError(`${name}.type is not authorized`);
  return Object.freeze({ type: input.type, id: text(input.id, `${name}.id`, 255) });
}

function canonicalObject(input, name, maxBytes = 65_536) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError(`${name} must be an object`);
  const serialized = stableJson(input);
  if (Buffer.byteLength(serialized) > maxBytes) throw new TypeError(`${name} is too large`);
  return Object.freeze(JSON.parse(serialized));
}

export function researchRequestContract(input) {
  exact(input, ["schemaVersion", "requestId", "revisionId", "taskId", "workflowId", "documentId", "sourceRevisionId", "targetLanguage", "segmentIds", "gapKinds", "questions", "localEvidenceDigest", "origin", "createdAt"], "research request");
  version(input, "research request");
  const gapKinds = uniqueStrings(input.gapKinds, "gapKinds", { min: 1, max: 4, itemMax: 32 });
  if (gapKinds.some((item) => !["term", "proper-name", "background-fact", "translation-rationale"].includes(item))) throw new TypeError("gapKinds contains an unsupported kind");
  return Object.freeze({ schemaVersion: RESEARCH_CONTRACT_VERSION,
    requestId: opaqueId(input.requestId, "requestId"), revisionId: opaqueId(input.revisionId, "revisionId"),
    taskId: opaqueId(input.taskId, "taskId"), workflowId: opaqueId(input.workflowId, "workflowId"),
    documentId: opaqueId(input.documentId, "documentId"), sourceRevisionId: opaqueId(input.sourceRevisionId, "sourceRevisionId"),
    targetLanguage: language(input.targetLanguage, "targetLanguage"),
    segmentIds: uniqueStrings(input.segmentIds, "segmentIds", { min: 1, max: 64, itemMax: 255 }), gapKinds,
    questions: uniqueStrings(input.questions, "questions", { min: 1, max: 32, itemMax: 2_048, sort: false }),
    localEvidenceDigest: digest(input.localEvidenceDigest, "localEvidenceDigest"),
    origin: actor(input.origin, "origin", ["user", "system", "model", "fixture"]), createdAt: iso(input.createdAt, "createdAt") });
}

function limitsContract(input) {
  exact(input, Object.keys(RESEARCH_LIMITS.maxima), "limits");
  const output = {};
  for (const [key, maximum] of Object.entries(RESEARCH_LIMITS.maxima)) output[key] = integer(input[key], `limits.${key}`, 0, maximum);
  for (const key of ["maxRounds", "maxSearchCalls", "maxResultsPerSearch", "maxContentUrls", "maxDurationSeconds", "maxRuns"]) if (output[key] < 1) throw new TypeError(`limits.${key} must be positive`);
  return Object.freeze(output);
}

function providerBudgetContract(input) {
  const maxima = { maxSearchCalls: RESEARCH_LIMITS.maxima.maxSearchCalls, maxContentUrls: RESEARCH_LIMITS.maxima.maxContentUrls,
    maxModelTokens: RESEARCH_LIMITS.maxima.maxModelTokens, maxCostMicrosUsd: RESEARCH_LIMITS.maxima.maxCostMicrosUsd };
  exact(input, Object.keys(maxima), "provider budget");
  return Object.freeze(Object.fromEntries(Object.entries(maxima).map(([key, maximum]) =>
    [key, integer(input[key], `provider budget.${key}`, 0, maximum)])));
}

function providerContract(input) {
  exact(input, ["capability", "providerId", "fallbackOrder", "budget"], "provider");
  if (!CAPABILITIES.has(input.capability)) throw new TypeError("provider capability is invalid");
  return Object.freeze({ capability: input.capability, providerId: text(input.providerId, "providerId", 127),
    fallbackOrder: integer(input.fallbackOrder, "fallbackOrder", 0, 16), budget: providerBudgetContract(input.budget) });
}

export function researchGrantContract(input) {
  exact(input, ["schemaVersion", "grantId", "requestId", "requestRevisionId", "providers", "limits", "allowedDomains", "allowedLanguages", "approvedBy", "approvedAt", "expiresAt"], "research grant");
  version(input, "research grant");
  if (!Array.isArray(input.providers) || input.providers.length < 1 || input.providers.length > 16) throw new TypeError("providers must be bounded");
  const providers = input.providers.map(providerContract).sort((a, b) => a.capability.localeCompare(b.capability) || a.fallbackOrder - b.fallbackOrder);
  const identities = providers.map((item) => `${item.capability}\0${item.fallbackOrder}`);
  if (new Set(identities).size !== identities.length) throw new TypeError("provider fallback slots must be unique");
  const approvedAt = iso(input.approvedAt, "approvedAt");
  const expiresAt = iso(input.expiresAt, "expiresAt");
  if (expiresAt <= approvedAt) throw new TypeError("grant must expire after approval");
  if (!Array.isArray(input.allowedLanguages)) throw new TypeError("allowedLanguages must be an array");
  const allowedLanguages = input.allowedLanguages.map((item) => language(item, "allowedLanguage")).sort();
  if (new Set(allowedLanguages).size !== allowedLanguages.length) throw new TypeError("allowedLanguages must not contain duplicates");
  return Object.freeze({ schemaVersion: RESEARCH_CONTRACT_VERSION, grantId: opaqueId(input.grantId, "grantId"),
    requestId: opaqueId(input.requestId, "requestId"), requestRevisionId: opaqueId(input.requestRevisionId, "requestRevisionId"),
    providers: Object.freeze(providers), limits: limitsContract(input.limits),
    allowedDomains: uniqueStrings(input.allowedDomains, "allowedDomains", { max: 128, itemMax: 253 }),
    allowedLanguages: Object.freeze(allowedLanguages),
    approvedBy: actor(input.approvedBy, "approvedBy", ["user"]), approvedAt, expiresAt });
}

export function researchRunContract(input) {
  exact(input, ["schemaVersion", "runId", "grantId", "attempt", "state", "round", "requestDigest", "startedAt", "deadlineAt", "pauseReason"], "research run");
  version(input, "research run");
  if (!RUN_STATES.has(input.state)) throw new TypeError("research run state is invalid");
  if ((input.state === "paused") !== (input.pauseReason !== null)) throw new TypeError("pauseReason must exist only for paused runs");
  return Object.freeze({ schemaVersion: RESEARCH_CONTRACT_VERSION, runId: opaqueId(input.runId, "runId"), grantId: opaqueId(input.grantId, "grantId"),
    attempt: integer(input.attempt, "attempt", 1, RESEARCH_LIMITS.maxima.maxRuns), state: input.state,
    round: integer(input.round, "round", 0, RESEARCH_LIMITS.maxima.maxRounds), requestDigest: digest(input.requestDigest, "requestDigest"),
    startedAt: iso(input.startedAt, "startedAt"), deadlineAt: iso(input.deadlineAt, "deadlineAt"),
    pauseReason: input.pauseReason === null ? null : text(input.pauseReason, "pauseReason", 127) });
}

export function researchQueryContract(input) {
  exact(input, ["schemaVersion", "queryId", "runId", "round", "capability", "providerId", "query", "language", "country", "requestDigest", "idempotencyKey"], "research query");
  version(input, "research query");
  if (!CAPABILITIES.has(input.capability)) throw new TypeError("query capability is invalid");
  if (!/^[A-Za-z]{2}$/.test(input.country)) throw new TypeError("country must be a two-letter code");
  return Object.freeze({ schemaVersion: RESEARCH_CONTRACT_VERSION, queryId: opaqueId(input.queryId, "queryId"), runId: opaqueId(input.runId, "runId"),
    round: integer(input.round, "round", 1, RESEARCH_LIMITS.maxima.maxRounds), capability: input.capability,
    providerId: text(input.providerId, "providerId", 127), query: text(input.query, "query", 2_048),
    language: language(input.language, "language"), country: text(input.country, "country", 2).toUpperCase(),
    requestDigest: digest(input.requestDigest, "requestDigest"), idempotencyKey: text(input.idempotencyKey, "idempotencyKey", 255) });
}

export function researchSourceContract(input) {
  exact(input, ["schemaVersion", "sourceId", "runId", "queryId", "canonicalUrl", "urlDigest", "sourceClusterId", "tier", "lineage", "artifactType", "artifactId", "artifactDigest", "retrievedAt"], "research source");
  version(input, "research source");
  if (!SOURCE_TIERS.has(input.tier)) throw new TypeError("source tier is invalid");
  if (!LINEAGE.has(input.lineage)) throw new TypeError("source lineage is invalid");
  if (input.lineage === "provider-processed" && input.artifactType === "fetch-snapshot") throw new TypeError("provider-processed content cannot be direct fetch evidence");
  return Object.freeze({ schemaVersion: RESEARCH_CONTRACT_VERSION, sourceId: opaqueId(input.sourceId, "sourceId"), runId: opaqueId(input.runId, "runId"),
    queryId: opaqueId(input.queryId, "queryId"), canonicalUrl: new URL(text(input.canonicalUrl, "canonicalUrl", 4_096)).toString(),
    urlDigest: digest(input.urlDigest, "urlDigest"), sourceClusterId: opaqueId(input.sourceClusterId, "sourceClusterId"), tier: input.tier, lineage: input.lineage,
    artifactType: text(input.artifactType, "artifactType", 63), artifactId: text(input.artifactId, "artifactId", 255),
    artifactDigest: digest(input.artifactDigest, "artifactDigest"), retrievedAt: iso(input.retrievedAt, "retrievedAt") });
}

export function researchCitationContract(input) {
  exact(input, ["schemaVersion", "citationId", "sourceId", "quote", "quoteDigest", "locator", "verified"], "research citation");
  version(input, "research citation");
  if (typeof input.verified !== "boolean") throw new TypeError("verified must be boolean");
  return Object.freeze({ schemaVersion: RESEARCH_CONTRACT_VERSION, citationId: opaqueId(input.citationId, "citationId"), sourceId: opaqueId(input.sourceId, "sourceId"),
    quote: text(input.quote, "quote", 16_384), quoteDigest: digest(input.quoteDigest, "quoteDigest"), locator: canonicalObject(input.locator, "locator", 4_096),
    verified: input.verified === true });
}

export function researchClaimContract(input) {
  exact(input, ["schemaVersion", "claimId", "runId", "text", "claimDigest", "supportLevel", "citationIds", "inference"], "research claim");
  version(input, "research claim");
  if (!CLAIM_LEVELS.has(input.supportLevel)) throw new TypeError("claim support level is invalid");
  const citationIds = uniqueStrings(input.citationIds, "citationIds", { max: 64, itemMax: 255 });
  if (["C2", "C3"].includes(input.supportLevel) && (citationIds.length === 0 || input.inference === true)) throw new TypeError("C2/C3 claims require direct citations and cannot be inference-only");
  return Object.freeze({ schemaVersion: RESEARCH_CONTRACT_VERSION, claimId: opaqueId(input.claimId, "claimId"), runId: opaqueId(input.runId, "runId"),
    text: text(input.text, "claim text", 16_384), claimDigest: digest(input.claimDigest, "claimDigest"), supportLevel: input.supportLevel,
    citationIds, inference: input.inference === true });
}

export function researchReportContract(input) {
  exact(input, ["schemaVersion", "reportId", "runId", "outcome", "stopReason", "questionAnswers", "claimIds", "usage", "reportDigest", "createdAt"], "research report");
  version(input, "research report");
  if (!RUN_OUTCOMES.has(input.outcome)) throw new TypeError("report outcome is invalid");
  exact(input.usage, ["searchCalls", "contentUrls", "modelTokens", "costMicrosUsd"], "report usage");
  if (!Array.isArray(input.questionAnswers) || input.questionAnswers.length > 64) throw new TypeError("questionAnswers must be a bounded array");
  return Object.freeze({ schemaVersion: RESEARCH_CONTRACT_VERSION, reportId: opaqueId(input.reportId, "reportId"), runId: opaqueId(input.runId, "runId"),
    outcome: input.outcome, stopReason: text(input.stopReason, "stopReason", 127),
    questionAnswers: Object.freeze(input.questionAnswers.map((item) => canonicalObject(item, "questionAnswer", 16_384))),
    claimIds: uniqueStrings(input.claimIds, "claimIds", { max: 256, itemMax: 255 }), usage: Object.freeze({
      searchCalls: integer(input.usage.searchCalls, "usage.searchCalls", 0, RESEARCH_LIMITS.maxima.maxSearchCalls),
      contentUrls: integer(input.usage.contentUrls, "usage.contentUrls", 0, RESEARCH_LIMITS.maxima.maxContentUrls),
      modelTokens: integer(input.usage.modelTokens, "usage.modelTokens", 0, RESEARCH_LIMITS.maxima.maxModelTokens),
      costMicrosUsd: integer(input.usage.costMicrosUsd, "usage.costMicrosUsd", 0, RESEARCH_LIMITS.maxima.maxCostMicrosUsd),
    }), reportDigest: digest(input.reportDigest, "reportDigest"), createdAt: iso(input.createdAt, "createdAt") });
}
