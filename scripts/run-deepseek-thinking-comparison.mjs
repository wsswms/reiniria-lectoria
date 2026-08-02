import { lookup } from "node:dns/promises";
import { open, rename } from "node:fs/promises";
import { join } from "node:path";
import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { createRealBraveGatewayAdapter } from "../src/research/real-brave-evaluation.mjs";
import { RestrictedFetchProxy } from "../src/search/fetch-proxy.mjs";
import { deepSeekThinkingComparisonRequestContract, summarizeDeepSeekRawResponse } from "../src/pilot/deepseek-thinking-comparison.mjs";
import { invokeDeepSeekThinkingComparison } from "../src/pilot/thinking-comparison-broker-process.mjs";
import { loadRealArticlePilotConfig, preflightRealArticlePilot } from "../src/pilot/preflight.mjs";
import { createPinnedHttpsTransport, createRobotsPolicy } from "../src/pilot/restricted-https-transport.mjs";

async function privateAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}

let recordPath = null;
let record = null;
try {
  if (process.argv.length !== 3) throw new Error("invalid invocation");
  const config = await loadRealArticlePilotConfig(process.argv[2], { allowLive: true });
  if (config.mode !== "live" || config.deepseek.research.maxCalls < 2 || config.brave.maxCalls < config.research.questions.length
    || config.fetch.maxUrls < config.research.questions.length) throw new Error("comparison live limits are insufficient");
  await preflightRealArticlePilot(config, { allowLive: true });
  recordPath = join(config.output.directory, "deepseek-thinking-comparison.json");
  const resolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((item) => item.address);
  const transport = createPinnedHttpsTransport();
  const fetchProxy = new RestrictedFetchProxy({ resolver, transport, robotsAllowed: createRobotsPolicy({ resolver, transport }),
    timeoutMs: config.fetch.timeoutMs, maxConcurrency: config.fetch.maxConcurrency });
  const brave = createRealBraveGatewayAdapter({ credentialPath: config.brave.credentialPath,
    costMicrosUsdPerCall: config.brave.costMicrosPerCall, brokerOptions: { timeoutMs: 30_000 } });
  const evidence = [];
  const acquisition = [];
  for (const [index, question] of config.research.questions.entries()) {
    const search = await brave.search({ query: question, count: config.brave.maxResultsPerSearch,
      country: config.brave.country, searchLanguage: config.brave.searchLanguage });
    const selected = search.results.find((item) => new URL(item.url).protocol === "https:");
    if (!selected) throw new Error("no HTTPS search result was selected");
    const fetched = await fetchProxy.fetchSelected({ url: selected.url });
    const content = fetched.extractedText.slice(0, 20_000);
    evidence.push({ observationId: `evidence-${index + 1}`, url: fetched.finalUrl, title: fetched.title || selected.title, content });
    acquisition.push({ questionIndex: index, searchResultCount: search.results.length, selectedRank: selected.rank,
      fetchedStatus: fetched.statusCode, fetchedMimeType: fetched.mimeType, originalContentBytes: Buffer.byteLength(fetched.extractedText),
      promptContentBytes: Buffer.byteLength(content), truncatedForPrompt: content.length < fetched.extractedText.length });
  }
  const base = { modelId: config.deepseek.modelId, questions: config.research.questions, evidence,
    maxOutputTokens: config.deepseek.research.maxOutputTokens };
  record = { schemaVersion: "lectoria-deepseek-thinking-comparison-v1", createdAt: new Date().toISOString(),
    articleDigest: config.article.digest, acquisition, runs: [] };
  for (const thinkingMode of ["disabled", "enabled"]) {
    const request = deepSeekThinkingComparisonRequestContract({ ...base, thinkingMode });
    const credential = await openCredentialFile(config.deepseek.credentialPath);
    try {
      const result = await invokeDeepSeekThinkingComparison({ request, credentialFd: credential.fd });
      record.runs.push({ thinkingMode, request: result.outbound, rawResponse: { httpStatus: result.status,
        responseText: result.responseText, durationMs: result.durationMs }, summary: summarizeDeepSeekRawResponse({ status: result.status,
        responseText: result.responseText, durationMs: result.durationMs }) });
    } catch (error) {
      record.runs.push({ thinkingMode, error: { category: error?.category ?? "comparison" } });
    } finally { await credential.close(); }
    await privateAtomic(recordPath, record);
  }
  process.stdout.write(`${JSON.stringify({ status: "completed", recordPath, evidence: evidence.length,
    searchCalls: config.research.questions.length, fetchUrls: evidence.length,
    runs: record.runs.map((item) => item.summary ? { thinkingMode: item.thinkingMode, ...item.summary } : { thinkingMode: item.thinkingMode, error: item.error }) })}\n`);
} catch (error) {
  if (recordPath && record) try { await privateAtomic(recordPath, record); } catch {}
  process.stderr.write(`${JSON.stringify({ status: "failed", category: error?.category ?? "comparison" })}\n`);
  process.exitCode = 1;
}
