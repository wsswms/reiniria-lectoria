const CASE_VERSION = "deepseek-server-research-case-v1";
const PROVIDER_VERSION = "deepseek-server-research-provider-result-v1";
const FINAL_VERSION = "deepseek-server-research-result-v1";
const LANG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function exact(input, keys, name) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== keys.length || Object.keys(input).some((key) => !keys.includes(key))) {
    throw new TypeError(`${name} is invalid`);
  }
}

function text(value, name, maximum, minimum = 0) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

function httpsUrl(value, name) {
  const url = new URL(text(value, name, 4_096, 1));
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") throw new TypeError(`${name} is invalid`);
  return url;
}

export function researchCaseContract(input) {
  const keys = ["schemaVersion", "caseId", "question", "responseLanguage", "maxOutputTokens", "reasoningEffort"];
  exact(input, keys, "DeepSeek research case");
  if (input.schemaVersion !== CASE_VERSION || !ID.test(input.caseId) || !LANG.test(input.responseLanguage)
    || !new Set(["low", "medium", "high"]).has(input.reasoningEffort)) throw new TypeError("DeepSeek research case contract is invalid");
  return Object.freeze({ schemaVersion: CASE_VERSION, caseId: input.caseId,
    question: text(input.question, "question", 8_192, 1), responseLanguage: input.responseLanguage,
    maxOutputTokens: integer(input.maxOutputTokens, "maxOutputTokens", 512, 12_000), reasoningEffort: input.reasoningEffort });
}

function usageContract(input) {
  exact(input, ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens"], "DeepSeek research usage");
  const output = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, integer(value, key, 0, Number.MAX_SAFE_INTEGER)]));
  if (output.cachedInputTokens > output.inputTokens || output.reasoningTokens > output.outputTokens
    || output.totalTokens !== output.inputTokens + output.outputTokens) throw new TypeError("DeepSeek research usage is inconsistent");
  return Object.freeze(output);
}

function sourceContract(input, verified) {
  const base = ["url", "title", "quote", "sourceClass"];
  const keys = verified ? [...base, "finalUrl", "tier", "contentDigest", "snapshotDigest", "quoteExact", "phraseCoverage"] : base;
  exact(input, keys, verified ? "verified research source" : "provider research source");
  const url = httpsUrl(input.url, "source URL");
  if (!new Set(["primary", "government", "dictionary", "professional"]).has(input.sourceClass)) throw new TypeError("source class is invalid");
  const result = { url: url.toString(), title: text(input.title, "source title", 300), quote: text(input.quote, "source quote", 800, 1), sourceClass: input.sourceClass };
  if (!verified) return Object.freeze(result);
  const finalUrl = httpsUrl(input.finalUrl, "final source URL");
  if (!new Set(["S1", "S2", "S3"]).has(input.tier) || !DIGEST.test(input.contentDigest) || !DIGEST.test(input.snapshotDigest)
    || typeof input.quoteExact !== "boolean" || typeof input.phraseCoverage !== "number" || input.phraseCoverage < 0 || input.phraseCoverage > 1) {
    throw new TypeError("verified source evidence is invalid");
  }
  return Object.freeze({ ...result, finalUrl: finalUrl.toString(), tier: input.tier, contentDigest: input.contentDigest, snapshotDigest: input.snapshotDigest,
    quoteExact: input.quoteExact, phraseCoverage: input.phraseCoverage });
}

function dropContract(input) {
  exact(input, ["url", "reason"], "dropped research source");
  if (input.url !== null) text(input.url, "dropped source URL", 4_096, 1);
  return Object.freeze({ url: input.url, reason: text(input.reason, "drop reason", 127, 1) });
}

function actionContract(input) {
  exact(input, ["type", "queries", "url"], "research action");
  if (!new Set(["search", "open_page", "find_in_page", "unknown"]).has(input.type)) throw new TypeError("research action type is invalid");
  if (input.queries !== null && (!Array.isArray(input.queries) || input.queries.length > 16
    || input.queries.some((item) => typeof item !== "string" || item.length > 2_048))) throw new TypeError("research action queries are invalid");
  if (input.url !== null) text(input.url, "research action URL", 4_096, 1);
  return Object.freeze({ type: input.type, queries: input.queries === null ? null : Object.freeze([...input.queries]), url: input.url });
}

