import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openWorkspaceDatabase } from "../../src/db/connection.mjs";
import { providerResponseContract } from "../../src/provider/contracts.mjs";
import { DEEPSEEK_API_ORIGIN, DEEPSEEK_PROVIDER_ID } from "../../src/provider/deepseek-provider.mjs";
import { runRealProviderExercise } from "../../src/provider/real-provider-exercise.mjs";
import { REAL_RUN_CONFIG_VERSION } from "../../src/provider/real-run-preflight.mjs";
import { realProviderCorpus } from "../fixtures/m4-5/real-provider-corpus.mjs";

const corpusUrl = new URL("../fixtures/m4-5/real-provider-corpus.mjs", import.meta.url);

test("twelve real-structure documents complete the machine-candidate to reviewed export chain offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-real-exercise-"));
  const workspaceId = randomUUID();
  for (const path of ["private/objects", "private/ledger", "derived", "staging"]) await mkdir(join(root, path), { recursive: true });
  const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId });
  let responseSequence = 0;
  try {
    const summary = await runRealProviderExercise({
      database,
      root,
      workspaceId,
      corpus: realProviderCorpus,
      corpusSourceBytes: await readFile(corpusUrl),
      runnerIdentity: { uid: 65532, gid: 65532 },
      config: {
        schemaVersion: REAL_RUN_CONFIG_VERSION,
        mode: "live",
        providerId: DEEPSEEK_PROVIDER_ID,
        modelId: "deepseek-v4-flash",
        credentialPath: "/run/secrets/deepseek.key",
        allowedOrigin: DEEPSEEK_API_ORIGIN,
        corpus: { digest: "cd19e0583f3a8f12f133a333e10ead6b05fa83e5db876e9fd0ad559688bf5f43", documents: 12, approved: true },
        dataPolicy: { reference: "deepseek-public-fixture-policy-2026-08-01", accepted: true },
        limits: { maxCalls: 50, maxOutputTokens: 512, hardLimitMicros: 10_000, currency: "USD" },
        pricing: {
          version: "deepseek-v4-flash-2026-07-31",
          source: "https://api-docs.deepseek.com/quick_start/pricing",
          inputMicrosPerMillion: 140_000,
          outputMicrosPerMillion: 280_000,
          cachedInputMicrosPerMillion: 2_800,
        },
      },
      invokeProvider: async (request) => {
        responseSequence += 1;
        const outputTokens = Math.min(32, request.maxOutputTokens);
        return providerResponseContract({
          responseId: `offline-deepseek-${responseSequence}`,
          providerId: request.providerId,
          modelId: request.modelId,
          candidates: request.segments.map((segment) => ({
            segmentId: segment.segmentId,
            text: segment.sourceText.includes("public manual")
              ? `${segment.sourceText}\n\nInjected paragraph.`
              : segment.sourceText,
          })),
          usage: { inputTokens: 100, outputTokens, cachedInputTokens: 0, totalTokens: 100 + outputTokens },
        }, request);
      },
      now: () => new Date(0),
    });
    assert.equal(summary.documents, 12);
    assert.equal(summary.calls, 37);
    assert.equal(summary.machineCandidates, 37);
    assert.ok(summary.validationCorrections > 0);
    assert.equal(summary.validationReruns, 1);
    assert.equal(summary.validations, 12);
    assert.equal(summary.humanReviews, 12);
    assert.equal(summary.approvals, 12);
    assert.equal(summary.ordinaryExports, 12);
    assert.equal(summary.canonicalExports, 12);
    assert.equal(summary.usage.records, 37);
    assert.ok(summary.usage.amountMicros > 0 && summary.usage.amountMicros < summary.hardLimitMicros);
    assert.equal(database.pragma("foreign_key_check").length, 0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
