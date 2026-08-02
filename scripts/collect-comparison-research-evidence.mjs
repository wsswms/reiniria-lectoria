import { constants } from "node:fs";
import { lookup } from "node:dns/promises";
import { open, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRealBraveGatewayAdapter } from "../src/research/real-brave-evaluation.mjs";
import { RestrictedFetchProxy } from "../src/search/fetch-proxy.mjs";
import { loadRealArticlePilotConfig, preflightRealArticlePilot } from "../src/pilot/preflight.mjs";
import { createPinnedHttpsTransport, createRobotsPolicy } from "../src/pilot/restricted-https-transport.mjs";

async function privateJson(path, maximum, label) {
  if (typeof path !== "string" || resolve(path) !== path) throw new Error(`${label} path must be absolute`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > maximum || (info.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error(`${label} is not a private regular file`);
    return JSON.parse((await handle.readFile()).toString("utf8"));
  } finally { await handle.close(); }
}

async function atomicPrivate(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}

function manifestContract(input, config) {
  if (!input || input.schemaVersion !== "lectoria-comparison-evidence-manifest-v1"
    || Object.keys(input).sort().join(",") !== "queries,schemaVersion" || !Array.isArray(input.queries)
    || input.queries.length < 1 || input.queries.length > config.brave.maxCalls) throw new Error("evidence manifest is invalid");
  let fetches = 0;
  const ids = new Set();
  for (const item of input.queries) {
    if (!item || Object.keys(item).sort().join(",") !== "id,query,selectedRanks" || typeof item.id !== "string"
      || !/^[a-z0-9-]{3,64}$/.test(item.id) || ids.has(item.id) || typeof item.query !== "string"
      || item.query.length < 3 || item.query.length > 512 || !Array.isArray(item.selectedRanks)
      || item.selectedRanks.length < 1 || item.selectedRanks.length > config.brave.maxResultsPerSearch
      || item.selectedRanks.some((rank) => !Number.isInteger(rank) || rank < 1 || rank > config.brave.maxResultsPerSearch)
      || new Set(item.selectedRanks).size !== item.selectedRanks.length) throw new Error("evidence query is invalid");
    ids.add(item.id); fetches += item.selectedRanks.length;
  }
  if (fetches > config.fetch.maxUrls) throw new Error("evidence fetch plan exceeds the authorized limit");
  return input;
}

let outputPath;
let record;
try {
  if (process.argv.length !== 4) throw new Error("invalid invocation");
  const config = await loadRealArticlePilotConfig(process.argv[2], { allowLive: true });
  if (config.mode !== "live") throw new Error("live mode is required");
  await preflightRealArticlePilot(config, { allowLive: true });
  const manifest = manifestContract(await privateJson(process.argv[3], 64 * 1024, "evidence manifest"), config);
  const resolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((item) => item.address);
  const transport = createPinnedHttpsTransport();
  const fetchProxy = new RestrictedFetchProxy({ resolver, transport, robotsAllowed: createRobotsPolicy({ resolver, transport }),
    timeoutMs: config.fetch.timeoutMs, maxConcurrency: config.fetch.maxConcurrency });
  const brave = createRealBraveGatewayAdapter({ credentialPath: config.brave.credentialPath,
    costMicrosUsdPerCall: config.brave.costMicrosPerCall, brokerOptions: { timeoutMs: 30_000 } });
  record = { schemaVersion: "lectoria-comparison-research-evidence-v1", createdAt: new Date().toISOString(),
    articleDigest: config.article.digest, acquisition: [], evidence: [] };
  outputPath = join(config.output.directory, "comparison-research-evidence.json");
  for (const item of manifest.queries) {
    const search = await brave.search({ query: item.query, count: config.brave.maxResultsPerSearch,
      country: config.brave.country, searchLanguage: config.brave.searchLanguage });
    const acquired = { id: item.id, query: item.query, resultCount: search.results.length, selected: [] };
    for (const rank of item.selectedRanks) {
      const selected = search.results.find((result) => result.rank === rank);
      if (!selected || new URL(selected.url).protocol !== "https:") {
        acquired.selected.push({ rank, status: "not-fetchable" }); continue;
      }
      try {
        const fetched = await fetchProxy.fetchSelected({ url: selected.url });
        const observationId = `${item.id}-rank-${rank}`;
        record.evidence.push({ observationId, queryId: item.id, rank, url: fetched.finalUrl,
          title: fetched.title || selected.title, content: fetched.extractedText.slice(0, 50_000) });
        acquired.selected.push({ rank, status: "fetched", observationId, statusCode: fetched.statusCode,
          contentBytes: Buffer.byteLength(fetched.extractedText), retainedBytes: Buffer.byteLength(record.evidence.at(-1).content) });
      } catch (error) { acquired.selected.push({ rank, status: "failed", category: error?.category ?? "fetch" }); }
    }
    record.acquisition.push(acquired);
    await atomicPrivate(outputPath, record);
  }
  process.stdout.write(`${JSON.stringify({ status: "completed", outputPath, searchCalls: manifest.queries.length,
    plannedFetches: manifest.queries.reduce((total, item) => total + item.selectedRanks.length, 0),
    successfulFetches: record.evidence.length, uniqueOrigins: new Set(record.evidence.map((item) => new URL(item.url).origin)).size })}\n`);
} catch (error) {
  if (outputPath && record) try { await atomicPrivate(outputPath, record); } catch {}
  process.stderr.write(`${JSON.stringify({ status: "failed", category: error?.category ?? "evidence" })}\n`);
  process.exitCode = 1;
}
