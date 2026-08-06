import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ProviderConfigurationConflictError, ProviderConfigurationService } from "../../src/provider/configuration-service.mjs";

test("provider configuration stores credentials privately and returns only redacted profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-provider-config-"));
  try {
    const service = new ProviderConfigurationService(root, { id: () => "fixed-id" });
    const first = await service.createSource({ sourceId: "deepseek-official", displayName: "DeepSeek 官方", adapterId: "deepseek", modelId: "deepseek-v4-flash", credential: "secret-value" });
    assert.equal(first.revision, 1); assert.equal(first.sources[0].credentialConfigured, true);
    assert.equal(Object.hasOwn(first.sources[0], "credentialRef"), false);
    const file = join(root, "secrets", "providers", "deepseek-official.key");
    assert.equal((await readFile(file, "utf8")).trim(), "secret-value"); assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(() => service.createSource({ sourceId: "bad", displayName: "bad", adapterId: "unknown", modelId: "x", credential: "x" }), /adapter is not registered/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("provider presets enforce model capabilities and compare-and-swap revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-provider-config-"));
  try {
    const service = new ProviderConfigurationService(root);
    let state = await service.createSource({ sourceId: "gemini-local", displayName: "Gemini", adapterId: "google-gemini", modelId: "gemini-fixture-flash", credential: "secret" });
    await assert.rejects(() => service.setPreset({ presetId: "search", stage: "web-search", sourceId: "gemini-local", toolNames: ["web-search"] }, state.revision), ProviderConfigurationConflictError);
    state = await service.createSource({ sourceId: "deepseek-volc", displayName: "DeepSeek 第二来源", adapterId: "deepseek", modelId: "deepseek-v4-flash", credential: "secret-2" }, state.revision);
    state = await service.setPreset({ presetId: "translation-default", stage: "translation", sourceId: "deepseek-volc", thinking: true, temperature: 0.3, toolNames: ["number"] }, state.revision);
    assert.equal(state.presets[0].modelId, "deepseek-v4-flash"); assert.match(state.presets[0].configDigest, /^sha256:/);
    const resolved = await service.resolvePreset({ stage: "translation", presetId: "translation-default" });
    assert.equal(resolved.sourceId, "deepseek-volc"); assert.equal(resolved.thinking, true);
    await assert.rejects(() => service.setPreset({ presetId: "x", stage: "translation", sourceId: "deepseek-volc" }, state.revision - 1), ProviderConfigurationConflictError);
  } finally { await rm(root, { recursive: true, force: true }); }
});
