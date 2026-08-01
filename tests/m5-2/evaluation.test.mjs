import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { FtsRetriever } from "../../src/knowledge/fts-retriever.mjs";
import { KnowledgeFactService } from "../../src/knowledge/fact-service.mjs";
import { evaluateRetrieval } from "../../src/knowledge/retrieval-evaluation.mjs";
import { retrievalDigest, retrievalFacts, retrievalManifest, retrievalQueries } from "../fixtures/m5-2/retrieval-corpus.mjs";
import { workspace } from "../m5-1/helpers.mjs";

test("fixed public corpus and annotated query manifest meet all M5.2 minimum counts", async () => {
  assert.equal(retrievalManifest.factCount, 300);
  assert.equal(retrievalManifest.queryCount, 126);
  for (const language of ["en", "ja", "zh-CN"]) {
    assert.ok(retrievalManifest.languages[language].facts >= 80);
    assert.ok(retrievalManifest.languages[language].queries >= 30);
  }
  for (const category of ["exact", "short", "topic", "typo", "synonym", "proper", "no-result"]) assert.ok(retrievalManifest.categories[category] >= 12);
  assert.equal(retrievalDigest, "sha256:e6e7d6cc46e6e60231f2cc0e442010b45aa6a5d266f44df82a00bbd4ad1e8944");
  const artifact = JSON.parse(await readFile(new URL("../fixtures/m5-2/manifest.json", import.meta.url), "utf8"));
  assert.equal(artifact.digest, retrievalDigest);
  assert.equal(artifact.factCount, retrievalManifest.factCount);
  assert.equal(artifact.queryCount, retrievalManifest.queryCount);
  for (const query of retrievalQueries) {
    assert.equal(typeof query.reason, "string");
    assert.equal(Array.isArray(query.relevant), true);
    assert.equal(Array.isArray(query.forbidden), true);
  }
});

test("fixed multilingual retrieval set exceeds relevance isolation and no-result thresholds", async () => {
  const fixture = await workspace();
  try {
    const facts = new KnowledgeFactService(fixture.root, fixture.database, fixture.workspaceId, { now: () => new Date(0) });
    for (const source of retrievalFacts) await facts.create(source, { type: "fixture", id: "m5-2-corpus" });
    const retriever = new FtsRetriever(fixture.root, fixture.database, fixture.workspaceId, { now: () => new Date(0) });
    await retriever.rebuild();
    const evaluation = evaluateRetrieval(retriever, retrievalQueries);
    assert.equal(evaluation.exactRecallAt1, 1);
    assert.equal(evaluation.shortRecallAt5, 1);
    assert.ok(evaluation.macroRecallAt5 >= 0.95, JSON.stringify(evaluation));
    assert.ok(evaluation.mrrAt10 >= 0.85, JSON.stringify(evaluation));
    assert.ok(evaluation.ndcgAt10 >= 0.85, JSON.stringify(evaluation));
    for (const recall of Object.values(evaluation.byLanguageRecallAt5)) assert.ok(recall >= 0.9, JSON.stringify(evaluation));
    assert.ok(evaluation.hardNegativeTop5Rate <= 0.05, JSON.stringify(evaluation));
    assert.equal(evaluation.noResultFailures, 0, JSON.stringify(evaluation));
  } finally { await fixture.close(); }
});
