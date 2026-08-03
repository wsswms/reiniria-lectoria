import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { REAL_ARTICLES, batchLimits, pairedQaSummary, readPrivateArticle } from "../../scripts/m5c-real-article-batch.mjs";
import { RealArticleAuditSession } from "../../scripts/m5c-real-article-audit.mjs";
import { auditWriterForDescriptor } from "../../src/provider/llm-call-audit.mjs";

test("real article batch fixes two same-domain ja to zh-CN inputs and bounded paired QA", () => {
  assert.equal(REAL_ARTICLES.length, 2);
  assert.deepEqual(new Set(REAL_ARTICLES.map((item) => `${item.sourceLanguage}->${item.targetLanguage}`)), new Set(["ja->zh-CN"]));
  assert.deepEqual(batchLimits([{ segmentCount: 55 }, { segmentCount: 73 }]), { plannerCalls: 2, translationCalls: 128,
    qaCalls: 4, maximumDeepSeekCalls: 134, priorFailedPlannerCalls: 1, maximumCumulativeDeepSeekCalls: 135,
    maximumCostMicrosCny: 30_000_000, automaticRetries: 0,
    braveCalls: 0, fetchCalls: 0, researchModelCalls: 0 });
  assert.throws(() => batchLimits([{ segmentCount: 55 }, { segmentCount: 129 }]), /out of bounds/);
});

test("real article inputs require current-user private regular files", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-real-article-input-"));
  try {
    const path = join(root, "article.txt"); await writeFile(path, "公開テスト本文", { mode: 0o600 });
    const loaded = await readPrivateArticle(path); assert.equal(loaded.bytes, Buffer.byteLength("公開テスト本文")); assert.match(loaded.digest, /^sha256:[0-9a-f]{64}$/u);
    await chmod(path, 0o644); await assert.rejects(readPrivateArticle(path), /0600/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("paired QA summaries retain normalized findings and require an explicit thinking mode", () => {
  const run = { qaRunId: "run", targetRevisionId: "target", current: true,
    findings: [{ layer: "model", severity: "warning", code: "term-risk", segmentId: "segment", details: {}, blocking: false }] };
  const value = pairedQaSummary("enabled", run, { usage: { calls: 1, inputTokens: 10, outputTokens: 20, costMicrosCny: 30, costMicrosUsd: 0, durationMs: 40 } });
  assert.equal(value.mode, "enabled"); assert.equal(value.findings.length, 1);
  assert.throws(() => pairedQaSummary("automatic", run, { usage: {} }), /invalid QA thinking mode/);
});

test("real article audit session writes per-call 0600 JSONL and an incremental digest manifest on success and failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-real-audit-root-")); const output = join(root, "session");
  try {
    await writeFile(join(root, "sentinel"), "fixture"); await mkdir(output, { mode: 0o700 });
    const session = await RealArticleAuditSession.create(output);
    const value = await session.invoke("planner-part1", { articleId: "part1", role: "planner" }, async (fd) => {
      const writer = auditWriterForDescriptor(fd); writer({ event: "request", request: { body: { prompt: "full" }, bodyBytes: 17 } });
      writer({ event: "response", response: { rawBody: "{}", bodyBytes: 2, finishReason: "stop", usage: { total_tokens: 3 } }, elapsedMs: 4,
        outcome: { normalized: true } }); return "ok";
    });
    assert.equal(value, "ok");
    await assert.rejects(session.invoke("qa-enabled-part1", { articleId: "part1", role: "qa" }, async (fd) => {
      auditWriterForDescriptor(fd)({ event: "request", request: { body: { prompt: "full" }, bodyBytes: 17 } });
      throw Object.assign(new Error("fixture failure"), { category: "unknown-outcome" });
    }), /fixture failure/);
    const summary = await session.summary(); assert.equal(summary.calls, 2); assert.equal(summary.entries[0].status, "completed");
    assert.equal(summary.entries[1].status, "failed"); assert.match(summary.manifestDigest, /^sha256:[0-9a-f]{64}$/u);
    const manifest = JSON.parse(await readFile(join(output, "llm-audit-manifest.json"), "utf8")); assert.equal(manifest.entries.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
