import assert from "node:assert/strict";
import test from "node:test";
import { BraveReferenceProvider, BRAVE_REFERENCE_PROVIDER_VERSION, buildBraveReferenceQuery } from "../../src/tools/brave-reference-provider.mjs";
import { DeepSeekFlashReferenceProvider, DEEPSEEK_FLASH_REFERENCE_PROVIDER_VERSION,
  buildFlashReferenceQuestion } from "../../src/tools/deepseek-flash-reference-provider.mjs";
import { TranslationReferenceTool } from "../../src/tools/translation-reference-tool.mjs";
import { TranslationToolConfigurationService } from "../../src/tools/translation-tool-configuration-service.mjs";
import { researchWorkspace } from "../m5r-2/helpers.mjs";

const dictionaryRequest = { schemaVersion: "dictionary-lookup-request-v1", term: "penultimate", sourceLanguage: "en",
  targetLanguage: "zh-CN", context: "Read the penultimate paragraph.", partOfSpeech: "adjective",
  requestedFields: ["definition", "translation"] };
const entityRequest = { schemaVersion: "entity-lookup-request-v1", term: "Artemis", sourceLanguage: "en",
  targetLanguage: "zh-CN", context: "NASA's Artemis campaign returns humans to the Moon.", entityType: "program",
  requestedFacts: ["canonical-name", "identity"], timeHint: null };

test("Flash reference provider builds a narrow no-full-context-translation question and maps verified research", async () => {
  const domains = ["dictionary.cambridge.org"];
  const question = buildFlashReferenceQuestion("dictionary", dictionaryRequest, domains);
  assert.match(question, /不要翻译局部语境全文/);
  assert.match(question, /dictionary\.cambridge\.org/);
  let received;
  const provider = new DeepSeekFlashReferenceProvider({ now: () => new Date(0), price: () => 7,
    invokeResearch: async (input) => { received = input; return {
      outcome: "resolved", answer: JSON.stringify({ status: "resolved", canonicalName: "penultimate",
        targetCandidates: ["倒数第二的"], details: { definition: "next to the last", partOfSpeech: "adjective" } }),
      explanation: "语境匹配形容词义项",
      sources: [{ finalUrl: "https://dictionary.cambridge.org/dictionary/english/penultimate", title: "penultimate",
        quote: "next to the last", sourceClass: "dictionary" }],
      actions: [{ type: "search" }, { type: "open_page" }], usage: { totalTokens: 123 } } } });
  const result = await provider.lookup("dictionary", dictionaryRequest, { providerId: "deepseek-flash",
    providerVersion: DEEPSEEK_FLASH_REFERENCE_PROVIDER_VERSION, allowedDomains: domains });
  assert.equal(received.researchCase.responseLanguage, "zh-CN");
  assert.equal(result.status, "resolved");
  assert.equal(result.usage.searchCalls, 1);
  assert.equal(result.usage.costMicrosUsd, 7);
  assert.equal(result.permissions.mayModifyTranslation, false);
});

test("Brave reference provider filters search domains fetches body and never resolves from snippets", async () => {
  const domains = ["nasa.gov"];
  assert.match(buildBraveReferenceQuery("entity", entityRequest, domains), /site:nasa\.gov/);
  const fetched = [];
  const provider = new BraveReferenceProvider({ now: () => new Date(0),
    search: async () => ({ results: [
      { url: "https://evil.example/artemis", title: "bad" },
      { url: "https://www.nasa.gov/artemis/", title: "Artemis" },
    ], usage: { searchCalls: 1, costMicrosUsd: 5 } }),
    restrictedFetch: { fetchSelected: async ({ url }) => { fetched.push(url); return { finalUrl: url,
      title: "NASA Artemis", extractedText: "NASA's Artemis campaign explores the Moon and prepares for Mars." }; } },
    normalizeEvidence: async ({ evidence }) => ({ status: "resolved", canonicalName: "Artemis campaign",
      targetCandidates: ["阿耳忒弥斯计划"], details: { identity: "NASA lunar exploration campaign", evidenceCount: evidence.length } }) });
  const result = await provider.lookup("entity", entityRequest, { providerId: "brave-web",
    providerVersion: BRAVE_REFERENCE_PROVIDER_VERSION, allowedDomains: domains });
  assert.deepEqual(fetched, ["https://www.nasa.gov/artemis/"]);
  assert.equal(result.status, "resolved");
  assert.equal(result.sources.length, 1);
  assert.equal(result.usage.costMicrosUsd, 5);
});

test("translation reference tool selects only the provider fixed by the task and caches replay", async () => {
  const value = await researchWorkspace();
  try {
    const database = value.setup.fixture.database; const workspaceId = value.setup.fixture.workspaceId;
    const taskId = value.bound.task.task.task_id; let calls = 0;
    new TranslationToolConfigurationService(database, workspaceId).bind(taskId, {
      schemaVersion: "translation-tool-configuration-v1",
      dictionary: { providerId: "deepseek-flash", providerVersion: DEEPSEEK_FLASH_REFERENCE_PROVIDER_VERSION,
        maxCalls: 2, maxCostMicrosUsd: 100, allowedDomains: ["dictionary.cambridge.org"] }, entity: null, number: null });
    const adapter = new DeepSeekFlashReferenceProvider({ now: () => new Date(0), invokeResearch: async () => { calls += 1; return {
      outcome: "resolved", answer: JSON.stringify({ status: "resolved", canonicalName: "penultimate",
        targetCandidates: ["倒数第二的"], details: { definition: "next to the last" } }), explanation: "direct dictionary evidence",
      sources: [{ finalUrl: "https://dictionary.cambridge.org/dictionary/english/penultimate", title: "entry",
        quote: "next to the last", sourceClass: "dictionary" }], actions: [{ type: "search" }], usage: { totalTokens: 10 } }; } });
    const tool = new TranslationReferenceTool(database, workspaceId, { adapters: new Map([["deepseek-flash", adapter]]) });
    assert.equal((await tool.lookupDictionary(taskId, dictionaryRequest)).cached, false);
    assert.equal((await tool.lookupDictionary(taskId, dictionaryRequest)).cached, true);
    assert.equal(calls, 1);
    await assert.rejects(() => tool.lookupEntity(taskId, entityRequest), /disabled/);
  } finally { await value.close(); }
});
