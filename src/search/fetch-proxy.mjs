import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { unified } from "unified";
import rehypeParse from "rehype-parse";
import { stableJson } from "../domain/contracts.mjs";

export const FETCH_POLICY_VERSION = "restricted-fetch-v1";
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TEXT_CHARS = 262_144;
const MAX_REDIRECTS = 3;

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]]) {
  blocked.addSubnet(address, prefix, "ipv6");
}

export class FetchPolicyError extends Error {
  constructor(category = "policy", message = "restricted fetch failed") {
    super(message);
    this.name = "FetchPolicyError";
    this.category = category;
    this.retryable = false;
  }
}

export function assertPublicAddress(address) {
  const family = isIP(address);
  if (!family || (family === 6 && /^::ffff:/i.test(address)) || blocked.check(address, family === 4 ? "ipv4" : "ipv6")) throw new FetchPolicyError("policy", "fetch address is not public");
  return address;
}

export function normalizeFetchUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new FetchPolicyError("policy", "fetch URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || url.href.length > 4096) {
    throw new FetchPolicyError("policy", "fetch URL is not allowed");
  }
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new FetchPolicyError("policy", "fetch hostname is not allowed");
  }
  if (isIP(hostname)) assertPublicAddress(hostname);
  url.hash = "";
  return url.href;
}

async function defaultResolver(hostname) {
  return (await lookup(hostname, { all: true, verbatim: true })).map((item) => item.address);
}

async function boundedBody(response) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new FetchPolicyError("size", "fetch body is too large");
  if (!response.body || typeof response.body.getReader !== "function") {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BODY_BYTES) throw new FetchPolicyError("size", "fetch body is too large");
    return bytes.toString("utf8");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new FetchPolicyError("size", "fetch body is too large"); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizeSpace(value) {
  return value.replace(/\s+/g, " ").trim();
}

export function extractUntrustedText(mimeType, body) {
  if (mimeType === "text/plain") {
    const text = normalizeSpace(body);
    if (!text) throw new FetchPolicyError("malformed-response", "fetch content is empty");
    return Object.freeze({ title: "", text: text.slice(0, MAX_TEXT_CHARS), truncated: text.length > MAX_TEXT_CHARS, diagnostics: Object.freeze([]) });
  }
  let tree;
  try { tree = unified().use(rehypeParse).parse(body); } catch { throw new FetchPolicyError("malformed-response", "HTML cannot be parsed"); }
  let title = "";
  const parts = [];
  let nodes = 0;
  function visit(node, ignored = false) {
    nodes += 1;
    if (nodes > 100_000) throw new FetchPolicyError("size", "HTML node limit exceeded");
    const nextIgnored = ignored || (node.type === "element" && ["script", "style", "noscript", "template", "svg", "canvas"].includes(node.tagName));
    if (!nextIgnored && node.type === "text") parts.push(node.value);
    if (!ignored && node.type === "element" && node.tagName === "title") {
      title = normalizeSpace((node.children ?? []).filter((child) => child.type === "text").map((child) => child.value).join(" ")).slice(0, 2048);
    }
    for (const child of node.children ?? []) visit(child, nextIgnored);
  }
  visit(tree);
  const text = normalizeSpace(parts.join(" "));
  if (!text) throw new FetchPolicyError("malformed-response", "HTML extracted text is empty");
  return Object.freeze({ title, text: text.slice(0, MAX_TEXT_CHARS), truncated: text.length > MAX_TEXT_CHARS,
    diagnostics: Object.freeze(["scripts-not-executed", "active-content-removed"]) });
}

export class RestrictedFetchProxy {
  constructor({ resolver = defaultResolver, transport = null, robotsAllowed = async () => false,
    policyVersion = FETCH_POLICY_VERSION, now = () => new Date(), timeoutMs = 5_000, maxConcurrency = 4 } = {}) {
    if (typeof resolver !== "function" || (transport !== null && typeof transport !== "function") || typeof robotsAllowed !== "function") throw new TypeError("fetch proxy dependency is invalid");
    this.resolver = resolver;
    this.transport = transport;
    this.robotsAllowed = robotsAllowed;
    this.policyVersion = policyVersion;
    this.now = now;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 || !Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 16) throw new TypeError("fetch proxy limits are invalid");
    this.timeoutMs = timeoutMs;
    this.maxConcurrency = maxConcurrency;
    this.active = 0;
  }

  async fetchSelected({ url, signal } = {}) {
    if (!this.transport) throw new FetchPolicyError("unavailable", "restricted fetch transport is unavailable");
    if (this.active >= this.maxConcurrency) throw new FetchPolicyError("concurrency", "fetch concurrency limit exceeded");
    this.active += 1;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener?.("abort", abort, { once: true });
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { abort(); reject(new FetchPolicyError("timeout", "fetch timed out")); }, this.timeoutMs); });
    try { return await Promise.race([this.#perform(url, controller.signal), timeout]); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abort);
      this.active -= 1;
    }
  }

  async #perform(url, signal) {
    let current = normalizeFetchUrl(url);
    const redirects = [];
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const parsed = new URL(current);
      const addresses = [...new Set(await this.resolver(parsed.hostname))].sort();
      if (addresses.length === 0) throw new FetchPolicyError("network", "fetch DNS returned no addresses");
      addresses.forEach(assertPublicAddress);
      if (!await this.robotsAllowed(parsed)) throw new FetchPolicyError("robots", "fetch is disallowed by robots policy");
      const response = await this.transport({ url: current, approvedAddresses: Object.freeze(addresses), method: "GET",
        headers: Object.freeze({ accept: "text/html,text/plain;q=0.9", "accept-encoding": "gzip,br" }), signal });
      if (!response || typeof response.status !== "number") throw new FetchPolicyError("malformed-response");
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirect === MAX_REDIRECTS) throw new FetchPolicyError("policy", "fetch redirect limit exceeded");
        const location = response.headers?.get?.("location");
        if (!location) throw new FetchPolicyError("malformed-response", "fetch redirect is missing location");
        const next = normalizeFetchUrl(new URL(location, current).href);
        redirects.push({ from: current, to: next });
        current = next;
        continue;
      }
      if (response.status < 200 || response.status > 299) throw new FetchPolicyError(response.status === 429 ? "rate-limit" : "provider");
      const rawMime = String(response.headers?.get?.("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
      if (!new Set(["text/html", "text/plain"]).has(rawMime)) throw new FetchPolicyError("mime", "fetch MIME is not allowed");
      const extracted = extractUntrustedText(rawMime, await boundedBody(response));
      const canonical = { requestedUrl: normalizeFetchUrl(url), finalUrl: current, statusCode: response.status, mimeType: rawMime,
        title: extracted.title, extractedText: extracted.text, truncated: extracted.truncated, diagnostics: extracted.diagnostics,
        redirects, policyVersion: this.policyVersion };
      return Object.freeze({ ...canonical, fetchedAt: this.now().toISOString(), contentDigest: sha(extracted.text), snapshotDigest: sha(stableJson(canonical)), untrusted: true });
    }
    throw new FetchPolicyError("policy");
  }
}
