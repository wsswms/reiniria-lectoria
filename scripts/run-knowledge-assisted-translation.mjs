import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadRealArticlePilotConfig, preflightRealArticlePilot } from "../src/pilot/preflight.mjs";
import { createLivePilotOperations } from "../src/pilot/live-operations.mjs";
import { buildDeepSeekRequest } from "../src/provider/deepseek-provider.mjs";
import { providerResponseContract } from "../src/provider/contracts.mjs";

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

let operations;
let stage = "preflight";
let offlineSmoke = false;
try {
  if (![4, 5].includes(process.argv.length) || (process.argv.length === 5 && process.argv[4] !== "--offline-smoke")) throw new Error("invalid invocation");
  offlineSmoke = process.argv[4] === "--offline-smoke";
  const config = await loadRealArticlePilotConfig(process.argv[2], { allowLive: true });
  if (config.mode !== "live") throw new Error("live mode is required");
  const preflight = await preflightRealArticlePilot(config, { allowLive: true });
  const sourceParagraphs = preflight.articleText.split(/\n\s*\n/u).map((item) => item.trim()).filter(Boolean);
  const profile = await privateJson(process.argv[3], 2 * 1024 * 1024, "knowledge profile");
  const tracePath = join(config.output.directory, `knowledge-assisted-translation${offlineSmoke ? "-offline" : ""}-trace.json`);
  const trace = { schemaVersion: "lectoria-knowledge-assisted-translation-trace-v1", state: "running",
    articleDigest: config.article.digest, requests: [], responses: [] };
  await atomicPrivate(tracePath, trace);
  stage = "translate";
  operations = await createLivePilotOperations(config, {
    runnerIdentity: { uid: process.getuid(), gid: process.getgid() }, knowledgeProfile: profile,
    ...(offlineSmoke ? { invokeTranslationProvider: async (request) => providerResponseContract({
      responseId: randomUUID(), providerId: request.providerId, modelId: request.modelId,
      candidates: request.segments.map((segment) => ({ segmentId: segment.segmentId, text: `离线冒烟：${segment.sourceText}` })),
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, totalTokens: 120 },
    }, request) } : {}),
    onTranslationRequest: async (request) => {
      const outbound = buildDeepSeekRequest(request);
      trace.requests.push({ providerRequest: request, outbound: { url: outbound.url, body: outbound.body } });
      await atomicPrivate(tracePath, trace);
    },
    onTranslationResponse: async (request, response) => {
      trace.responses.push({ segmentId: request.segments[0].segmentId, response });
      await atomicPrivate(tracePath, trace);
    },
  });
  const translation = await operations.translate({ sourceParagraphs, targetLanguage: config.article.targetLanguage });
  trace.state = "completed-draft";
  await atomicPrivate(tracePath, trace);
  stage = "artifact";
  const artifactPath = join(config.output.directory, `knowledge-assisted-translation${offlineSmoke ? "-offline" : ""}-artifact.json`);
  await atomicPrivate(artifactPath, { schemaVersion: "lectoria-knowledge-assisted-translation-artifact-v1",
    state: "draft", humanReviewed: false, approved: false, articleDigest: config.article.digest,
    sourceLanguage: config.article.sourceLanguage, targetLanguage: config.article.targetLanguage,
    profileLabel: profile.label, translation, diagnostics: operations.diagnostics(), tracePath });
  process.stdout.write(`${JSON.stringify({ status: "completed-draft", artifactPath, tracePath,
    calls: translation.usage.calls, validation: translation.validation, humanReviewed: false, approved: false })}\n`);
} catch (error) {
  const allowed = new Set(["auth", "budget", "canceled", "malformed-response", "policy", "provider", "rate-limit", "timeout", "unknown-outcome", "validation"]);
  process.stderr.write(`${JSON.stringify({ status: "failed", stage,
    category: allowed.has(error?.category) ? error.category : "knowledge-assisted-translation",
    ...(error?.providerCode === undefined ? {} : { providerCode: String(error.providerCode) }),
    ...(offlineSmoke ? { detail: error?.message ?? "unknown" } : {}) })}\n`);
  process.exitCode = 1;
} finally { await operations?.close(); }
