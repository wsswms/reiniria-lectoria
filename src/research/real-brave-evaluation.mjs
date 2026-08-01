import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stableJson } from "../domain/contracts.mjs";
import { openCredentialFile } from "../provider/credential-file.mjs";
import { adapterManifest } from "./adapter-manifest.mjs";
import { invokeResearchWebBroker } from "./web-broker-process.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function exact(input, keys, name) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key))) {
    throw new TypeError(`${name} is invalid`);
  }
}

function officialUrl(value, hosts, name) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !hosts.includes(url.hostname)) throw new TypeError(`${name} must use an official HTTPS URL`);
  return url.href;
}

export function realBraveEvaluationManifestContract(input) {
  exact(input, ["schemaVersion", "providerId", "adapterVersion", "origin", "credentialRef", "dataClass", "maximumCalls",
    "authorizedMaxCostMicrosUsd", "costMicrosUsdPerCall", "rawResponseRetention", "credentialInjection", "queries", "policySnapshot"], "real Brave manifest");
  const runtime = adapterManifest("brave-search", "search");
  if (input.schemaVersion !== "m5r-brave-real-evaluation-v1" || input.providerId !== runtime.adapterId
    || input.adapterVersion !== runtime.adapterVersion || input.origin !== runtime.origin || input.credentialRef !== runtime.credentialRef
    || input.dataClass !== "public-synthetic" || input.rawResponseRetention !== false || input.credentialInjection !== "fd-3") {
    throw new TypeError("real Brave manifest boundary is invalid");
  }
  if (!Number.isSafeInteger(input.maximumCalls) || input.maximumCalls < 2 || input.maximumCalls > 10
    || !Number.isSafeInteger(input.costMicrosUsdPerCall) || input.costMicrosUsdPerCall < 0
    || !Number.isSafeInteger(input.authorizedMaxCostMicrosUsd) || input.authorizedMaxCostMicrosUsd < 0
    || input.authorizedMaxCostMicrosUsd > 1_000_000 || input.maximumCalls * input.costMicrosUsdPerCall > input.authorizedMaxCostMicrosUsd) {
    throw new TypeError("real Brave manifest budget is invalid");
  }
  if (!Array.isArray(input.queries) || input.queries.length !== input.maximumCalls) throw new TypeError("real Brave query manifest is invalid");
  const ids = new Set();
  const queries = input.queries.map((item) => {
    exact(item, ["id", "query", "count", "country", "searchLanguage", "dataClass"], "real Brave query");
    if (typeof item.id !== "string" || !/^[a-z0-9-]{3,64}$/.test(item.id) || ids.has(item.id)
      || typeof item.query !== "string" || item.query.length < 3 || item.query.length > 512
      || !Number.isInteger(item.count) || item.count < 1 || item.count > 10 || !/^[A-Z]{2}$/.test(item.country)
      || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(item.searchLanguage) || item.dataClass !== "public-synthetic") {
      throw new TypeError("real Brave query boundary is invalid");
    }
    ids.add(item.id); return Object.freeze({ ...item });
  });
  exact(input.policySnapshot, ["observedAt", "pricing", "terms", "privacy", "processingRegions"], "Brave policy snapshot");
  if (input.policySnapshot.observedAt !== "2026-08-02" || input.policySnapshot.processingRegions !== null) throw new TypeError("Brave policy observation is invalid");
  exact(input.policySnapshot.pricing, ["url", "usdPerThousandRequests"], "Brave pricing snapshot");
  exact(input.policySnapshot.terms, ["url", "lastUpdated"], "Brave terms snapshot");
  exact(input.policySnapshot.privacy, ["url", "maximumQueryRetentionDays", "zeroDataRetention"], "Brave privacy snapshot");
  if (officialUrl(input.policySnapshot.pricing.url, ["brave.com"], "pricing URL") !== input.policySnapshot.pricing.url
    || input.policySnapshot.pricing.usdPerThousandRequests !== 5
    || officialUrl(input.policySnapshot.terms.url, ["api-dashboard.search.brave.com"], "terms URL") !== input.policySnapshot.terms.url
    || input.policySnapshot.terms.lastUpdated !== "2026-02-11"
    || officialUrl(input.policySnapshot.privacy.url, ["api-dashboard.search.brave.com"], "privacy URL") !== input.policySnapshot.privacy.url
    || input.policySnapshot.privacy.maximumQueryRetentionDays !== 90
    || input.policySnapshot.privacy.zeroDataRetention !== "enterprise-optional") throw new TypeError("Brave policy snapshot is invalid");
  return Object.freeze({ ...input, queries: Object.freeze(queries), policySnapshot: Object.freeze(JSON.parse(stableJson(input.policySnapshot))) });
}

