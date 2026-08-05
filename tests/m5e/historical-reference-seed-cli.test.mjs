import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const sourceDigest = (character) => `sha256:${character.repeat(64)}`;

test("historical reference CLI verifies private audit digests and writes only private external artifacts", async () => {
  const parent = await mkdtemp(join(tmpdir(), "lectoria-m5e-seed-cli-")); await chmod(parent, 0o700);
  const audit = join(parent, "audit"); const calls = join(audit, "llm-calls"); const output = join(parent, "output");
  await mkdir(audit, { mode: 0o700 }); await mkdir(calls, { mode: 0o700 }); const entries = []; let sequence = 0;
  const add = async (articleId, role, payload) => {
    sequence += 1; const filename = `${String(sequence).padStart(4, "0")}-${role}-${articleId}.jsonl`;
    const event = { event: "response", response: { finishReason: "stop", content: JSON.stringify(payload) }, outcome: { normalized: true } };
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`); await writeFile(join(calls, filename), bytes, { mode: 0o600 });
    entries.push({ sequence, filename, articleId, role, status: "completed", normalized: true, finishReason: "stop", fileDigest: sha(bytes) });
  };
  try {
    for (const [index, articleId] of ["nikon-omoshiro-part1", "nikon-omoshiro-part2"].entries()) {
      const segmentId = `segment-${index}`;
      await add(articleId, "planner", { items: [{ kind: "term", coverage: "uncovered", instructionType: "warning-only", impact: "high",
        segmentIds: [segmentId], dependencies: {}, content: { value: "Nikon" } }], researchScope: {}, qaProfile: {} });
      await add(articleId, "translation", { candidates: [{ segmentId, text: "译文", knowledgeNeeds: [{ kind: "fact", impact: "critical",
        question: "Was it released in 1995?", relatedSegmentIds: [segmentId] }] }] });
      await add(articleId, "qa", { findings: [{ severity: "warning", code: "terminology-error", segmentId, details: {} }] });
      const summary = { source: { digest: sourceDigest(String(index + 1)), bytes: 1, segmentCount: 1 }, qa: { findings: [
        { severity: "warning", code: "terminology-error", segmentId, details: {} },
        { severity: "error", code: "untranslated-text", segmentId, details: { reason: "fixture" } }] } };
      await writeFile(join(audit, `${articleId}-knowledge-loop.json`), `${JSON.stringify(summary)}\n`, { mode: 0o600 });
    }
    const manifest = { schemaVersion: "m5c-real-article-llm-audit-manifest-v1", entries };
    await writeFile(join(audit, "llm-audit-manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    const script = new URL("../../scripts/m5e-build-historical-reference-seed.mjs", import.meta.url).pathname;
    const result = await execute(process.execPath, [script], { env: { ...process.env, M5E_HISTORICAL_AUDIT_DIR: audit, M5E_REFERENCE_OUTPUT_DIR: output } });
    const summary = JSON.parse(result.stdout); assert.equal(summary.counts.rawOccurrences, 4); assert.equal(summary.counts.qaFindings, 4);
    const stat = await import("node:fs/promises").then(({ lstat }) => lstat(output)); assert.equal(stat.mode & 0o077, 0);
    assert.equal(JSON.parse(await readFile(join(output, "historical-reference-seed.json"), "utf8")).status, "pending-human-adjudication");
  } finally { await rm(parent, { recursive: true, force: true }); }
});