export function providerResearchResultContract(input) {
  exact(input, ["schemaVersion", "adapterId", "adapterVersion", "caseId", "responseId", "modelId", "outcome", "answer",
    "explanation", "sources", "droppedSources", "actions", "usage"], "DeepSeek provider research result");
  if (input.schemaVersion !== PROVIDER_VERSION || input.adapterId !== "deepseek-server-research"
    || input.adapterVersion !== "deepseek-responses-web-search-v1" || !ID.test(input.caseId) || !ID.test(input.responseId)
    || input.modelId !== "deepseek-v4-flash" || !new Set(["resolved-candidate", "not-found", "unresolved"]).has(input.outcome)
    || !Array.isArray(input.sources) || input.sources.length > 6 || !Array.isArray(input.droppedSources) || input.droppedSources.length > 32
    || !Array.isArray(input.actions) || input.actions.length > 64) throw new TypeError("DeepSeek provider research result contract is invalid");
  if (input.outcome === "resolved-candidate" && input.sources.length < 1) throw new TypeError("resolved candidate requires evidence");
  if (input.outcome !== "resolved-candidate" && input.sources.length !== 0) throw new TypeError("terminal provider outcome cannot carry candidate evidence");
  if (input.outcome === "resolved-candidate" ? typeof input.answer !== "string" || input.answer.trim().length === 0 : input.answer !== "") {
    throw new TypeError("provider answer does not match outcome");
  }
  return Object.freeze({ schemaVersion: PROVIDER_VERSION, adapterId: input.adapterId, adapterVersion: input.adapterVersion,
    caseId: input.caseId, responseId: input.responseId, modelId: input.modelId, outcome: input.outcome,
    answer: text(input.answer, "answer", 800), explanation: text(input.explanation, "explanation", 1_600),
    sources: Object.freeze(input.sources.map((item) => sourceContract(item, false))),
    droppedSources: Object.freeze(input.droppedSources.map(dropContract)), actions: Object.freeze(input.actions.map(actionContract)),
    usage: usageContract(input.usage) });
}

export function finalResearchResultContract(input) {
  exact(input, ["schemaVersion", "adapterId", "adapterVersion", "caseId", "responseId", "modelId", "outcome", "answer",
    "explanation", "sources", "droppedSources", "actions", "usage", "permissions"], "final DeepSeek research result");
  if (input.schemaVersion !== FINAL_VERSION || !new Set(["resolved", "not-found", "unresolved"]).has(input.outcome)
    || input.adapterId !== "deepseek-server-research" || input.adapterVersion !== "deepseek-responses-web-search-v1"
    || !ID.test(input.caseId) || !ID.test(input.responseId) || input.modelId !== "deepseek-v4-flash"
    || !Array.isArray(input.sources) || input.sources.length > 6 || !Array.isArray(input.droppedSources) || input.droppedSources.length > 64
    || input.outcome === "resolved" && input.sources.length < 1 || input.outcome !== "resolved" && input.sources.length !== 0) {
    throw new TypeError("final DeepSeek research result contract is invalid");
  }
  if (input.outcome === "resolved" ? typeof input.answer !== "string" || input.answer.trim().length === 0 : input.answer !== "") {
    throw new TypeError("final answer does not match outcome");
  }
  exact(input.permissions, ["mayModifyTranslation", "mayApproveKnowledge"], "research permissions");
  if (input.permissions.mayModifyTranslation !== false || input.permissions.mayApproveKnowledge !== false) throw new TypeError("research permissions are invalid");
  return Object.freeze({ schemaVersion: FINAL_VERSION, adapterId: text(input.adapterId, "adapterId", 128, 1),
    adapterVersion: text(input.adapterVersion, "adapterVersion", 128, 1), caseId: text(input.caseId, "caseId", 255, 1),
    responseId: text(input.responseId, "responseId", 255, 1), modelId: text(input.modelId, "modelId", 128, 1), outcome: input.outcome,
    answer: text(input.answer, "answer", 800), explanation: text(input.explanation, "explanation", 1_600),
    sources: Object.freeze(input.sources.map((item) => sourceContract(item, true))),
    droppedSources: Object.freeze(input.droppedSources.map(dropContract)), actions: Object.freeze(input.actions.map(actionContract)),
    usage: usageContract(input.usage), permissions: Object.freeze({ mayModifyTranslation: false, mayApproveKnowledge: false }) });
}

export const DEEPSEEK_SERVER_RESEARCH_CASE_VERSION = CASE_VERSION;
