import https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { assertPublicAddress, normalizeFetchUrl } from "./fetch-proxy.mjs";

const USER_AGENT = "Reiniria-Lectoria-Evidence-Fetch/1.0";

export function createPinnedHttpsTransport({ requestImpl = https.request, timeoutMs = 15_000, maxBytes = 1024 * 1024 } = {}) {
  if (typeof requestImpl !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
    || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024) throw new TypeError("HTTPS transport options are invalid");
  return ({ url, approvedAddresses, method = "GET", headers = {}, signal } = {}) => {
    const target = new URL(normalizeFetchUrl(url));
    if (!Array.isArray(approvedAddresses) || approvedAddresses.length < 1) throw new TypeError("approved HTTPS addresses are required");
    const addresses = [...new Set(approvedAddresses.map(assertPublicAddress))];
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => { if (!settled) { settled = true; signal?.removeEventListener?.("abort", abort); fn(value); } };
      const request = requestImpl({ protocol: "https:", hostname: target.hostname, servername: target.hostname, port: 443,
        path: `${target.pathname}${target.search}`, method,
        headers: { ...headers, "accept-encoding": "identity", "user-agent": USER_AGENT },
        lookup: (_hostname, options, callback) => options?.all
          ? callback(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })))
          : callback(null, addresses[0], addresses[0].includes(":") ? 6 : 4) }, (response) => {
        const chunks = []; let bytes = 0;
        response.on("data", (chunk) => { bytes += chunk.length;
          if (bytes > maxBytes) request.destroy(Object.assign(new Error("HTTPS body exceeds limit"), { category: "size" })); else chunks.push(chunk); });
        response.once("error", (error) => finish(reject, error));
        response.once("end", () => finish(resolve, new Response(new Set([101, 204, 205, 304]).has(response.statusCode) ? null : Buffer.concat(chunks), { status: response.statusCode,
          headers: Object.entries(response.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(", ") : String(value)]]) })));
      });
      const abort = () => request.destroy(Object.assign(new Error("HTTPS fetch canceled"), { name: "AbortError", category: "canceled" }));
      signal?.addEventListener?.("abort", abort, { once: true });
      request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error("HTTPS fetch timed out"), { category: "timeout" })));
      request.once("error", (error) => finish(reject, error));
      if (signal?.aborted) abort(); else request.end();
    });
  };
}

function groups(text) {
  const output = []; let agents = []; let rules = [];
  const flush = () => { if (agents.length) output.push({ agents, rules }); agents = []; rules = []; };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim(); if (!line) { flush(); continue; }
    const match = /^([^:]+):(.*)$/.exec(line); if (!match) continue;
    const key = match[1].trim().toLocaleLowerCase(), value = match[2].trim();
    if (key === "user-agent") { if (rules.length) flush(); agents.push(value.toLocaleLowerCase()); }
    else if (["allow", "disallow"].includes(key) && agents.length && value) rules.push({ allow: key === "allow", path: value });
  }
  flush(); return output;
}

export function robotsAllows(text, path, userAgent = USER_AGENT) {
  const name = userAgent.toLocaleLowerCase();
  const parsed = groups(text);
  const specific = parsed.filter((group) => group.agents.some((agent) => agent !== "*" && name.includes(agent)));
  const selected = specific.length ? specific : parsed.filter((group) => group.agents.includes("*"));
  const matches = selected.flatMap((group) => group.rules).filter((rule) => path.startsWith(rule.path));
  if (!matches.length) return true;
  matches.sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  return matches[0].allow;
}

export function createRestrictedRobotsPolicy({ transport, resolver = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((item) => item.address),
  userAgent = USER_AGENT } = {}) {
  if (typeof transport !== "function" || typeof resolver !== "function") throw new TypeError("robots policy dependencies are invalid");
  const cache = new Map();
  return async (url) => {
    const origin = url.origin;
    if (!cache.has(origin)) cache.set(origin, (async () => {
      const addresses = [...new Set(await resolver(url.hostname))].map(assertPublicAddress);
      if (!addresses.length) return false;
      const response = await transport({ url: `${origin}/robots.txt`, approvedAddresses: addresses, method: "GET",
        headers: { accept: "text/plain" } });
      if (response.status === 404 || response.status === 410) return "";
      if (!response.ok) throw Object.assign(new Error("robots policy unavailable"), { category: "robots" });
      return response.text();
    })());
    try { return robotsAllows(await cache.get(origin), `${url.pathname}${url.search}`, userAgent); }
    catch { cache.delete(origin); return false; }
  };
}

export const RESEARCH_FETCH_USER_AGENT = USER_AGENT;
