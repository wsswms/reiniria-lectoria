import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { adapterManifest } from "./adapter-manifest.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class WebAdapterError extends Error {
  constructor(category, retryable = false, providerCode) { super("web adapter invocation failed"); this.name = "WebAdapterError";
    this.category = category; this.retryable = retryable; if (providerCode !== undefined) this.providerCode = String(providerCode); }
}
const fail = (category, retryable = false, code) => new WebAdapterError(category, retryable, code);

async function body(response) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw fail("malformed-response");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES) throw fail("malformed-response");
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw fail("malformed-response"); }
}
function http(status) {
  if ([401, 403].includes(status)) return fail("auth", false, status);
  if (status === 429) return fail("rate-limit", true, status);
  if ([408, 504].includes(status)) return fail("timeout", true, status);
  return status >= 500 ? fail("provider", true, status) : fail("policy", false, status);
}
function credential(value) { if (typeof value !== "string" || value.length < 1 || /\s/.test(value)) throw fail("auth"); return value; }
function request(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !["query", "count", "country", "searchLanguage", "filters"].includes(key))
    || typeof input.query !== "string" || input.query.trim().length < 1 || input.query.length > 2048
    || !Number.isInteger(input.count) || input.count < 1 || input.count > 20) throw new TypeError("web search request is invalid");
  return { query: input.query, count: input.count, country: input.country, searchLanguage: input.searchLanguage };
}
function result(item, rank, fields) {
  if (!item || item.directWebEvidence === true || typeof item[fields.title] !== "string" || typeof item[fields.url] !== "string"
    || typeof item[fields.description] !== "string") throw fail("malformed-response");
  const url = new URL(item[fields.url]).toString();
  return Object.freeze({ rank, title: item[fields.title], url, description: item[fields.description] });
}
function normalized(adapterId, adapterVersion, values) {
  const results = Object.freeze(values);
  return Object.freeze({ adapterId, adapterVersion, results, responseDigest: sha(stableJson(results)),
    usage: Object.freeze({ searchCalls: 1, contentUrls: 0, modelTokens: 0, costMicrosUsd: 0 }) });
}

class HttpAdapter {
  constructor(id, capability, fetchImpl) { this.id = id; this.manifest = adapterManifest(id, capability);
    if (typeof fetchImpl !== "function") throw new TypeError("adapter fetch implementation is required"); this.fetchImpl = fetchImpl; }
  async invoke(url, init, signal) {
    let response;
    try { response = await this.fetchImpl(url, { ...init, redirect: "error", signal }); }
    catch (error) { if (signal?.aborted || error?.name === "AbortError") throw fail("canceled"); if (error?.name === "TimeoutError") throw fail("timeout", true); throw fail("unknown-outcome"); }
    if (!response || typeof response.status !== "number") throw fail("malformed-response");
    if (!response.ok) throw http(response.status);
    return body(response);
  }
}

export class SerperSearchAdapter extends HttpAdapter {
  constructor({ fetchImpl = globalThis.fetch } = {}) { super("serper-search", "search", fetchImpl); }
  async search(input, { credential: secret, signal } = {}) {
    const value = request(input); const payload = await this.invoke(`${this.manifest.origin}/search`, { method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "x-api-key": credential(secret) },
      body: JSON.stringify({ q: value.query, num: value.count, gl: value.country, hl: value.searchLanguage }) }, signal);
    if (!Array.isArray(payload.organic)) throw fail("malformed-response");
    return normalized(this.id, this.manifest.adapterVersion, payload.organic.slice(0, value.count).map((item, index) => result(item, index + 1,
      { title: "title", url: "link", description: "snippet" })));
  }
}

export class TavilySearchAdapter extends HttpAdapter {
  constructor({ fetchImpl = globalThis.fetch } = {}) { super("tavily-search", "search", fetchImpl); }
  async search(input, { credential: secret, signal } = {}) {
    const value = request(input); const payload = await this.invoke(`${this.manifest.origin}/search`, { method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${credential(secret)}` },
      body: JSON.stringify({ query: value.query, max_results: value.count, include_raw_content: false }) }, signal);
    if (!Array.isArray(payload.results)) throw fail("malformed-response");
    return normalized(this.id, this.manifest.adapterVersion, payload.results.slice(0, value.count).map((item, index) => result(item, index + 1,
      { title: "title", url: "url", description: "content" })));
  }
}

export class TavilyExtractAdapter extends HttpAdapter {
  constructor({ fetchImpl = globalThis.fetch } = {}) { super("tavily-extract", "extract", fetchImpl); }
  async extract(input, { credential: secret, signal } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "url")) throw new TypeError("extract request is invalid");
    const url = new URL(input.url).toString(); const payload = await this.invoke(`${this.manifest.origin}/extract`, { method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${credential(secret)}` },
      body: JSON.stringify({ urls: [url], extract_depth: "basic" }) }, signal);
    const item = payload.results?.[0];
    if (!item || item.directWebEvidence === true || new URL(item.url).toString() !== url || typeof item.raw_content !== "string"
      || item.raw_content.length < 1 || item.raw_content.length > 262144) throw fail("malformed-response");
    return Object.freeze({ adapterId: this.id, adapterVersion: this.manifest.adapterVersion, url, content: item.raw_content,
      contentDigest: sha(item.raw_content), lineage: "provider-processed", directWebEvidence: false,
      usage: Object.freeze({ searchCalls: 0, contentUrls: 1, modelTokens: 0, costMicrosUsd: 0 }) });
  }
}
