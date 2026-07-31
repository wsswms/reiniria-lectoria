import assert from "node:assert/strict";
import test from "node:test";
import { evaluateQueries, FtsSpikeIndex } from "../../src/m1-3/fts.mjs";
import { documents, mirroredWorkspaceDocuments, queries } from "../fixtures/m1-3/corpus.mjs";

test("fixed corpus has 20 documents and 12 queries per language", () => {
  for (const language of ["zh", "ja", "en"]) {
    assert.equal(documents.filter((document) => document.language === language).length, 20);
    assert.equal(queries.filter((query) => query.language === language).length, 12);
  }
  assert.equal(documents.length, 60);
  assert.equal(queries.length, 36);
  assert.equal(queries.filter((query) => query.kind === "exact").length, 12);
});

test("SQLite FTS5 reaches exact and thematic recall thresholds without workspace leakage", () => {
  const index = new FtsSpikeIndex();
  try {
    index.replaceFacts([...documents, ...mirroredWorkspaceDocuments]);
    const info = index.sqliteInfo();
    assert.equal(info.fts5, true);
    assert.equal(info.tokenizer, "trigram");
    const evaluation = evaluateQueries(index, queries);
    assert.equal(evaluation.exactFirstRate, 1);
    assert.ok(evaluation.macroRecallAt5 >= 0.8);
    for (const recall of Object.values(evaluation.byLanguage)) assert.ok(recall >= 0.8);
    assert.equal(evaluation.wrongWorkspace, 0);
  } finally {
    index.close();
  }
});

test("workspace scope is mandatory and cannot be supplied through query text", () => {
  const index = new FtsSpikeIndex();
  try {
    index.replaceFacts([...documents, ...mirroredWorkspaceDocuments]);
    assert.throws(() => index.search({ language: "en", query: "Nikon F3HP" }), /workspaceId is required/);
    const hits = index.search({ workspaceId: "workspace-a", language: "en", query: "workspace-b Nikon F3HP" });
    assert.ok(hits.length > 0);
    assert.ok(hits.every((hit) => hit.workspaceId === "workspace-a"));
  } finally {
    index.close();
  }
});

test("delete and rebuild from facts preserves every ordered query result", () => {
  const index = new FtsSpikeIndex();
  try {
    index.replaceFacts([...documents, ...mirroredWorkspaceDocuments]);
    const before = queries.map((query) => index.search(query).map((hit) => hit.id));
    index.rebuild();
    const after = queries.map((query) => index.search(query).map((hit) => hit.id));
    assert.deepEqual(after, before);
  } finally {
    index.close();
  }
});
