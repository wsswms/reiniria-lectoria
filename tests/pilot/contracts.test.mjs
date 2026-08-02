import assert from "node:assert/strict";
import test from "node:test";
import { realArticlePilotConfigContract } from "../../src/pilot/contracts.mjs";

const config = () => ({
  schemaVersion: "lectoria-real-article-pilot-v1",
  mode: "dry-run",
  article: { path: "/input/article.txt", digest: `sha256:${"a".repeat(64)}`, format: "text", sourceLanguage: "ja", targetLanguage: "zh-CN", title: "Article" },
  deepseek: {
    modelId: "deepseek-v4-flash", credentialPath: "/run/secrets/deepseek.key", origin: "https://api.deepseek.com",
    pricing: { version: "deepseek-v4-flash-pilot", inputMicrosPerMillion: 70_000, outputMicrosPerMillion: 280_000, cachedInputMicrosPerMillion: 14_000 },
    translation: { maxCalls: 20, maxOutputTokens: 1_024, hardLimitMicros: 100_000 },
    research: { maxCalls: 10, maxOutputTokens: 384_000, hardLimitMicros: 200_000, thinkingMode: "enabled" },
  },
  brave: { credentialPath: "/run/secrets/brave.key", maxCalls: 100, costMicrosPerCall: 5_000, hardLimitMicros: 500_000,
    country: "JP", searchLanguage: "ja", maxResultsPerSearch: 5 },
  fetch: { maxUrls: 50, timeoutMs: 10_000, maxConcurrency: 2, maxBodyBytes: 1_048_576 },
  research: { questions: ["What is the official mount specification?"], allowedDomains: [] },
  output: { directory: "/output" },
  totalHardLimitMicros: 1_000_000,
});

test("real article pilot config fixes the approved V2 hard boundaries", () => {
  const value = realArticlePilotConfigContract(config());
  assert.equal(value.mode, "dry-run");
  assert.equal(value.brave.maxCalls, 100);
  assert.equal(value.fetch.maxUrls, 50);
  assert.equal(value.deepseek.translation.maxCalls, 20);
  assert.equal(value.deepseek.research.maxCalls, 10);
  assert.equal(value.deepseek.research.maxOutputTokens, 384_000);
  assert.equal(value.deepseek.research.thinkingMode, "enabled");
});

test("live mode, origin drift, excess budgets, unknown keys and non-absolute paths fail closed", () => {
  assert.throws(() => realArticlePilotConfigContract({ ...config(), mode: "live" }), /live mode/);
  assert.equal(realArticlePilotConfigContract({ ...config(), mode: "live" }, { allowLive: true }).mode, "live");
  assert.throws(() => realArticlePilotConfigContract({ ...config(), deepseek: { ...config().deepseek, origin: "https://example.com" } }), /origin/);
  assert.throws(() => realArticlePilotConfigContract({ ...config(), brave: { ...config().brave, maxCalls: 101 } }), /brave.maxCalls/);
  assert.throws(() => realArticlePilotConfigContract({ ...config(), fetch: { ...config().fetch, maxUrls: 51 } }), /fetch.maxUrls/);
  assert.throws(() => realArticlePilotConfigContract({ ...config(), deepseek: { ...config().deepseek,
    research: { ...config().deepseek.research, maxOutputTokens: 384_001 } } }), /maxOutputTokens/);
  assert.throws(() => realArticlePilotConfigContract({ ...config(), extra: true }), /unknown/);
  assert.throws(() => realArticlePilotConfigContract({ ...config(), article: { ...config().article, path: "article.txt" } }), /absolute/);
});

test("long-form translation permits up to 128 calls while failing closed above the safety ceiling", () => {
  const longForm = { ...config(), deepseek: { ...config().deepseek,
    translation: { ...config().deepseek.translation, maxCalls: 128 } } };
  assert.equal(realArticlePilotConfigContract(longForm).deepseek.translation.maxCalls, 128);
  assert.throws(() => realArticlePilotConfigContract({ ...longForm, deepseek: { ...longForm.deepseek,
    translation: { ...longForm.deepseek.translation, maxCalls: 129 } } }), /deepseek.translation.maxCalls/);
});
