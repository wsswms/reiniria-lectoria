import https from "node:https";
import { Readable } from "node:stream";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { assertPublicAddress, normalizeFetchUrl } from "../search/fetch-proxy.mjs";

const AGENT = "ReiniriaLectoriaPilot";

function defaultRequest({ url, address, servername, method, headers, signal }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url); const family = isIP(address);
    const request = https.request({ protocol: "https:", hostname: address, port: 443, servername, method,
      path: `${parsed.pathname}${parsed.search}`, headers: { ...headers, host: parsed.host, "accept-encoding": "identity", "user-agent": AGENT },
      lookup(_hostname, _options, callback) { callback(null, address, family); }, rejectUnauthorized: true, signal }, (response) => {
      resolve(new Response(Readable.toWeb(response), { status: response.statusCode, statusText: response.statusMessage,
        headers: Object.entries(response.headers).flatMap(([name, value]) => Array.isArray(value) ? value.map((item) => [name, item]) : value === undefined ? [] : [[name, value]]) }));
    });
    request.once("error", reject); request.end();
  });
}

export function createPinnedHttpsTransport({ requestImpl = defaultRequest } = {}) {
  if (typeof requestImpl !== "function") throw new TypeError("requestImpl is required");
  return async ({ url, approvedAddresses, method = "GET", headers = {}, signal } = {}) => {
    const normalized = normalizeFetchUrl(url); if (!Array.isArray(approvedAddresses) || approvedAddresses.length < 1) throw new TypeError("approvedAddresses are required");
    const addresses = [...new Set(approvedAddresses.map(assertPublicAddress))]; const servername = new URL(normalized).hostname;
    let last; for (const address of addresses) { try { return await requestImpl({ url: normalized, address, servername, method, headers, signal }); } catch (error) { last = error; } }
    throw last ?? new Error("pinned HTTPS request failed");
  };
}

export function parseRobots(text, agent = AGENT) {
  const groups = []; let current = null;
  for (const raw of String(text).split(/\r?\n/u)) {
    const line = raw.replace(/#.*$/u, "").trim(); if (!line.includes(":")) continue;
    const [rawName, ...rest] = line.split(":"); const name = rawName.trim().toLowerCase(); const value = rest.join(":").trim();
    if (name === "user-agent") { if (!current || current.rules.length > 0) { current = { agents: [], rules: [] }; groups.push(current); } current.agents.push(value.toLowerCase()); }
    else if (current && new Set(["allow", "disallow"]).has(name)) current.rules.push({ allow: name === "allow", path: value });
  }
  const lower = agent.toLowerCase(); const selected = groups.filter((group) => group.agents.includes(lower)); const fallback = selected.length ? selected : groups.filter((group) => group.agents.includes("*"));
  const rules = fallback.flatMap((group) => group.rules).filter((rule) => rule.path.length > 0);
  return (url) => { const path = `${url.pathname}${url.search}`; const matches = rules.filter((rule) => path.startsWith(rule.path)).sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow)); return matches[0]?.allow ?? true; };
}

export function createRobotsPolicy({ resolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((item) => item.address),
  transport, agent = AGENT, cache = new Map() } = {}) {
  if (typeof resolver !== "function" || typeof transport !== "function") throw new TypeError("robots dependencies are required");
  return async (urlInput) => {
    try {
      const url = urlInput instanceof URL ? urlInput : new URL(urlInput); const origin = url.origin; let policy = cache.get(origin);
      if (!policy) { const addresses = [...new Set(await resolver(url.hostname))].map(assertPublicAddress); if (addresses.length === 0) return false;
        const robotsUrl = `${origin}/robots.txt`; const response = await transport({ url: robotsUrl, approvedAddresses: addresses, method: "GET", headers: { accept: "text/plain" } });
        if (response.status === 404) policy = () => true; else if (!response.ok || !String(response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/plain")) return false;
        else { const text = await response.text(); if (Buffer.byteLength(text) > 512 * 1024) return false; policy = parseRobots(text, agent); } cache.set(origin, policy); }
      return policy(url);
    } catch { return false; }
  };
}
