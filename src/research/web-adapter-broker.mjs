import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { BraveSearchAdapter } from "../search/brave-search-adapter.mjs";
import { adapterManifest } from "./adapter-manifest.mjs";
import { WebAdapterError } from "./provider-web-adapters.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export class BraveResearchSearchAdapter {
  constructor({ fetchImpl = globalThis.fetch } = {}) { this.id = "brave-search"; this.manifest = adapterManifest(this.id, "search");
    this.adapter = new BraveSearchAdapter({ fetchImpl }); }
  async search(input, options) {
    const response = await this.adapter.search({ query: input.query, count: input.count, country: input.country,
      searchLanguage: input.searchLanguage }, options);
    return Object.freeze({ ...response, responseDigest: sha(stableJson(response.results)),
      usage: Object.freeze({ searchCalls: 1, contentUrls: 0, modelTokens: 0, costMicrosUsd: 0 }) });
  }
}

export class ResearchWebAdapterBroker {
  constructor({ adapters, resolveCredential } = {}) {
    if (!(adapters instanceof Map) || typeof resolveCredential !== "function") throw new TypeError("web broker dependencies are invalid");
    this.adapters = adapters; this.resolveCredential = resolveCredential;
  }

  facade(providerId, capability) {
    const method = capability === "search" ? "search" : capability === "extract" ? "extract" : null;
    if (!method) throw new TypeError("web broker capability is invalid");
    return Object.freeze({ [method]: (input) => this.invoke(providerId, capability, input) });
  }

  async invoke(providerId, capability, input, { signal } = {}) {
    let expected;
    try { expected = adapterManifest(providerId, capability); } catch { throw new WebAdapterError("unavailable"); }
    const adapter = this.adapters.get(providerId);
    if (!adapter || adapter.id !== providerId || typeof adapter[capability === "search" ? "search" : "extract"] !== "function"
      || stableJson(adapter.manifest) !== stableJson(expected)) throw new WebAdapterError("policy");
    if (input?.filters !== undefined) {
      if (!input.filters || typeof input.filters !== "object" || Array.isArray(input.filters)
        || Object.keys(input.filters).some((key) => !Object.hasOwn(expected.filters, key))
        || Object.entries(input.filters).some(([key, value]) => value !== undefined && value !== null
          && !(Array.isArray(value) && value.length === 0) && expected.filters[key] !== true)) throw new WebAdapterError("policy");
    }
    let secret;
    try { secret = await this.resolveCredential(expected.credentialRef); }
    catch { throw new WebAdapterError("unavailable"); }
    try {
      const response = await adapter[capability === "search" ? "search" : "extract"](input, { credential: secret, signal });
      if (response.adapterId !== providerId || response.adapterVersion !== expected.adapterVersion
        || response.directWebEvidence === true || response.lineage === "direct") throw new WebAdapterError("malformed-response");
      return response;
    } catch (error) {
      if (error instanceof WebAdapterError || error?.name === "SearchAdapterError") throw new WebAdapterError(error.category, error.retryable, error.providerCode);
      throw new WebAdapterError("provider");
    } finally { secret = undefined; }
  }
}
