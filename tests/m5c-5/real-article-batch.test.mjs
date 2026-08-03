import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { REAL_ARTICLES, batchLimits, pairedQaSummary, readPrivateArticle } from "../../scripts/m5c-real-article-batch.mjs";

test("real article batch fixes two same-domain ja to zh-CN inputs and bounded paired QA", () => {
  assert.equal(REAL_ARTICLES.length, 2);
  assert.deepEqual(new Set(REAL_ARTICLES.map((item) => `${item.sourceLanguage}->${item.targetLanguage}`)), new Set(["ja->zh-CN"]));
  assert.deepEqual(batchLimits([{ segmentCount: 55 }, { segmentCount: 73 }]), { plannerCalls: 2, translationCalls: 128,
    qaCalls: 4, maximumDeepSeekCalls: 134, maximumCostMicrosCny: 1_000_000, automaticRetries: 0,
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
