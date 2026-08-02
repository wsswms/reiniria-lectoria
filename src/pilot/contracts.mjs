import { isAbsolute } from "node:path";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const DEEPSEEK_ORIGIN = "https://api.deepseek.com";

function exact(input, keys, name) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw new TypeError(`${name} contains an unknown field`);
}
function string(value, name, maximum = 4_096) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}
function absolute(value, name) { string(value, name); if (!isAbsolute(value)) throw new TypeError(`${name} must be absolute`); return value; }
function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}
function language(value, name) { try { return Intl.getCanonicalLocales(string(value, name, 63))[0]; } catch { throw new TypeError(`${name} is invalid`); } }
function budget(input, name, callMaximum, outputMaximum) {
  exact(input, ["maxCalls", "maxOutputTokens", "hardLimitMicros"], name);
  return Object.freeze({ maxCalls: integer(input.maxCalls, `${name}.maxCalls`, 1, callMaximum),
    maxOutputTokens: integer(input.maxOutputTokens, `${name}.maxOutputTokens`, 1, outputMaximum),
    hardLimitMicros: integer(input.hardLimitMicros, `${name}.hardLimitMicros`, 1, 200_000) });
}

export function realArticlePilotConfigContract(input, { allowLive = false } = {}) {
  exact(input, ["schemaVersion", "mode", "article", "deepseek", "brave", "fetch", "research", "output", "totalHardLimitMicros"], "config");
  if (input.schemaVersion !== "lectoria-real-article-pilot-v1") throw new TypeError("config version is invalid");
  if (!new Set(["dry-run", "live"]).has(input.mode) || (input.mode === "live" && !allowLive)) throw new TypeError("live mode is not allowed");
  exact(input.article, ["path", "digest", "format", "sourceLanguage", "targetLanguage"], "article");
  if (!SHA256.test(input.article.digest) || input.article.format !== "text") throw new TypeError("article boundary is invalid");
  const article = Object.freeze({ path: absolute(input.article.path, "article.path"), digest: input.article.digest, format: "text",
    sourceLanguage: language(input.article.sourceLanguage, "article.sourceLanguage"), targetLanguage: language(input.article.targetLanguage, "article.targetLanguage") });

  exact(input.deepseek, ["modelId", "credentialPath", "origin", "pricing", "translation", "research"], "deepseek");
  if (input.deepseek.origin !== DEEPSEEK_ORIGIN) throw new TypeError("deepseek origin is invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.deepseek.modelId)) throw new TypeError("deepseek.modelId is invalid");
  exact(input.deepseek.pricing, ["version", "inputMicrosPerMillion", "outputMicrosPerMillion", "cachedInputMicrosPerMillion"], "deepseek.pricing");
  const pricing = Object.freeze({ version: string(input.deepseek.pricing.version, "deepseek.pricing.version", 255),
    inputMicrosPerMillion: integer(input.deepseek.pricing.inputMicrosPerMillion, "deepseek.pricing.inputMicrosPerMillion", 0, 10_000_000),
    outputMicrosPerMillion: integer(input.deepseek.pricing.outputMicrosPerMillion, "deepseek.pricing.outputMicrosPerMillion", 0, 10_000_000),
    cachedInputMicrosPerMillion: integer(input.deepseek.pricing.cachedInputMicrosPerMillion, "deepseek.pricing.cachedInputMicrosPerMillion", 0, 10_000_000) });
  const deepseek = Object.freeze({ modelId: input.deepseek.modelId, credentialPath: absolute(input.deepseek.credentialPath, "deepseek.credentialPath"),
    origin: DEEPSEEK_ORIGIN, pricing, translation: budget(input.deepseek.translation, "deepseek.translation", 20, 1_024),
    research: budget(input.deepseek.research, "deepseek.research", 10, 2_048) });

  exact(input.brave, ["credentialPath", "maxCalls", "costMicrosPerCall", "hardLimitMicros", "country", "searchLanguage", "maxResultsPerSearch"], "brave");
  const brave = Object.freeze({ credentialPath: absolute(input.brave.credentialPath, "brave.credentialPath"),
    maxCalls: integer(input.brave.maxCalls, "brave.maxCalls", 1, 100), costMicrosPerCall: integer(input.brave.costMicrosPerCall, "brave.costMicrosPerCall", 0, 5_000),
    hardLimitMicros: integer(input.brave.hardLimitMicros, "brave.hardLimitMicros", 0, 500_000),
    country: /^[A-Z]{2}$/.test(input.brave.country) ? input.brave.country : (() => { throw new TypeError("brave.country is invalid"); })(),
    searchLanguage: language(input.brave.searchLanguage, "brave.searchLanguage"), maxResultsPerSearch: integer(input.brave.maxResultsPerSearch, "brave.maxResultsPerSearch", 1, 10) });
  if (brave.maxCalls * brave.costMicrosPerCall > brave.hardLimitMicros) throw new TypeError("brave budget exceeds hard limit");

  exact(input.fetch, ["maxUrls", "timeoutMs", "maxConcurrency", "maxBodyBytes"], "fetch");
  const fetch = Object.freeze({ maxUrls: integer(input.fetch.maxUrls, "fetch.maxUrls", 1, 20), timeoutMs: integer(input.fetch.timeoutMs, "fetch.timeoutMs", 1, 30_000),
    maxConcurrency: integer(input.fetch.maxConcurrency, "fetch.maxConcurrency", 1, 4), maxBodyBytes: integer(input.fetch.maxBodyBytes, "fetch.maxBodyBytes", 1, 1_048_576) });
  if (fetch.maxBodyBytes !== 1_048_576) throw new TypeError("fetch.maxBodyBytes must remain fixed");

  exact(input.research, ["questions", "allowedDomains"], "research");
  if (!Array.isArray(input.research.questions) || input.research.questions.length < 1 || input.research.questions.length > 10) throw new TypeError("research.questions is invalid");
  const questions = input.research.questions.map((item) => string(item, "research.question", 512));
  if (new Set(questions).size !== questions.length || !Array.isArray(input.research.allowedDomains) || input.research.allowedDomains.length > 64) throw new TypeError("research boundary is invalid");
  const allowedDomains = input.research.allowedDomains.map((item) => {
    const value = string(item, "research.allowedDomain", 253).toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(value) || value.startsWith(".") || value.endsWith(".")) throw new TypeError("research.allowedDomain is invalid");
    return value;
  });
  exact(input.output, ["directory"], "output");
  const totalHardLimitMicros = integer(input.totalHardLimitMicros, "totalHardLimitMicros", 1, 1_000_000);
  if (deepseek.translation.hardLimitMicros + deepseek.research.hardLimitMicros + brave.hardLimitMicros > totalHardLimitMicros) throw new TypeError("combined budget exceeds hard limit");
  return Object.freeze({ schemaVersion: input.schemaVersion, mode: input.mode, article, deepseek, brave, fetch,
    research: Object.freeze({ questions: Object.freeze(questions), allowedDomains: Object.freeze(allowedDomains) }),
    output: Object.freeze({ directory: absolute(input.output.directory, "output.directory") }), totalHardLimitMicros });
}

export const REAL_ARTICLE_PILOT_LIMITS = Object.freeze({ translationCalls: 20, researchCalls: 10, braveCalls: 100, fetchUrls: 20, totalMicrosUsd: 1_000_000 });
