import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createQaEvaluationReport, finalizeProductRevision } from "../src/m5c/finalization.mjs";

export const REAL_ARTICLES = Object.freeze([
  Object.freeze({ id: "nikon-omoshiro-part1", env: "M5C_REAL_ARTICLE_ONE", sourceLanguage: "ja", targetLanguage: "zh-CN", domain: "camera-optics" }),
  Object.freeze({ id: "nikon-omoshiro-part2", env: "M5C_REAL_ARTICLE_TWO", sourceLanguage: "ja", targetLanguage: "zh-CN", domain: "camera-optics" }),
]);

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export async function readPrivateArticle(path) {
  if (typeof path !== "string" || path.length === 0) throw new Error("real article path is required");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > 512 * 1024) {
    throw new Error("real article file must be a current-user 0600 regular file within size bounds");
  }
  const content = await readFile(path, "utf8");
  if (content.includes("\u0000")) throw new Error("real article contains a NUL byte");
  return Object.freeze({ content, bytes: Buffer.byteLength(content), digest: sha(content) });
}

export function batchLimits(documents) {
  if (!Array.isArray(documents) || documents.length !== REAL_ARTICLES.length) throw new Error("exactly two real articles are required");
  const translationCalls = documents.reduce((sum, item) => {
    if (!Number.isSafeInteger(item.segmentCount) || item.segmentCount < 1 || item.segmentCount > 128) throw new Error("real article segment count is out of bounds");
    return sum + item.segmentCount;
  }, 0);
  return Object.freeze({ plannerCalls: 2, translationCalls, qaCalls: 4, maximumDeepSeekCalls: translationCalls + 6,
    priorFailedPlannerCalls: 1, maximumCumulativeDeepSeekCalls: translationCalls + 7,
    maximumCostMicrosCny: 30_000_000, automaticRetries: 0, braveCalls: 0, fetchCalls: 0, researchModelCalls: 0 });
}

export function pairedQaSummary(mode, run, settlement) {
  if (!new Set(["disabled", "enabled"]).has(mode)) throw new Error("invalid QA thinking mode");
  return Object.freeze({ mode, qaRunId: run.qaRunId, targetRevisionId: run.targetRevisionId, current: run.current,
    findings: Object.freeze(run.findings.map(({ layer, severity, code, segmentId, details, blocking }) =>
      Object.freeze({ layer, severity, code, segmentId, details, blocking }))), usage: Object.freeze({ ...settlement.usage }) });
}

const auditedUsage = (entry) => Object.freeze({ calls: 1, inputTokens: entry.usage.prompt_tokens, outputTokens: entry.usage.completion_tokens,
  costMicrosCny: Math.ceil((entry.usage.prompt_tokens * 28 + entry.usage.completion_tokens * 56) / 10), costMicrosUsd: 0,
  durationMs: Number.isSafeInteger(entry.elapsedMs) ? entry.elapsedMs : 0 });
const addUsage = (target, value) => { for (const key of Object.keys(target)) target[key] += value[key]; return target; };

export function replayAuditedArticleFinalization(checkpoint, manifest, enabledPayload) {
  if (checkpoint?.schemaVersion !== "m5c-real-article-result-v1" || !Array.isArray(checkpoint.qa) || checkpoint.qa.length !== 1
    || checkpoint.qa[0].mode !== "disabled" || !checkpoint.validation || typeof checkpoint.targetWorkingCopyDigest !== "string")
    throw new Error("audited article checkpoint is invalid");
  if (manifest?.schemaVersion !== "m5c-real-article-llm-audit-manifest-v1" || !Array.isArray(manifest.entries)
    || manifest.entries.some((entry) => entry.status !== "completed" || entry.normalized !== true || entry.articleId !== checkpoint.id))
    throw new Error("audited article manifest is incomplete");
  const enabledEntry = manifest.entries.find((entry) => entry.role === "qa" && entry.thinking === "enabled");
  if (!enabledEntry || !Array.isArray(enabledPayload?.findings)) throw new Error("enabled QA audit result is missing");
  const disabled = checkpoint.qa[0]; const enabled = Object.freeze({ mode: "enabled", qaRunId: `audit-replay:${enabledEntry.outputDigest}`,
    workflowId: `audit-replay:${checkpoint.id}`, targetRevisionId: disabled.targetRevisionId, status: "completed", current: true,
    model: Object.freeze({ thinking: "enabled", auditOutputDigest: enabledEntry.outputDigest }), findings: Object.freeze(enabledPayload.findings),
    usage: auditedUsage(enabledEntry) });
  const totals = manifest.entries.reduce((sum, entry) => addUsage(sum, auditedUsage(entry)),
    { calls: 0, inputTokens: 0, outputTokens: 0, costMicrosCny: 0, costMicrosUsd: 0, durationMs: 0 });
  const productFinalization = finalizeProductRevision({ workflowId: enabled.workflowId, qaRun: enabled,
    workingCopyDigest: checkpoint.targetWorkingCopyDigest, validation: checkpoint.validation, flowBudgetUsage: totals, qaUsage: enabled.usage });
  const evaluationReport = createQaEvaluationReport([{ ...disabled, usage: disabled.usage }, enabled]);
  return Object.freeze({ schemaVersion: "m5c-real-article-audit-replay-v1", status: productFinalization.status, articleId: checkpoint.id,
    providerCalls: 0, selectedQaMode: "enabled", productFinalization, evaluationReport });
}

export function validatePart2ContinuationManifest(content, expectedDigest) {
  if (typeof content !== "string" || !SHA256.test(expectedDigest ?? "") || sha(content) !== expectedDigest) throw new Error("continuation manifest digest mismatch");
  let manifest; try { manifest = JSON.parse(content); } catch { throw new Error("continuation manifest is invalid"); }
  if (manifest?.schemaVersion !== "m5c-real-article-llm-audit-manifest-v1" || !Array.isArray(manifest.entries) || manifest.entries.length !== 57) {
    throw new Error("continuation manifest call count is invalid");
  }
  for (const [index, entry] of manifest.entries.entries()) {
    if (entry?.sequence !== index + 1 || entry.articleId !== "nikon-omoshiro-part1" || entry.status !== "completed" || entry.eventCount !== 2
      || entry.normalized !== true || !SHA256.test(entry.inputDigest ?? "") || !SHA256.test(entry.outputDigest ?? "") || !SHA256.test(entry.fileDigest ?? "")) {
      throw new Error("continuation manifest contains an incomplete call");
    }
  }
  const roles = Object.fromEntries(["planner", "translation", "qa"].map((role) => [role, manifest.entries.filter((entry) => entry.role === role)]));
  if (roles.planner.length !== 1 || roles.translation.length !== 54 || roles.qa.length !== 2
    || roles.planner[0].thinking !== "disabled" || roles.translation.some((entry) => entry.thinking !== "disabled")
    || new Set(roles.qa.map((entry) => entry.thinking)).size !== 2
    || !roles.qa.some((entry) => entry.thinking === "disabled") || !roles.qa.some((entry) => entry.thinking === "enabled")) {
    throw new Error("continuation manifest role matrix is invalid");
  }
  return Object.freeze({ digest: expectedDigest, calls: 57, plannerCalls: 1, translationCalls: 54, qaCalls: 2 });
}
