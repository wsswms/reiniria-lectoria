import { lookup } from "node:dns/promises";
import { open, readFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { createRealBraveGatewayAdapter } from "../src/research/real-brave-evaluation.mjs";
import { RestrictedFetchProxy } from "../src/search/fetch-proxy.mjs";
import { DEEPSEEK_V4_FLASH_MAX_OUTPUT_TOKENS, deepSeekThinkingComparisonRequestContract,
  summarizeDeepSeekRawResponse } from "../src/pilot/deepseek-thinking-comparison.mjs";
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
  if (process.argv.length < 3 || process.argv.length > 4) throw new Error("invalid invocation");
  const replayAtProviderLimit = process.argv[3] === "--reuse-evidence-at-provider-limit";
  if (process.argv.length === 4 && !replayAtProviderLimit) throw new Error("invalid invocation");
  const config = await loadRealArticlePilotConfig(process.argv[2], { allowLive: true });
  if (config.mode !== "live" || config.deepseek.research.maxCalls < 2 || (!replayAtProviderLimit
    && (config.brave.maxCalls < config.research.questions.length || config.fetch.maxUrls < config.research.questions.length))) {
    throw new Error("comparison live limits are insufficient");
  }
  await preflightRealArticlePilot(config, { allowLive: true });
  recordPath = join(config.output.directory, replayAtProviderLimit
    ? "deepseek-thinking-comparison-provider-limit.json" : "deepseek-thinking-comparison.json");
  const resolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((item) => item.address);
  const transport = createPinnedHttpsTransport();
  const fetchProxy = new RestrictedFetchProxy({ resolver, transport, robotsAllowed: createRobotsPolicy({ resolver, transport }),
    timeoutMs: config.fetch.timeoutMs, maxConcurrency: config.fetch.maxConcurrency });
  const brave = createRealBraveGatewayAdapter({ credentialPath: config.brave.credentialPath,
    costMicrosUsdPerCall: config.brave.costMicrosPerCall, brokerOptions: { timeoutMs: 30_000 } });
  let evidence = [];
  let acquisition = [];
  let evidenceReuse = null;
  if (replayAtProviderLimit) {
    const sourceBytes = await readFile(join(config.output.directory, "deepseek-thinking-comparison.json"));
    const source = JSON.parse(sourceBytes.toString("utf8"));
    if (source?.schemaVersion !== "lectoria-deepseek-thinking-comparison-v1" || source.articleDigest !== config.article.digest
      || !Array.isArray(source.runs) || source.runs.length !== 2) throw new Error("comparison source record is invalid");
    const userMessage = source.runs[0]?.request?.body?.messages?.find((item) => item?.role === "user")?.content;
    const replay = JSON.parse(userMessage);
    if (JSON.stringify(replay.questions) !== JSON.stringify(config.research.questions)) throw new Error("comparison source questions changed");
    evidence = replay.evidence;
    evidenceReuse = { sourceRecordSha256: createHash("sha256").update(sourceBytes).digest("hex"), searchCalls: 0, fetchUrls: 0 };
  } else {
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
  }
  const base = { modelId: config.deepseek.modelId, questions: config.research.questions, evidence,
    maxOutputTokens: replayAtProviderLimit ? DEEPSEEK_V4_FLASH_MAX_OUTPUT_TOKENS : config.deepseek.research.maxOutputTokens };
  record = { schemaVersion: replayAtProviderLimit ? "lectoria-deepseek-thinking-comparison-v2" : "lectoria-deepseek-thinking-comparison-v1",
    createdAt: new Date().toISOString(), articleDigest: config.article.digest, acquisition, evidenceReuse, runs: [] };
  for (const thinkingMode of ["disabled", "enabled"]) {
    const request = deepSeekThinkingComparisonRequestContract({ ...base, thinkingMode });
    const credential = await openCredentialFile(config.deepseek.credentialPath);
    try {
      const result = await invokeDeepSeekThinkingComparison({ request, credentialFd: credential.fd },
        { timeoutMs: replayAtProviderLimit ? 600_000 : 90_000 });
      record.runs.push({ thinkingMode, request: result.outbound, rawResponse: { httpStatus: result.status,
        responseText: result.responseText, durationMs: result.durationMs }, summary: summarizeDeepSeekRawResponse({ status: result.status,
        responseText: result.responseText, durationMs: result.durationMs }) });
    } catch (error) {
      record.runs.push({ thinkingMode, error: { category: error?.category ?? "comparison" } });
    } finally { await credential.close(); }
    await privateAtomic(recordPath, record);
  }
  process.stdout.write(`${JSON.stringify({ status: "completed", recordPath, evidence: evidence.length,
    searchCalls: replayAtProviderLimit ? 0 : config.research.questions.length, fetchUrls: replayAtProviderLimit ? 0 : evidence.length,
    runs: record.runs.map((item) => item.summary ? { thinkingMode: item.thinkingMode, ...item.summary } : { thinkingMode: item.thinkingMode, error: item.error }) })}\n`);
} catch (error) {
  if (recordPath && record) try { await privateAtomic(recordPath, record); } catch {}
  process.stderr.write(`${JSON.stringify({ status: "failed", category: error?.category ?? "comparison" })}\n`);
  process.exitCode = 1;
}