export async function loadRealBraveEvaluationManifest(url = new URL("../../tests/fixtures/m5r-4a/brave-real-evaluation-manifest.json", import.meta.url)) {
  return realBraveEvaluationManifestContract(JSON.parse(await readFile(url, "utf8")));
}

export async function preflightRealBraveEvaluation({ manifest, credentialPath }) {
  const checked = realBraveEvaluationManifestContract(manifest);
  const credential = await openCredentialFile(credentialPath);
  try {
    const stat = await credential.stat();
    return Object.freeze({ schemaVersion: "m5r-brave-real-preflight-v1", providerId: checked.providerId,
      adapterVersion: checked.adapterVersion, origin: checked.origin, credentialRef: checked.credentialRef,
      manifestDigest: sha(stableJson(checked)), calls: checked.maximumCalls,
      plannedCostMicrosUsd: checked.maximumCalls * checked.costMicrosUsdPerCall,
      authorizedMaxCostMicrosUsd: checked.authorizedMaxCostMicrosUsd, credential: Object.freeze({ regularFile: stat.isFile(),
        ownedByCurrentUser: typeof process.getuid !== "function" || stat.uid === process.getuid(), permissionsRestricted: (stat.mode & 0o077) === 0,
        sizeWithinLimit: stat.size >= 1 && stat.size <= 16 * 1024 }), rawResponseRetention: false });
  } finally { await credential.close(); }
}

export function createRealBraveGatewayAdapter({ credentialPath, costMicrosUsdPerCall, brokerOptions } = {}) {
  if (!Number.isSafeInteger(costMicrosUsdPerCall) || costMicrosUsdPerCall < 0 || costMicrosUsdPerCall > 1_000_000) {
    throw new TypeError("Brave call price is invalid");
  }
  const manifest = adapterManifest("brave-search", "search");
  return Object.freeze({ estimatedUsage: Object.freeze({ searchCalls: 1, contentUrls: 0, modelTokens: 0, costMicrosUsd: costMicrosUsdPerCall }),
    async search(request) {
      const credential = await openCredentialFile(credentialPath);
      try {
        const response = await invokeResearchWebBroker({ providerId: manifest.adapterId, capability: manifest.capability,
          request, credentialRef: manifest.credentialRef, credentialFd: credential.fd }, brokerOptions);
        return Object.freeze({ ...response, usage: Object.freeze({ ...response.usage, costMicrosUsd: costMicrosUsdPerCall }) });
      } finally { await credential.close(); }
    } });
}

export function summarizeRealBraveResult({ manifest, observations, totals, startedAt, completedAt }) {
  const checked = realBraveEvaluationManifestContract(manifest);
  if (!Array.isArray(observations) || observations.length !== checked.maximumCalls) throw new TypeError("Brave observations are invalid");
  const ids = new Set(checked.queries.map((item) => item.id));
  for (const item of observations) {
    exact(item, ["id", "resultCount", "uniqueOriginCount", "responseDigest", "latencyMs"], "Brave observation");
    if (!ids.delete(item.id) || !Number.isSafeInteger(item.resultCount) || item.resultCount < 0 || item.resultCount > 10
      || !Number.isSafeInteger(item.uniqueOriginCount) || item.uniqueOriginCount < 0 || item.uniqueOriginCount > item.resultCount
      || !DIGEST.test(item.responseDigest) || !Number.isSafeInteger(item.latencyMs) || item.latencyMs < 0) throw new TypeError("Brave observation is invalid");
  }
  exact(totals, ["searchCalls", "contentUrls", "modelTokens", "costMicrosUsd"], "Brave totals");
  if (totals.searchCalls !== checked.maximumCalls || totals.contentUrls !== 0 || totals.modelTokens !== 0
    || totals.costMicrosUsd !== checked.maximumCalls * checked.costMicrosUsdPerCall
    || new Date(startedAt).toISOString() !== startedAt || new Date(completedAt).toISOString() !== completedAt || completedAt < startedAt) {
    throw new TypeError("Brave result totals are invalid");
  }
  return Object.freeze({ schemaVersion: "m5r-brave-real-result-v1", conclusion: "conditional-go", scope: "public-non-sensitive-search-only",
    providerId: checked.providerId, adapterVersion: checked.adapterVersion, manifestDigest: sha(stableJson(checked)), calls: observations.length,
    usage: Object.freeze({ ...totals }), startedAt, completedAt, observations: Object.freeze(observations.map((item) => Object.freeze({ ...item }))),
    policy: Object.freeze({ maximumQueryRetentionDays: 90, zeroDataRetention: "enterprise-optional", processingRegions: null }),
    rawResponsePersisted: false, unauthorizedServicesCalled: Object.freeze([]) });
}
