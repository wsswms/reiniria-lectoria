import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { invokeM5CModelBroker } from "../src/m5c/model-broker-process.mjs";
import { compareP1LiteModes, summarizeP1LiteResult } from "../src/m5e/p1-lite.mjs";
import { M5EP1LiteAuditSession } from "./m5e-p1-lite-audit.mjs";

const MODEL_ID = "deepseek-v4-flash";
const MAX_OUTPUT_TOKENS = 65_536;
const MAX_NEW_ACTUAL_ATTEMPTS = 4;
const MAX_COST_MICROS_CNY = 5_000_000;
const PRIOR_DIAGNOSTIC = Object.freeze({ actualAttempts: 2, inputTokens: 94_006, outputTokens: 59_289,
  reasoningTokens: 0, totalTokens: 153_295, costMicrosCny: 595_236, durationMs: 292_618,
  auditManifestDigest: "sha256:2ebb5aad832caee5eff985ec4b2de4479f79ccef457fe41c32bf4e47f244b45e" });
const FIXED = Object.freeze({
  "nikon-omoshiro-part1": Object.freeze({ env: "M5E_P1LITE_INPUT_ONE", localItems: 239,
    requestDigest: "sha256:f08ec7290eb4266a563385b31667e7fcea38989c517c93746b21590147a8936a" }),
  "nikon-omoshiro-part2": Object.freeze({ env: "M5E_P1LITE_INPUT_TWO", localItems: 226,
    requestDigest: "sha256:3d35fb21871658ba1ee94eeb0a38c99e0b61ef804ef76c73213178fc9020f54d" }),
});
const ORDER = Object.freeze([
  Object.freeze({ articleId: "nikon-omoshiro-part1", thinking: "disabled" }),
  Object.freeze({ articleId: "nikon-omoshiro-part1", thinking: "enabled" }),
  Object.freeze({ articleId: "nikon-omoshiro-part2", thinking: "enabled" }),
  Object.freeze({ articleId: "nikon-omoshiro-part2", thinking: "disabled" }),
]);
const sha = (value) => `sha256:${createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex")}`;

async function privateFile(path, maximum = 512 * 1024) {
  if (typeof path !== "string" || path.length < 1) throw new Error("P1-Lite input path is required"); const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > maximum) {
    throw new Error("P1-Lite input must be a current-user 0600 regular file within size bounds");
  }
  return readFile(path, "utf8");
}
async function outputDirectory(path) {
  if (typeof path !== "string" || path.length < 1) throw new Error("M5E_P1LITE_OUTPUT_DIR is required");
  await mkdir(path, { recursive: false, mode: 0o700 }); const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("P1-Lite output directory is invalid");
  return path;
}
async function save(root, name, value) {
  const path = join(root, name); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await chmod(path, 0o600); return sha(await readFile(path));
}
async function requestFromAudit(path, expected) {
  const lines = (await privateFile(path)).trim().split("\n").map((line) => JSON.parse(line));
  const events = lines.filter((event) => event?.event === "request");
  if (events.length !== 1 || !Array.isArray(events[0]?.request?.body?.messages) || events[0].request.body.messages.length !== 2) throw new Error("historical Planner audit input is invalid");
  const request = JSON.parse(events[0].request.body.messages[1].content);
  if (sha(request) !== expected.requestDigest || request?.schemaVersion !== "m5c-planner-request-v1"
    || request?.targetLanguage !== "zh-CN" || request?.localItems?.length !== expected.localItems) throw new Error("historical Planner request identity changed");
  return Object.freeze(request);
}
function add(target, usage) { for (const key of ["calls", "inputTokens", "outputTokens", "reasoningTokens", "totalTokens", "costMicrosCny", "durationMs"]) target[key] += usage[key]; }

if (process.env.M5E_P1LITE_THINKING_PILOT !== "execute") throw new Error("P1-Lite thinking pilot requires explicit execute gate");

