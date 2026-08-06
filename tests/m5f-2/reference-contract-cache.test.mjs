import assert from "node:assert/strict";
import test from "node:test";
import { dictionaryLookupRequestContract, entityLookupRequestContract } from "../../src/tools/contracts.mjs";
import { createReferenceResult, verifyReferenceResult } from "../../src/tools/reference-result.mjs";
import { TranslationReferenceCacheService } from "../../src/tools/translation-reference-cache-service.mjs";
import { TranslationToolConfigurationService } from "../../src/tools/translation-tool-configuration-service.mjs";
import { researchWorkspace } from "../m5r-2/helpers.mjs";

const dictionaryRequest = (term = "penultimate") => ({ schemaVersion: "dictionary-lookup-request-v1", term,
  sourceLanguage: "en", targetLanguage: "zh-CN", context: `The ${term} chapter explains the design.`,
  partOfSpeech: "adjective", requestedFields: ["definition", "context-meaning", "translation"] });
const entityRequest = () => ({ schemaVersion: "entity-lookup-request-v1", term: "Artemis",
  sourceLanguage: "en", targetLanguage: "zh-CN", context: "NASA's Artemis campaign returns humans to the Moon.",
  entityType: "program", requestedFacts: ["canonical-name", "target-language-name", "identity"], timeHint: null });

function configuration(maxCalls = 2) {
  return { schemaVersion: "translation-tool-configuration-v1",
    dictionary: { providerId: "deepseek-flash", providerVersion: "flash-v1", maxCalls,
      maxCostMicrosUsd: 20_000, allowedDomains: ["dictionary.cambridge.org"] },
    entity: { providerId: "brave-web", providerVersion: "brave-v1", maxCalls,
      maxCostMicrosUsd: 40_000, allowedDomains: ["nasa.gov"] }, number: null };
}

const result = ({ kind = "dictionary", term = "penultimate", providerId = "deepseek-flash", providerVersion = "flash-v1",
  url = "https://dictionary.cambridge.org/dictionary/english/penultimate" } = {}) => createReferenceResult({
  schemaVersion: "reference-lookup-result-v1", toolKind: kind, status: "resolved", term,
  canonicalName: term, targetCandidates: kind === "dictionary" ? ["倒数第二的"] : ["阿耳忒弥斯计划"],
  details: kind === "dictionary" ? { partOfSpeech: "adjective", meaning: "next to the last" }
    : { entityType: "program", identity: "NASA lunar exploration campaign" },
  sources: [{ url, title: "Authoritative reference", quote: "next to the last",
    sourceClass: kind === "dictionary" ? "dictionary" : "official", retrievedAt: new Date(0).toISOString() }],
  providerId, providerVersion, usage: { searchCalls: 1, contentUrls: 1, modelTokens: 50, costMicrosUsd: 10 },
  permissions: { mayModifyTranslation: false, mayApproveKnowledge: false },
});

test("dictionary and entity requests are narrow and reject provider or arbitrary URL injection", () => {
  assert.equal(dictionaryLookupRequestContract(dictionaryRequest()).term, "penultimate");
  assert.equal(entityLookupRequestContract(entityRequest()).entityType, "program");
  assert.throws(() => dictionaryLookupRequestContract({ ...dictionaryRequest(), providerId: "brave-web" }), TypeError);
  assert.throws(() => entityLookupRequestContract({ ...entityRequest(), url: "https://evil.example" }), TypeError);
  assert.throws(() => dictionaryLookupRequestContract({ ...dictionaryRequest(), requestedFields: ["definition", "definition"] }), TypeError);
});

test("reference result requires evidence for resolved status and has immutable permissions and digest", () => {
  const value = result();
  assert.equal(verifyReferenceResult(value).targetCandidates[0], "倒数第二的");
  assert.throws(() => verifyReferenceResult({ ...value, canonicalName: "tampered" }), /digest/);
  assert.throws(() => createReferenceResult({ ...value, sources: [], resultDigest: undefined }), /requires evidence/);
  assert.throws(() => createReferenceResult({ ...value,
    permissions: { mayModifyTranslation: true, mayApproveKnowledge: false }, resultDigest: undefined }), TypeError);
});

test("reference cache enforces task provider domain idempotency and call limit", async () => {
  const value = await researchWorkspace();
  try {
    const database = value.setup.fixture.database; const workspaceId = value.setup.fixture.workspaceId;
    const taskId = value.bound.task.task.task_id;
    new TranslationToolConfigurationService(database, workspaceId).bind(taskId, configuration(2));
    const cache = new TranslationReferenceCacheService(database, workspaceId);
    const first = result();
    assert.deepEqual(cache.persist(taskId, "dictionary", dictionaryRequest(), first), first);
    assert.deepEqual(cache.get(taskId, "dictionary", dictionaryRequest()), first);
    assert.deepEqual(cache.persist(taskId, "dictionary", dictionaryRequest(), first), first);
    assert.throws(() => cache.persist(taskId, "dictionary", dictionaryRequest("antepenultimate"),
      result({ term: "antepenultimate", url: "https://evil.example/entry" })), /outside configured domains/);
    cache.persist(taskId, "dictionary", dictionaryRequest("ultimate"), result({ term: "ultimate",
      url: "https://dictionary.cambridge.org/dictionary/english/ultimate" }));
    assert.throws(() => cache.persist(taskId, "dictionary", dictionaryRequest("final"), result({ term: "final",
      url: "https://dictionary.cambridge.org/dictionary/english/final" })), /limit exceeded/);
    assert.throws(() => database.prepare("UPDATE translation_reference_cache_entries SET created_at = created_at").run(), /immutable/);
    assert.throws(() => database.prepare("DELETE FROM translation_reference_cache_entries").run(), /immutable/);
  } finally { await value.close(); }
});

test("reference cache rejects a result from a provider not selected by the user", async () => {
  const value = await researchWorkspace();
  try {
    const database = value.setup.fixture.database; const workspaceId = value.setup.fixture.workspaceId;
    const taskId = value.bound.task.task.task_id;
    new TranslationToolConfigurationService(database, workspaceId).bind(taskId, configuration());
    assert.throws(() => new TranslationReferenceCacheService(database, workspaceId).persist(taskId, "entity", entityRequest(),
      result({ kind: "entity", term: "Artemis", providerId: "deepseek-flash", url: "https://nasa.gov/artemis" })), /binding mismatch/);
  } finally { await value.close(); }
});
