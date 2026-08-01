import { digest, opaqueId } from "../domain/contracts.mjs";

const FACT_KINDS = new Set(["term", "style", "knowledge"]);
const SEVERITIES = new Set(["error", "warning", "info"]);

function requiredString(value, name, { max = 16_384 } = {}) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) throw new TypeError(`${name} must be a bounded non-empty string`);
  return value;
}

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${name} contains an unknown field`);
}

function language(value, name = "language") {
  requiredString(value, name, { max: 63 });
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    if (!canonical) throw new RangeError();
    return canonical;
  } catch {
    throw new TypeError(`${name} must be a valid language tag`);
  }
}

function strings(value, name, { maxItems = 64, allowEmpty = true } = {}) {
  if (!Array.isArray(value) || value.length > maxItems || (!allowEmpty && value.length === 0)) throw new TypeError(`${name} must be a bounded array`);
  const output = value.map((item) => requiredString(item, name, { max: 1_024 }));
  if (new Set(output).size !== output.length) throw new TypeError(`${name} must not contain duplicates`);
  return Object.freeze(output.sort((left, right) => left.localeCompare(right)));
}

function translations(value, name, { required = false } = {}) {
  if (!Array.isArray(value) || value.length > 64 || (required && value.length === 0)) throw new TypeError(`${name} must be a bounded array`);
  const output = value.map((item) => {
    exactKeys(item, ["language", "text"], name);
    return Object.freeze({ language: language(item.language), text: requiredString(item.text, `${name}.text`, { max: 1_024 }) });
  }).sort((left, right) => left.language.localeCompare(right.language) || left.text.localeCompare(right.text));
  const identities = output.map((item) => `${item.language}\0${item.text}`);
  if (new Set(identities).size !== identities.length) throw new TypeError(`${name} must not contain duplicates`);
  return Object.freeze(output);
}

function scopeContract(input = {}) {
  exactKeys(input, ["targetLanguages", "tags", "documentIds"], "scope");
  const targetLanguages = Object.freeze((input.targetLanguages ?? []).map((item) => language(item)).sort());
  if (new Set(targetLanguages).size !== targetLanguages.length) throw new TypeError("scope.targetLanguages must not contain duplicates");
  const tags = strings(input.tags ?? [], "scope.tags");
  const documentIds = Object.freeze((input.documentIds ?? []).map((item) => opaqueId(item, "scope.documentId")).sort());
  if (new Set(documentIds).size !== documentIds.length) throw new TypeError("scope.documentIds must not contain duplicates");
  return Object.freeze({ targetLanguages, tags, documentIds });
}

function termContent(input) {
  exactKeys(input, ["term", "preferredTranslations", "forbiddenTranslations", "variants", "note"], "term.content");
  const output = {
    term: requiredString(input.term, "term.content.term", { max: 1_024 }),
    preferredTranslations: translations(input.preferredTranslations, "term.content.preferredTranslations", { required: true }),
    forbiddenTranslations: translations(input.forbiddenTranslations ?? [], "term.content.forbiddenTranslations"),
    variants: strings(input.variants ?? [], "term.content.variants"),
  };
  if (input.note !== undefined) output.note = requiredString(input.note, "term.content.note");
  return Object.freeze(output);
}

function styleContent(input) {
  exactKeys(input, ["title", "description", "severity", "forbiddenPatterns", "requiredPatterns"], "style.content");
  if (!SEVERITIES.has(input.severity)) throw new TypeError("style.content.severity is invalid");
  return Object.freeze({
    title: requiredString(input.title, "style.content.title", { max: 1_024 }),
    description: requiredString(input.description, "style.content.description"),
    severity: input.severity,
    forbiddenPatterns: strings(input.forbiddenPatterns ?? [], "style.content.forbiddenPatterns"),
    requiredPatterns: strings(input.requiredPatterns ?? [], "style.content.requiredPatterns"),
  });
}

function knowledgeContent(input) {
  exactKeys(input, ["title", "body", "tags", "source"], "knowledge.content");
  return Object.freeze({
    title: requiredString(input.title, "knowledge.content.title", { max: 1_024 }),
    body: requiredString(input.body, "knowledge.content.body", { max: 65_536 }),
    tags: strings(input.tags ?? [], "knowledge.content.tags"),
    source: requiredString(input.source, "knowledge.content.source", { max: 2_048 }),
  });
}

export function factSourceContract(input) {
  exactKeys(input, ["schemaVersion", "factId", "revisionId", "kind", "language", "scope", "content"], "fact source");
  if (input.schemaVersion !== "1.0") throw new TypeError("unsupported fact source version");
  if (!FACT_KINDS.has(input.kind)) throw new TypeError("fact kind is invalid");
  const content = input.kind === "term" ? termContent(input.content)
    : input.kind === "style" ? styleContent(input.content) : knowledgeContent(input.content);
  return Object.freeze({
    schemaVersion: "1.0",
    factId: opaqueId(input.factId, "factId"),
    revisionId: opaqueId(input.revisionId, "revisionId"),
    kind: input.kind,
    language: language(input.language),
    scope: scopeContract(input.scope),
    content,
  });
}

export function retrieverRequestContract(input) {
  exactKeys(input, ["query", "language", "kinds", "tags", "documentIds", "topK"], "retriever request");
  if (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 50) throw new TypeError("topK must be between 1 and 50");
  const kinds = strings(input.kinds, "kinds", { maxItems: 3, allowEmpty: false });
  if (kinds.some((kind) => !FACT_KINDS.has(kind))) throw new TypeError("retriever kind is invalid");
  return Object.freeze({
    query: requiredString(input.query, "query", { max: 1_024 }),
    language: language(input.language),
    kinds,
    tags: strings(input.tags ?? [], "tags"),
    documentIds: Object.freeze((input.documentIds ?? []).map((item) => opaqueId(item, "documentId")).sort()),
    topK: input.topK,
  });
}

export function knowledgeHitContract(input) {
  exactKeys(input, ["factId", "revisionId", "kind", "language", "matchedField", "snippet", "contentDigest", "retrieverVersion", "score", "rank"], "knowledge hit");
  if (!FACT_KINDS.has(input.kind)) throw new TypeError("knowledge hit kind is invalid");
  if (typeof input.score !== "number" || !Number.isFinite(input.score)) throw new TypeError("knowledge hit score must be finite");
  if (!Number.isInteger(input.rank) || input.rank < 1 || input.rank > 50) throw new TypeError("knowledge hit rank is invalid");
  return Object.freeze({
    factId: opaqueId(input.factId, "factId"), revisionId: opaqueId(input.revisionId, "revisionId"),
    kind: input.kind, language: language(input.language),
    matchedField: requiredString(input.matchedField, "matchedField", { max: 255 }),
    snippet: requiredString(input.snippet, "snippet", { max: 4_096 }),
    contentDigest: digest(input.contentDigest, "contentDigest"),
    retrieverVersion: requiredString(input.retrieverVersion, "retrieverVersion", { max: 255 }),
    score: input.score, rank: input.rank,
  });
}

export function embeddingRequestContract(input) {
  exactKeys(input, ["texts", "model"], "embedding request");
  if (!Array.isArray(input.texts) || input.texts.length < 1 || input.texts.length > 128) throw new TypeError("embedding texts must be bounded");
  return Object.freeze({ texts: Object.freeze(input.texts.map((item) => requiredString(item, "embedding text", { max: 16_384 }))), model: requiredString(input.model, "embedding model", { max: 255 }) });
}

export function rerankRequestContract(input) {
  exactKeys(input, ["query", "hits", "topK"], "rerank request");
  if (!Array.isArray(input.hits) || input.hits.length < 1 || input.hits.length > 50) throw new TypeError("rerank hits must be bounded");
  if (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > input.hits.length) throw new TypeError("rerank topK is invalid");
  return Object.freeze({ query: requiredString(input.query, "rerank query", { max: 1_024 }), hits: Object.freeze(input.hits.map(knowledgeHitContract)), topK: input.topK });
}

export const KNOWLEDGE_CAPABILITIES = Object.freeze({ fts: "available", embedding: "unavailable", reranker: "unavailable" });
