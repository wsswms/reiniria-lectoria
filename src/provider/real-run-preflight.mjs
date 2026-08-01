import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { buildDeepSeekRequest, DEEPSEEK_API_ORIGIN, DEEPSEEK_PROVIDER_ID } from "./deepseek-provider.mjs";
import { buildGeminiRequest, GEMINI_API_ORIGIN, GEMINI_PROVIDER_ID } from "./gemini-provider.mjs";
import { buildOpenAIRequest, OPENAI_API_ORIGIN, OPENAI_PROVIDER_ID } from "./openai-provider.mjs";
import { normalizeDocument } from "../document/parser.mjs";

export const REAL_RUN_CONFIG_VERSION = "lectoria-real-provider-run-v1";

const SHA256 = /^[0-9a-f]{64}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROVIDERS = new Map([
  [GEMINI_PROVIDER_ID, Object.freeze({ origin: GEMINI_API_ORIGIN, buildRequest: buildGeminiRequest })],
  [OPENAI_PROVIDER_ID, Object.freeze({ origin: OPENAI_API_ORIGIN, buildRequest: buildOpenAIRequest })],
  [DEEPSEEK_PROVIDER_ID, Object.freeze({ origin: DEEPSEEK_API_ORIGIN, buildRequest: buildDeepSeekRequest })],
]);

function exactKeys(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new TypeError(`${name} fields are invalid`);
  }
}

