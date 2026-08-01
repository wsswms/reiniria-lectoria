import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  embeddingRequestContract,
  factSourceContract,
  knowledgeHitContract,
  rerankRequestContract,
  retrieverRequestContract,
} from "../../src/knowledge/contracts.mjs";
import { stableJson } from "../../src/domain/contracts.mjs";
import { knowledgeInput, styleInput, termInput } from "./helpers.mjs";

test("term style and knowledge contracts round-trip deterministically one hundred times each", () => {
  for (const factory of [termInput, styleInput, knowledgeInput]) {
    for (let index = 0; index < 100; index += 1) {
      const input = factory();
      const first = factSourceContract(input);
      const second = factSourceContract(JSON.parse(stableJson(first)));
      assert.equal(stableJson(first), stableJson(second));
      assert.equal(Object.isFrozen(first), true);
      assert.equal(Object.isFrozen(first.scope), true);
      assert.equal(Object.isFrozen(first.content), true);
    }
  }
});

test("fact contracts reject unknown versions kinds languages scopes and malformed content", () => {
  const invalid = [
    termInput({ schemaVersion: "2.0" }),
    termInput({ kind: "embedding" }),
    termInput({ language: "not_a_language" }),
    termInput({ scope: { workspaceId: randomUUID(), tags: [] } }),
    termInput({ content: { term: "x", preferredTranslations: [], forbiddenTranslations: [], variants: [] } }),
    styleInput({ content: { title: "x", description: "y", severity: "fatal", forbiddenPatterns: [], requiredPatterns: [] } }),
    knowledgeInput({ content: { title: "x", body: "", tags: [], source: "fixture" } }),
  ];
  for (const value of invalid) assert.throws(() => factSourceContract(value), TypeError);
});

test("retrieval embedding and rerank contracts define bounded shapes without registering implementations", () => {
  const request = retrieverRequestContract({ query: "workspace", language: "en", kinds: ["term", "knowledge"], tags: ["product"], topK: 5 });
  assert.deepEqual(request.kinds, ["knowledge", "term"]);
  const hit = knowledgeHitContract({
    factId: randomUUID(), revisionId: randomUUID(), kind: "term", language: "en",
    matchedField: "content.term", snippet: "workspace", contentDigest: `sha256:${"a".repeat(64)}`,
    retrieverVersion: "fts-v1", score: -1.25, rank: 1,
  });
  assert.equal(hit.rank, 1);
  assert.deepEqual(embeddingRequestContract({ texts: ["one", "two"], model: "future-model" }).texts, ["one", "two"]);
  assert.equal(rerankRequestContract({ query: "workspace", hits: [hit], topK: 1 }).hits.length, 1);
  for (const bad of [
    { query: "", language: "en", kinds: ["term"], topK: 1 },
    { query: "x", language: "en", kinds: ["term"], topK: 0 },
    { query: "x", language: "en", kinds: ["embedding"], topK: 1 },
  ]) assert.throws(() => retrieverRequestContract(bad), TypeError);
});
