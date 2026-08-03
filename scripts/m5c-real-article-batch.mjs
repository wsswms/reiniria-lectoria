import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

export const REAL_ARTICLES = Object.freeze([
  Object.freeze({ id: "nikon-omoshiro-part1", env: "M5C_REAL_ARTICLE_ONE", sourceLanguage: "ja", targetLanguage: "zh-CN", domain: "camera-optics" }),
  Object.freeze({ id: "nikon-omoshiro-part2", env: "M5C_REAL_ARTICLE_TWO", sourceLanguage: "ja", targetLanguage: "zh-CN", domain: "camera-optics" }),
]);

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

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
    maximumCostMicrosCny: 1_000_000, automaticRetries: 0, braveCalls: 0, fetchCalls: 0, researchModelCalls: 0 });
}

export function pairedQaSummary(mode, run, settlement) {
  if (!new Set(["disabled", "enabled"]).has(mode)) throw new Error("invalid QA thinking mode");
  return Object.freeze({ mode, qaRunId: run.qaRunId, targetRevisionId: run.targetRevisionId, current: run.current,
    findings: Object.freeze(run.findings.map(({ layer, severity, code, segmentId, details, blocking }) =>
      Object.freeze({ layer, severity, code, segmentId, details, blocking }))), usage: Object.freeze({ ...settlement.usage }) });
}