function required(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function integer(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

export function realRunConfigContract(input, { allowLive = false } = {}) {
  exactKeys(input, ["schemaVersion", "mode", "providerId", "modelId", "credentialPath", "allowedOrigin", "corpus", "dataPolicy", "limits", "pricing"], "config");
  if (input.schemaVersion !== REAL_RUN_CONFIG_VERSION) throw new TypeError("real run config version is invalid");
  if (!new Set(["dry-run", "live"]).has(input.mode) || (input.mode === "live" && !allowLive)) throw new TypeError("real run mode is not authorized");
  const provider = PROVIDERS.get(input.providerId);
  if (!provider || !MODEL_ID.test(input.modelId)) throw new TypeError("real run Provider/model is invalid");
  if (!isAbsolute(input.credentialPath)) throw new TypeError("credentialPath must be absolute");
  if (input.allowedOrigin !== provider.origin) throw new TypeError("real run origin is not allowlisted");

  exactKeys(input.corpus, ["digest", "documents", "approved"], "corpus");
  if (!SHA256.test(input.corpus.digest) || input.corpus.documents !== 12 || input.corpus.approved !== true) throw new TypeError("real run corpus is not approved");
  exactKeys(input.dataPolicy, ["reference", "accepted"], "dataPolicy");
  if (required(input.dataPolicy.reference, "dataPolicy.reference").length > 512 || input.dataPolicy.accepted !== true) {
    throw new TypeError("real run data policy is not accepted");
  }
  exactKeys(input.limits, ["maxCalls", "maxOutputTokens", "hardLimitMicros", "currency"], "limits");
  const maxCalls = integer(input.limits.maxCalls, "limits.maxCalls", 100);
  const maxOutputTokens = integer(input.limits.maxOutputTokens, "limits.maxOutputTokens", 1_000_000);
  const hardLimitMicros = integer(input.limits.hardLimitMicros, "limits.hardLimitMicros", 10_000_000);
  if (maxOutputTokens < 1) throw new TypeError("limits.maxOutputTokens is invalid");
  if (maxCalls < 12 || hardLimitMicros < 1 || input.limits.currency !== "USD") throw new TypeError("real run limits are invalid");
  exactKeys(input.pricing, ["version", "source", "inputMicrosPerMillion", "outputMicrosPerMillion", "cachedInputMicrosPerMillion"], "pricing");
  const pricing = Object.freeze({
    version: required(input.pricing.version, "pricing.version"),
    source: required(input.pricing.source, "pricing.source"),
    inputMicrosPerMillion: integer(input.pricing.inputMicrosPerMillion, "pricing.inputMicrosPerMillion"),
    outputMicrosPerMillion: integer(input.pricing.outputMicrosPerMillion, "pricing.outputMicrosPerMillion"),
    cachedInputMicrosPerMillion: integer(input.pricing.cachedInputMicrosPerMillion, "pricing.cachedInputMicrosPerMillion"),
  });
  return Object.freeze({
    schemaVersion: REAL_RUN_CONFIG_VERSION,
    mode: input.mode,
    providerId: input.providerId,
    modelId: input.modelId,
    credentialPath: input.credentialPath,
    allowedOrigin: input.allowedOrigin,
    corpus: Object.freeze({ ...input.corpus }),
    dataPolicy: Object.freeze({ ...input.dataPolicy }),
    limits: Object.freeze({ maxCalls, maxOutputTokens, hardLimitMicros, currency: "USD" }),
    pricing,
  });
}

const digest = (value) => createHash("sha256").update(value).digest("hex");
const contractDigest = (value) => `sha256:${digest(value)}`;
const uuidFor = (index, slot) => `00000000-0000-4000-8000-${String(index * 16 + slot).padStart(12, "0")}`;
const estimatedTokens = (value) => Math.max(1, Math.ceil(Buffer.byteLength(value) / 4));

function estimatedMicros(config, inputTokens, outputTokens) {
  const numerator = BigInt(config.pricing.inputMicrosPerMillion) * BigInt(inputTokens)
    + BigInt(config.pricing.outputMicrosPerMillion) * BigInt(outputTokens);
  return Number((numerator + 999_999n) / 1_000_000n);
}

export function createRealRunDryPlan(configInput, corpus, corpusSourceBytes) {
  const config = realRunConfigContract(configInput);
  const provider = PROVIDERS.get(config.providerId);
  if (!Array.isArray(corpus) || corpus.length !== config.corpus.documents || digest(corpusSourceBytes) !== config.corpus.digest) {
    throw new Error("real run corpus digest or document count mismatch");
  }
  let estimatedCostMicros = 0;
  const requests = [];
  corpus.forEach((item, documentIndex) => {
    if (!item || typeof item.content !== "string" || item.content.length === 0 || typeof item.targetLanguage !== "string") {
      throw new TypeError("real run corpus item is invalid");
    }
    const parsed = normalizeDocument(item.format, item.content);
    parsed.segments.filter((segment) => segment.translatable).forEach((segment) => {
      const requestIndex = requests.length;
      const inputTokens = estimatedTokens(segment.sourceText) + 256;
      estimatedCostMicros += estimatedMicros(config, inputTokens, config.limits.maxOutputTokens);
      const request = {
        workspaceId: uuidFor(requestIndex, 1), taskId: uuidFor(requestIndex, 2), attemptId: uuidFor(requestIndex, 3),
        workflowId: uuidFor(requestIndex, 4), sourceRevisionId: uuidFor(requestIndex, 5),
        targetLanguage: item.targetLanguage, providerId: config.providerId, modelId: config.modelId,
        maxOutputTokens: config.limits.maxOutputTokens,
        promptVersion: "lectoria-translation-v1", contextDigest: contractDigest(`context:${item.id}:${segment.ordinal}`),
        segments: [{
          segmentId: uuidFor(requestIndex, 6), sourceDigest: segment.sourceDigest,
          sourceText: segment.sourceText, protected: segment.protected,
        }],
      };
      const outbound = provider.buildRequest(request);
      if (new URL(outbound.url).origin !== config.allowedOrigin) throw new Error("real run request escaped the allowlist");
      requests.push(Object.freeze({
        itemId: item.id, segmentOrdinal: segment.ordinal,
        requestDigest: digest(JSON.stringify(outbound.body)), targetLanguage: item.targetLanguage,
      }));
    });
  });
  if (requests.length > config.limits.maxCalls) throw new Error("real run call limit is too low");
  if (estimatedCostMicros > config.limits.hardLimitMicros) throw new Error("real run estimated cost exceeds the hard limit");
  return Object.freeze({
    schemaVersion: REAL_RUN_CONFIG_VERSION,
    mode: "dry-run",
    providerId: config.providerId,
    modelId: config.modelId,
    allowedOrigin: config.allowedOrigin,
    corpusDigest: config.corpus.digest,
    documents: corpus.length,
    calls: requests.length,
    maxCalls: config.limits.maxCalls,
    estimatedCostMicros,
    hardLimitMicros: config.limits.hardLimitMicros,
    currency: config.limits.currency,
    requests: Object.freeze(requests),
  });
}
