import { isIP } from "node:net";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const DECIMAL = /^-?(?:0|[1-9][0-9]{0,99})(?:\.[0-9]{1,30})?$/;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function exact(input, keys, name) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== keys.length || Object.keys(input).some((key) => !keys.includes(key))) {
    throw new TypeError(`${name} is invalid`);
  }
}

function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

function providerBinding(input, kind) {
  if (input === null) return null;
  exact(input, ["providerId", "providerVersion", "maxCalls", "maxCostMicrosUsd", "allowedDomains"], `${kind} provider binding`);
  if (!ID.test(input.providerId) || !ID.test(input.providerVersion) || !Array.isArray(input.allowedDomains)
    || input.allowedDomains.length < 1 || input.allowedDomains.length > 64) throw new TypeError(`${kind} provider binding is invalid`);
  const domains = input.allowedDomains.map((item) => {
    if (typeof item !== "string" || item.length > 253 || item !== item.toLocaleLowerCase()) throw new TypeError(`${kind} domain is invalid`);
    let hostname;
    try { hostname = new URL(`https://${item}`).hostname; } catch { throw new TypeError(`${kind} domain is invalid`); }
    if (hostname !== item || hostname === "localhost" || isIP(hostname)) throw new TypeError(`${kind} domain is invalid`);
    return hostname;
  });
  if (new Set(domains).size !== domains.length) throw new TypeError(`${kind} domains must be unique`);
  return Object.freeze({ providerId: input.providerId, providerVersion: input.providerVersion,
    maxCalls: integer(input.maxCalls, `${kind}.maxCalls`, 1, 1_000),
    maxCostMicrosUsd: integer(input.maxCostMicrosUsd, `${kind}.maxCostMicrosUsd`, 0, 1_000_000_000),
    allowedDomains: Object.freeze([...domains]) });
}

function numberBinding(input) {
  if (input === null) return null;
  exact(input, ["providerId", "providerVersion", "maxCalls"], "number provider binding");
  if (input.providerId !== "local-number" || input.providerVersion !== "local-number-v1") throw new TypeError("number provider binding is invalid");
  return Object.freeze({ providerId: input.providerId, providerVersion: input.providerVersion,
    maxCalls: integer(input.maxCalls, "number.maxCalls", 1, 10_000) });
}

export function translationToolConfigurationContract(input) {
  exact(input, ["schemaVersion", "dictionary", "entity", "number"], "translation tool configuration");
  if (input.schemaVersion !== "translation-tool-configuration-v1") throw new TypeError("translation tool configuration version is invalid");
  return Object.freeze({ schemaVersion: input.schemaVersion, dictionary: providerBinding(input.dictionary, "dictionary"),
    entity: providerBinding(input.entity, "entity"), number: numberBinding(input.number) });
}

export function numberCalculationRequestContract(input) {
  exact(input, ["schemaVersion", "operation", "value", "from", "to", "precision", "rounding"], "number calculation request");
  if (input.schemaVersion !== "number-calculation-request-v1" || !new Set(["scale", "convert-unit"]).has(input.operation)
    || typeof input.value !== "string" || !DECIMAL.test(input.value) || !TOKEN.test(input.from) || !TOKEN.test(input.to)
    || !new Set(["half-up", "half-even", "down"]).has(input.rounding)) throw new TypeError("number calculation request is invalid");
  return Object.freeze({ ...input, precision: integer(input.precision, "precision", 0, 18) });
}

export function calculationReceiptContract(input) {
  exact(input, ["schemaVersion", "status", "request", "dimension", "exactNumerator", "exactDenominator", "formattedValue",
    "formula", "algorithmVersion", "registryVersion", "receiptDigest"], "calculation receipt");
  if (input.schemaVersion !== "calculation-receipt-v1" || !new Set(["resolved", "invalid", "incompatible", "unsupported"]).has(input.status)
    || typeof input.dimension !== "string" && input.dimension !== null || typeof input.exactNumerator !== "string"
    || !/^[0-9-]+$/.test(input.exactNumerator) || typeof input.exactDenominator !== "string" || !/^[1-9][0-9]*$/.test(input.exactDenominator)
    || typeof input.formattedValue !== "string" || typeof input.formula !== "string" || input.formula.length > 512
    || input.algorithmVersion !== "exact-rational-v1" || input.registryVersion !== "local-unit-registry-v1"
    || !/^sha256:[0-9a-f]{64}$/.test(input.receiptDigest)) throw new TypeError("calculation receipt is invalid");
  return Object.freeze({ ...input, request: numberCalculationRequestContract(input.request) });
}

function shortText(value, name, maximum, { empty = false } = {}) {
  if (typeof value !== "string" || value.length > maximum || !empty && value.trim().length === 0) throw new TypeError(`${name} is invalid`);
  return value;
}