let credential; let audit; let stage = "preflight"; const completed = [];
try {
  const outputRoot = await outputDirectory(process.env.M5E_P1LITE_OUTPUT_DIR); audit = await M5EP1LiteAuditSession.create(outputRoot);
  credential = await openCredentialFile(process.env.DEEPSEEK_KEY_FILE);
  const requests = Object.fromEntries(await Promise.all(Object.entries(FIXED).map(async ([articleId, expected]) =>
    [articleId, await requestFromAudit(process.env[expected.env], expected)])));
  const results = new Map(); const totals = { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, costMicrosCny: 0, durationMs: 0 };
  for (const item of ORDER) {
    stage = `${item.articleId}:${item.thinking}`; const request = requests[item.articleId];
    const result = await audit.invoke(`p1-lite-${item.articleId}-${item.thinking}`,
      { articleId: item.articleId, role: "planner-p1-lite", thinking: item.thinking, promptVersion: "m5e-p1-lite-v2" },
      (auditFd) => invokeM5CModelBroker({ credentialFd: credential.fd, auditFd,
        request: { plannerRequest: request, modelId: MODEL_ID, thinking: item.thinking, maxOutputTokens: MAX_OUTPUT_TOKENS, maximumAttempts: 1 } },
      { entry: new URL("./m5e-p1-lite-broker-entry.mjs", import.meta.url), timeoutMs: 900_000, outputBytes: 32 * 1024 * 1024 }));
    add(totals, result.usage);
    if (totals.calls > MAX_NEW_ACTUAL_ATTEMPTS || PRIOR_DIAGNOSTIC.actualAttempts + totals.calls > 8
      || PRIOR_DIAGNOSTIC.costMicrosCny + totals.costMicrosCny > MAX_COST_MICROS_CNY) throw Object.assign(new Error("P1-Lite hard budget exceeded"), { category: "budget" });
    const summary = summarizeP1LiteResult(result, request); const key = `${item.articleId}:${item.thinking}`; results.set(key, result);
    const artifact = Object.freeze({ schemaVersion: "m5e-p1-lite-result-v1", articleId: item.articleId, thinking: item.thinking,
      modelId: MODEL_ID, promptVersion: "m5e-p1-lite-v2", inputRequestDigest: FIXED[item.articleId].requestDigest,
      result, summary, usage: result.usage, approvalPerformed: false, researchPerformed: false });
    const artifactDigest = await save(outputRoot, `${item.articleId}-${item.thinking}.json`, artifact);
    completed.push(Object.freeze({ articleId: item.articleId, thinking: item.thinking, summary, usage: result.usage, artifactDigest }));
    process.stderr.write(`${JSON.stringify({ type: "progress", stage, outputItems: summary.outputItems, actualAttempts: result.usage.calls })}\n`);
  }
  stage = "comparison"; const comparisons = Object.fromEntries(Object.keys(FIXED).map((articleId) => [articleId,
    compareP1LiteModes(results.get(`${articleId}:disabled`), results.get(`${articleId}:enabled`))]));
  const comparisonArtifact = Object.freeze({ schemaVersion: "m5e-p1-lite-thinking-pilot-v1", status: "completed", order: ORDER,
    promptVersion: "m5e-p1-lite-v2", modelId: MODEL_ID, maximums: Object.freeze({ logicalCalls: 4, cumulativeActualAttempts: 8,
      costMicrosCny: MAX_COST_MICROS_CNY, braveCalls: 0, fetchUrls: 0, researchModelCalls: 0 }), completed: Object.freeze(completed),
    comparisons: Object.freeze(comparisons), priorDiagnostic: PRIOR_DIAGNOSTIC, totals: Object.freeze(totals),
    cumulativeTotals: Object.freeze({ actualAttempts: PRIOR_DIAGNOSTIC.actualAttempts + totals.calls,
      inputTokens: PRIOR_DIAGNOSTIC.inputTokens + totals.inputTokens, outputTokens: PRIOR_DIAGNOSTIC.outputTokens + totals.outputTokens,
      reasoningTokens: PRIOR_DIAGNOSTIC.reasoningTokens + totals.reasoningTokens, totalTokens: PRIOR_DIAGNOSTIC.totalTokens + totals.totalTokens,
      costMicrosCny: PRIOR_DIAGNOSTIC.costMicrosCny + totals.costMicrosCny, durationMs: PRIOR_DIAGNOSTIC.durationMs + totals.durationMs }), referenceFamiliesInjected: false,
    translationPerformed: false, researchPerformed: false, approvalPerformed: false });
  const comparisonDigest = await save(outputRoot, "p1-lite-thinking-comparison.json", comparisonArtifact);
  const auditSummary = await audit.summary();
  process.stdout.write(`${JSON.stringify({ status: "completed", logicalCalls: completed.length, actualAttempts: totals.calls,
    totals, cumulativeActualAttempts: PRIOR_DIAGNOSTIC.actualAttempts + totals.calls,
    cumulativeCostMicrosCny: PRIOR_DIAGNOSTIC.costMicrosCny + totals.costMicrosCny,
    comparisons: Object.fromEntries(Object.entries(comparisons).map(([key, value]) => [key,
      { intersection: value.intersection, union: value.union, jaccard: value.jaccard, disabledOnly: value.disabledOnly.length, enabledOnly: value.enabledOnly.length }])),
    comparisonDigest, auditManifestDigest: auditSummary.manifestDigest })}\n`);
} catch (error) {
  const auditSummary = await audit?.summary().catch(() => null); process.stderr.write(`${JSON.stringify({ status: "failed", stage,
    category: error?.category ?? "evaluation", completed, auditManifestDigest: auditSummary?.manifestDigest ?? null })}\n`); process.exitCode = 1;
} finally { await credential?.close(); }
