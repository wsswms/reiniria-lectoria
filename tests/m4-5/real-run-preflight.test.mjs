import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEEPSEEK_API_ORIGIN, DEEPSEEK_PROVIDER_ID } from "../../src/provider/deepseek-provider.mjs";
import { GEMINI_API_ORIGIN, GEMINI_PROVIDER_ID } from "../../src/provider/gemini-provider.mjs";
import { OPENAI_API_ORIGIN, OPENAI_PROVIDER_ID } from "../../src/provider/openai-provider.mjs";
import { createRealRunDryPlan, REAL_RUN_CONFIG_VERSION, realRunConfigContract } from "../../src/provider/real-run-preflight.mjs";
import { realProviderCorpus } from "../fixtures/m4-5/real-provider-corpus.mjs";

const corpusUrl = new URL("../fixtures/m4-5/real-provider-corpus.mjs", import.meta.url);
const executeFile = promisify(execFile);
const config = () => ({
  schemaVersion: REAL_RUN_CONFIG_VERSION,
  mode: "dry-run",
  providerId: GEMINI_PROVIDER_ID,
  modelId: "gemini-approved-fixture",
  credentialPath: "/run/secrets/lectoria-gemini.key",
  allowedOrigin: GEMINI_API_ORIGIN,
  corpus: { digest: "cd19e0583f3a8f12f133a333e10ead6b05fa83e5db876e9fd0ad559688bf5f43", documents: 12, approved: true },
  dataPolicy: { reference: "fixture-policy-2026-08-01", accepted: true },
  limits: { maxCalls: 50, hardLimitMicros: 2_000_000, currency: "USD" },
  pricing: { version: "fixture-price", source: "fixture-source", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, cachedInputMicrosPerMillion: 500_000 },
});

test("real Provider dry-run fixes corpus, origin, call count, estimate and request digests without exposing content", async () => {
  const source = await readFile(corpusUrl);
  const plans = Array.from({ length: 20 }, () => createRealRunDryPlan(config(), realProviderCorpus, source));
  assert.equal(new Set(plans.map(JSON.stringify)).size, 1);
  const plan = plans[0];
  assert.equal(plan.calls, 12);
  assert.equal(plan.maxCalls, 50);
  assert.equal(plan.allowedOrigin, GEMINI_API_ORIGIN);
  assert.ok(plan.estimatedCostMicros > 0 && plan.estimatedCostMicros < plan.hardLimitMicros);
  assert.equal(plan.requests.length, 12);
  assert.equal(JSON.stringify(plan).includes(realProviderCorpus[0].content), false);
  assert.equal(new Set(plan.requests.map((item) => item.requestDigest)).size, 12);
});

test("real Provider dry-run accepts only fixed OpenAI, DeepSeek and Gemini Provider-origin pairs", async () => {
  const source = await readFile(corpusUrl);
  for (const [providerId, allowedOrigin, modelId] of [
    [GEMINI_PROVIDER_ID, GEMINI_API_ORIGIN, "gemini-approved-fixture"],
    [OPENAI_PROVIDER_ID, OPENAI_API_ORIGIN, "gpt-approved-fixture"],
    [DEEPSEEK_PROVIDER_ID, DEEPSEEK_API_ORIGIN, "deepseek-chat"],
  ]) {
    const plan = createRealRunDryPlan({ ...config(), providerId, allowedOrigin, modelId }, realProviderCorpus, source);
    assert.equal(plan.providerId, providerId);
    assert.equal(plan.allowedOrigin, allowedOrigin);
    assert.equal(plan.calls, 12);
  }
  assert.throws(() => realRunConfigContract({ ...config(), providerId: "openai-compatible", allowedOrigin: OPENAI_API_ORIGIN }), /Provider/);
  assert.throws(() => realRunConfigContract({ ...config(), providerId: OPENAI_PROVIDER_ID, allowedOrigin: DEEPSEEK_API_ORIGIN }), /allowlisted/);
});

test("real Provider config fails closed on live mode, unapproved data, domain drift and weak limits", () => {
  assert.throws(() => realRunConfigContract({ ...config(), mode: "live" }), /not authorized/);
  assert.equal(realRunConfigContract({ ...config(), mode: "live" }, { allowLive: true }).mode, "live");
  assert.throws(() => realRunConfigContract({ ...config(), corpus: { ...config().corpus, approved: false } }), /corpus/);
  assert.throws(() => realRunConfigContract({ ...config(), dataPolicy: { ...config().dataPolicy, accepted: false } }), /policy/);
  assert.throws(() => realRunConfigContract({ ...config(), allowedOrigin: "https://example.com" }), /allowlisted/);
  assert.throws(() => realRunConfigContract({ ...config(), limits: { ...config().limits, maxCalls: 11 } }), /limits/);
  assert.throws(() => realRunConfigContract({ ...config(), credentialPath: "relative.key" }), /absolute/);
});

test("real Provider dry-run rejects corpus drift and a hard limit below the deterministic estimate", async () => {
  const source = await readFile(corpusUrl);
  await assert.rejects(async () => createRealRunDryPlan({ ...config(), corpus: { ...config().corpus, digest: "0".repeat(64) } }, realProviderCorpus, source), /digest/);
  assert.throws(() => createRealRunDryPlan({ ...config(), limits: { ...config().limits, hardLimitMicros: 1 } }, realProviderCorpus, source), /estimated cost/);
});

test("real Provider preflight CLI validates a secure credential file and prints only a bounded dry plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-real-preflight-"));
  const credentialPath = join(root, "gemini.key");
  const configPath = join(root, "run.json");
  const secret = "M4-REAL-PREFLIGHT-SECRET";
  try {
    await writeFile(credentialPath, secret, { mode: 0o600 });
    await writeFile(configPath, JSON.stringify({ ...config(), credentialPath }), { mode: 0o600 });
    const { stdout, stderr } = await executeFile(process.execPath, [new URL("../../scripts/preflight-real-provider.mjs", import.meta.url).pathname, configPath], {
      env: { PATH: process.env.PATH, NODE_ENV: "production" },
    });
    const plan = JSON.parse(stdout);
    assert.equal(plan.mode, "dry-run");
    assert.equal(plan.calls, 12);
    assert.equal(stdout.includes(secret), false);
    assert.equal(stdout.includes(credentialPath), false);
    assert.equal(stderr, "");
  } finally { await rm(root, { recursive: true, force: true }); }
});
