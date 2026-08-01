import { searchRequestContract, searchResponseContract } from "./contracts.mjs";

export const BRAVE_SEARCH_ORIGIN = "https://api.search.brave.com";
export const BRAVE_SEARCH_ADAPTER_VERSION = "brave-web-search-v1";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class SearchAdapterError extends Error {
  constructor(category, retryable = false, providerCode) {
    super("search adapter invocation failed");
    this.name = "SearchAdapterError";
    this.category = category;
    this.retryable = retryable === true;
    if (providerCode !== undefined) this.providerCode = String(providerCode);
  }
}

const failure = (category, retryable, code) => new SearchAdapterError(category, retryable, code);

export function buildBraveSearchRequest(input) {
  const request = searchRequestContract(input);
  const url = new URL("/res/v1/web/search", BRAVE_SEARCH_ORIGIN);
  url.search = new URLSearchParams({ q: request.query, count: String(request.count), country: request.country,
    search_lang: request.searchLanguage, safesearch: "strict", extra_snippets: "false" }).toString();
  return Object.freeze({ url: url.href, method: "GET" });
}

async function boundedText(response) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw failure("malformed-response", false);
  if (!response.body || typeof response.body.getReader !== "function") {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES) throw failure("malformed-response", false);
    return bytes.toString("utf8");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw failure("malformed-response", false); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function httpFailure(status) {
  if (status === 401 || status === 403) return failure("auth", false, status);
  if (status === 429) return failure("rate-limit", true, status);
  if (status === 408 || status === 504) return failure("timeout", true, status);
  if (status >= 500) return failure("provider", true, status);
  return failure("policy", false, status);
}

export function normalizeBraveSearchResponse(input, requestInput) {
  const request = searchRequestContract(requestInput);
  try {
    if (!input || typeof input !== "object" || !input.web || !Array.isArray(input.web.results)) throw failure("malformed-response", false);
    return searchResponseContract({
      adapterId: "brave-search", adapterVersion: BRAVE_SEARCH_ADAPTER_VERSION,
      results: input.web.results.slice(0, request.count).map((item, index) => {
        if (!item || typeof item.title !== "string" || typeof item.url !== "string" || typeof item.description !== "string") {
          throw failure("malformed-response", false);
        }
        return { rank: index + 1, title: item.title, url: item.url, description: item.description };
      }),
    }, request);
  } catch (error) {
    if (error instanceof SearchAdapterError) throw error;
    throw failure("malformed-response", false);
  }
}

export class BraveSearchAdapter {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("Brave fetch implementation is required");
    this.id = "brave-search";
    this.fetchImpl = fetchImpl;
  }

  async search(input, { credential, signal } = {}) {
    const request = searchRequestContract(input);
    if (typeof credential !== "string" || credential.length === 0 || /\s/.test(credential)) throw failure("auth", false);
    const outbound = buildBraveSearchRequest(request);
    let response;
    try {
      response = await this.fetchImpl(outbound.url, { method: "GET", headers: {
        accept: "application/json", "accept-encoding": "gzip", "x-subscription-token": credential,
      }, redirect: "error", signal });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw failure("canceled", false);
      if (error?.name === "TimeoutError") throw failure("timeout", true);
      throw failure("unknown-outcome", false);
    }
    if (!response || typeof response.status !== "number") throw failure("malformed-response", false);
    if (!response.ok) throw httpFailure(response.status);
    try { return normalizeBraveSearchResponse(JSON.parse(await boundedText(response)), request); }
    catch (error) { if (error instanceof SearchAdapterError) throw error; throw failure("malformed-response", false); }
  }
}