function textList(value, name, maximumItems, maximumLength) {
  if (!Array.isArray(value) || value.length > maximumItems) throw new TypeError(`${name} is invalid`);
  const output = value.map((item) => shortText(item, name, maximumLength));
  if (new Set(output).size !== output.length) throw new TypeError(`${name} must be unique`);
  return Object.freeze(output);
}

function referenceRequest(input, kind) {
  const keys = kind === "dictionary"
    ? ["schemaVersion", "term", "sourceLanguage", "targetLanguage", "context", "partOfSpeech", "requestedFields"]
    : ["schemaVersion", "term", "sourceLanguage", "targetLanguage", "context", "entityType", "requestedFacts", "timeHint"];
  exact(input, keys, `${kind} request`);
  if (input.schemaVersion !== `${kind}-lookup-request-v1` || !LANGUAGE.test(input.sourceLanguage)
    || !LANGUAGE.test(input.targetLanguage)) throw new TypeError(`${kind} request is invalid`);
  const base = { schemaVersion: input.schemaVersion, term: shortText(input.term, "term", 256),
    sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage,
    context: shortText(input.context, "context", 2_048) };
  if (kind === "dictionary") return Object.freeze({ ...base,
    partOfSpeech: input.partOfSpeech === null ? null : shortText(input.partOfSpeech, "partOfSpeech", 64),
    requestedFields: textList(input.requestedFields, "requestedFields", 8, 64) });
  return Object.freeze({ ...base,
    entityType: input.entityType === null ? null : shortText(input.entityType, "entityType", 64),
    requestedFacts: textList(input.requestedFacts, "requestedFacts", 8, 128),
    timeHint: input.timeHint === null ? null : shortText(input.timeHint, "timeHint", 128) });
}

export const dictionaryLookupRequestContract = (input) => referenceRequest(input, "dictionary");
export const entityLookupRequestContract = (input) => referenceRequest(input, "entity");

function referenceSource(input) {
  exact(input, ["url", "title", "quote", "sourceClass", "retrievedAt"], "reference source");
  let url;
  try { url = new URL(input.url); } catch { throw new TypeError("reference source URL is invalid"); }
  if (url.protocol !== "https:" || !url.hostname || isIP(url.hostname)) throw new TypeError("reference source URL is invalid");
  if (!new Set(["dictionary", "official", "government", "primary", "professional"]).has(input.sourceClass)
    || Number.isNaN(Date.parse(input.retrievedAt))) throw new TypeError("reference source is invalid");
  return Object.freeze({ url: url.toString(), title: shortText(input.title, "source title", 2_048),
    quote: shortText(input.quote, "source quote", 16_384), sourceClass: input.sourceClass, retrievedAt: input.retrievedAt });
}

export function referenceLookupResultContract(input) {
  exact(input, ["schemaVersion", "toolKind", "status", "term", "canonicalName", "targetCandidates", "details",
    "sources", "providerId", "providerVersion", "usage", "permissions", "resultDigest"], "reference result");
  if (input.schemaVersion !== "reference-lookup-result-v1" || !new Set(["dictionary", "entity"]).has(input.toolKind)
    || !new Set(["resolved", "ambiguous", "not-found", "unresolved", "unavailable"]).has(input.status)
    || !ID.test(input.providerId) || !ID.test(input.providerVersion) || !SHA256.test(input.resultDigest)) {
    throw new TypeError("reference result is invalid");
  }
  exact(input.usage, ["searchCalls", "contentUrls", "modelTokens", "costMicrosUsd"], "reference usage");
  for (const [key, value] of Object.entries(input.usage)) integer(value, `usage.${key}`, 0, 1_000_000_000);
  exact(input.permissions, ["mayModifyTranslation", "mayApproveKnowledge"], "reference permissions");
  if (input.permissions.mayModifyTranslation !== false || input.permissions.mayApproveKnowledge !== false
    || !input.details || typeof input.details !== "object" || Array.isArray(input.details)
    || JSON.stringify(input.details).length > 32_768) throw new TypeError("reference result is invalid");
  const sources = input.sources.map(referenceSource);
  if (input.status === "resolved" && sources.length === 0) throw new TypeError("resolved reference result requires evidence");
  return Object.freeze({ ...input, term: shortText(input.term, "term", 256),
    canonicalName: input.canonicalName === null ? null : shortText(input.canonicalName, "canonicalName", 512),
    targetCandidates: textList(input.targetCandidates, "targetCandidates", 16, 512),
    details: Object.freeze(structuredClone(input.details)), sources: Object.freeze(sources),
    usage: Object.freeze({ ...input.usage }), permissions: Object.freeze({ ...input.permissions }) });
}
