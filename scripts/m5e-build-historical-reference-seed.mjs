import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { buildHistoricalReferenceSeed } from "../src/m5e/historical-reference-seed.mjs";

const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const articles = ["nikon-omoshiro-part1", "nikon-omoshiro-part2"];

async function privateDirectory(path, { create = false } = {}) {
  if (typeof path !== "string" || path.length === 0) throw new Error("private directory path is required");
  if (create) await mkdir(path, { recursive: false, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("directory must be current-user 0700");
  return path;
}

async function privateFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("audit file must be current-user 0600");
  return readFile(path);
}

function responseEvent(bytes) {
  const events = bytes.toString("utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const response = [...events].reverse().find((item) => item.event === "response");
  if (!response || response.outcome?.normalized !== true || response.response?.finishReason !== "stop" || typeof response.response?.content !== "string") {
    throw new Error("historical LLM response is not a completed normalized stop response");
  }
  return JSON.parse(response.response.content);
}

const auditRoot = await privateDirectory(process.env.M5E_HISTORICAL_AUDIT_DIR);
const outputRoot = await privateDirectory(process.env.M5E_REFERENCE_OUTPUT_DIR, { create: true });
const manifestBytes = await privateFile(join(auditRoot, "llm-audit-manifest.json")); const manifest = JSON.parse(manifestBytes);
if (manifest.schemaVersion !== "m5c-real-article-llm-audit-manifest-v1" || !Array.isArray(manifest.entries)) throw new Error("historical audit manifest is invalid");
const collected = new Map(articles.map((articleId) => [articleId, { articleId, planner: null, translationAttempts: [], qaFindings: [] }]));
for (const entry of manifest.entries) {
  if (!collected.has(entry.articleId) || !["planner", "translation", "retranslation", "qa"].includes(entry.role)) continue;
  if (entry.status !== "completed" || entry.normalized !== true || entry.finishReason !== "stop" || basename(entry.filename) !== entry.filename) throw new Error("historical audit entry is incomplete");
  const bytes = await privateFile(join(auditRoot, "llm-calls", entry.filename)); if (sha(bytes) !== entry.fileDigest) throw new Error("historical audit digest mismatch");
  const payload = responseEvent(bytes); const target = collected.get(entry.articleId);
  if (entry.role === "planner") {
    if (target.planner) throw new Error("historical article has multiple Planner results");
    target.planner = { planRevisionId: `historical:${entry.articleId}:${entry.sequence}`,
      items: payload.items.map((item, index) => ({ ...item, itemId: `raw-${String(index).padStart(4, "0")}` })) };
  } else if (["translation", "retranslation"].includes(entry.role)) {
    for (const candidate of payload.candidates) target.translationAttempts.push({ attemptId: `historical:${entry.sequence}:${candidate.segmentId}`,
      segmentId: candidate.segmentId, needs: candidate.knowledgeNeeds });
  } else target.qaFindings.push(...payload.findings);
}
for (const articleId of articles) {
  const summary = JSON.parse(await privateFile(join(auditRoot, `${articleId}-knowledge-loop.json`)));
  const target = collected.get(articleId); target.sourceDigest = summary.source.digest;
  if (!target.planner || target.qaFindings.length < 1 || !Array.isArray(summary.qa?.findings) || summary.qa.findings.length < target.qaFindings.length) {
    throw new Error("historical article reference inputs are incomplete");
  }
  target.qaFindings = summary.qa.findings;
}
const seed = buildHistoricalReferenceSeed([...collected.values()]);
await writeFile(join(outputRoot, "historical-reference-seed.json"), `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
await chmod(join(outputRoot, "historical-reference-seed.json"), 0o600);
const summary = { schemaVersion: "m5e-historical-reference-seed-summary-v1", status: seed.status, sourceSetDigest: seed.sourceSetDigest,
  seedDigest: seed.seedDigest, mappingDigest: seed.mappingDigest, counts: seed.counts, historicalAuditManifestDigest: sha(manifestBytes) };
await writeFile(join(outputRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 }); await chmod(join(outputRoot, "summary.json"), 0o600);
process.stdout.write(`${JSON.stringify(summary)}\n`);
