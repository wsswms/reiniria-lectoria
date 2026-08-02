import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadRealArticlePilotConfig, preflightRealArticlePilot } from "../src/pilot/preflight.mjs";
import { createLivePilotOperations } from "../src/pilot/live-operations.mjs";
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

function comparisonProfiles(value) {
  if (!value || value.schemaVersion !== "lectoria-knowledge-translation-comparison-v1"
    || Object.keys(value).sort().join(",") !== "dictionary,researched,schemaVersion") throw new Error("comparison profile is invalid");
  return value;
}

function baselineTranslation(value, config, sourceParagraphs) {
  if (!value || value.schemaVersion !== "lectoria-real-article-pilot-artifact-v1"
    || value.source?.digest !== config.article.digest || value.targetLanguage !== config.article.targetLanguage
    || !Array.isArray(value.translation?.segments) || value.translation.segments.length !== sourceParagraphs.length
    || value.translation.segments.some((segment, index) => segment.sourceText !== sourceParagraphs[index])) {
    throw new Error("baseline artifact does not match the comparison article");
  }
  return value.translation;
}

let operations;
let stage = "preflight";
try {
  if (![5, 6].includes(process.argv.length) || (process.argv.length === 6 && process.argv[5] !== "--offline-smoke")) throw new Error("invalid invocation");
  const offlineSmoke = process.argv[5] === "--offline-smoke";
  const config = await loadRealArticlePilotConfig(process.argv[2], { allowLive: true });
  if (config.mode !== "live") throw new Error("live mode is required");
  const preflight = await preflightRealArticlePilot(config, { allowLive: true });
  const sourceParagraphs = preflight.articleText.split(/\n\s*\n/u).map((item) => item.trim()).filter(Boolean);
  const baseline = baselineTranslation(await privateJson(process.argv[3], 8 * 1024 * 1024, "baseline"), config, sourceParagraphs);
  const profiles = comparisonProfiles(await privateJson(process.argv[4], 1024 * 1024, "comparison profile"));
  const variants = { A: { label: "existing-baseline", translation: baseline, diagnostics: { reused: true }, requests: [] } };
  const checkpointPath = join(config.output.directory, "knowledge-translation-comparison-checkpoint.json");
  if (!offlineSmoke) await atomicPrivate(checkpointPath, { schemaVersion: "lectoria-knowledge-translation-comparison-checkpoint-v1",
    articleDigest: config.article.digest, completedVariants: ["A"], variants });
  for (const [name, profile] of [["B", profiles.dictionary], ["C", profiles.researched]]) {
    stage = `translate-${name}`;
    const requests = [];
    operations = await createLivePilotOperations(config, { runnerIdentity: { uid: process.getuid(), gid: process.getgid() },
      knowledgeProfile: profile, onTranslationRequest: async (request) => requests.push(request),
      ...(offlineSmoke ? { invokeTranslationProvider: async (request) => providerResponseContract({ responseId: randomUUID(),
        providerId: request.providerId, modelId: request.modelId,
        candidates: request.segments.map((segment) => ({ segmentId: segment.segmentId, text: `离线冒烟：${segment.sourceText}` })),
        usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, totalTokens: 120 } }, request) } : {}) });
    const translation = await operations.translate({ sourceParagraphs, targetLanguage: config.article.targetLanguage });
    variants[name] = { label: profile.label, translation, diagnostics: operations.diagnostics(), requests };
    await operations.close(); operations = undefined;
    if (!offlineSmoke) await atomicPrivate(checkpointPath, { schemaVersion: "lectoria-knowledge-translation-comparison-checkpoint-v1",
      articleDigest: config.article.digest, completedVariants: Object.keys(variants), variants });
  }
  if (offlineSmoke) {
    process.stdout.write(`${JSON.stringify({ status: "offline-smoke-passed", calls: { B: variants.B.translation.usage.calls,
      C: variants.C.translation.usage.calls }, diagnostics: { B: variants.B.diagnostics, C: variants.C.diagnostics } })}\n`);
    process.exitCode = 0;
  } else {
  stage = "artifact";
  const artifactPath = join(config.output.directory, "knowledge-translation-comparison-artifact.json");
  await atomicPrivate(artifactPath, { schemaVersion: "lectoria-knowledge-translation-comparison-artifact-v1",
    state: "draft", humanReviewed: false, approved: false, articleDigest: config.article.digest,
    sourceLanguage: config.article.sourceLanguage, targetLanguage: config.article.targetLanguage, variants });
  process.stdout.write(`${JSON.stringify({ status: "completed-draft", artifactPath,
    calls: { A: baseline.usage.calls, B: variants.B.translation.usage.calls, C: variants.C.translation.usage.calls },
    validation: { A: baseline.validation, B: variants.B.translation.validation, C: variants.C.translation.validation },
    humanReviewed: false, approved: false })}\n`);
  }
} catch (error) {
  const allowed = new Set(["auth", "budget", "canceled", "malformed-response", "policy", "provider", "rate-limit", "timeout", "unknown-outcome", "validation"]);
  process.stderr.write(`${JSON.stringify({ status: "failed", stage, category: allowed.has(error?.category) ? error.category : "comparison" })}\n`);
  process.exitCode = 1;
} finally { await operations?.close(); }
