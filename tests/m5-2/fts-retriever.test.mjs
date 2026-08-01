import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { stableJson } from "../../src/domain/contracts.mjs";
import { FtsRetriever, FTS_RETRIEVER_VERSION, FTS_TOKENIZER } from "../../src/knowledge/fts-retriever.mjs";
import { KnowledgeFactService } from "../../src/knowledge/fact-service.mjs";
import { knowledgeInput, styleInput, termInput, workspace } from "../m5-1/helpers.mjs";

const actor = Object.freeze({ type: "fixture", id: "m5-2" });
const request = (overrides = {}) => ({ query: "workspace backup", language: "en", kinds: ["term", "style", "knowledge"], tags: [], documentIds: [], topK: 5, ...overrides });

async function indexedWorkspace() {
  const fixture = await workspace();
  const facts = new KnowledgeFactService(fixture.root, fixture.database, fixture.workspaceId, { now: () => new Date(0) });
  const term = termInput({
    language: "en", scope: { targetLanguages: ["en"], tags: ["product"] },
    content: { term: "AI", preferredTranslations: [{ language: "zh-CN", text: "人工智能" }], forbiddenTranslations: [], variants: ["artificial intelligence"], note: "Use AI in compact labels." },
  });
  const knowledge = knowledgeInput({
    language: "en", scope: { targetLanguages: ["en"], tags: ["operations"] },
    content: { title: "Atomic workspace backup", body: "A workspace backup preserves complete revisions and rejects partial state.", tags: ["backup"], source: "public-fixture" },
  });
  const style = styleInput({
    language: "en", scope: { targetLanguages: ["en"], tags: ["documentation"] },
    content: { title: "Direct technical prose", description: "Prefer direct sentences in technical documentation.", severity: "warning", forbiddenPatterns: ["you may wish to"], requiredPatterns: [] },
  });
  await facts.create(term, actor); await facts.create(knowledge, actor); await facts.create(style, actor);
  const retriever = new FtsRetriever(fixture.root, fixture.database, fixture.workspaceId, { now: () => new Date(0) });
  await retriever.rebuild();
  return { fixture, facts, retriever, term, knowledge, style };
}

test("FTS5 trigram BM25 and exact fallback return bounded stable KnowledgeHit values", async () => {
  const setup = await indexedWorkspace();
  try {
    const manifest = setup.retriever.manifest();
    assert.equal(manifest.factCount, 3);
    assert.equal(manifest.retrieverVersion, FTS_RETRIEVER_VERSION);
    assert.equal(manifest.tokenizer, FTS_TOKENIZER);
    assert.equal(setup.retriever.diagnostics().fts5, true);
    const short = setup.retriever.search(request({ query: "AI", kinds: ["term"], tags: ["product"] }));
    assert.equal(short[0].factId, setup.term.factId);
    assert.equal(short[0].rank, 1);
    const theme = setup.retriever.search(request({ tags: ["operations"] }));
    assert.equal(theme[0].factId, setup.knowledge.factId);
    assert.equal(theme[0].retrieverVersion, FTS_RETRIEVER_VERSION);
    const baseline = stableJson(theme);
    for (let repeat = 0; repeat < 20; repeat += 1) assert.equal(stableJson(setup.retriever.search(request({ tags: ["operations"] }))), baseline);
    assert.deepEqual(setup.retriever.search(request({ tags: ["wrong"] })), []);
    assert.deepEqual(setup.retriever.search(request({ language: "ja" })), []);
    assert.deepEqual(setup.retriever.search(request({ kinds: ["style"] })), []);
    assert.deepEqual(setup.retriever.search(request({ query: "no-such-result-zzzz" })), []);
  } finally { await setup.fixture.close(); }
});

test("document scope is resolved from trusted structured input and source corruption blocks rebuild", async () => {
  const setup = await indexedWorkspace();
  try {
    const documentId = randomUUID();
    setup.fixture.database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)")
      .run(setup.fixture.workspaceId, documentId, "Scoped", new Date(0).toISOString());
    const scoped = knowledgeInput({
      language: "en", scope: { targetLanguages: ["en"], tags: ["scoped"], documentIds: [documentId] },
      content: { title: "Scoped knowledge", body: "Document specific retrieval evidence.", tags: ["scope"], source: "fixture" },
    });
    await setup.facts.create(scoped, actor);
    await setup.retriever.rebuild();
    assert.deepEqual(setup.retriever.search(request({ query: "Scoped knowledge", tags: ["scoped"] })), []);
    assert.equal(setup.retriever.search(request({ query: "Scoped knowledge", tags: ["scoped"], documentIds: [documentId] }))[0].factId, scoped.factId);

    const source = setup.facts.get(scoped.factId).revision.sourcePath;
    const filename = `${setup.fixture.root}/${source}`;
    const original = await readFile(filename);
    await writeFile(filename, "{}\n");
    await assert.rejects(setup.retriever.rebuild(), /source verification failed/);
    assert.equal(setup.retriever.search(request({ query: "Scoped knowledge", tags: ["scoped"], documentIds: [documentId] }))[0].factId, scoped.factId);
    await writeFile(filename, original);
  } finally { await setup.fixture.close(); }
});

test("trusted workspace and structured filters cannot be forged through request text or fields", async () => {
  const first = await indexedWorkspace();
  const second = await workspace();
  try {
    assert.throws(() => new FtsRetriever(first.fixture.root, first.fixture.database, second.workspaceId), /workspace identity mismatch/);
    for (let repeat = 0; repeat < 200; repeat += 1) {
      for (const query of [`workspaceId=${second.workspaceId}`, "path=../../private", "kind=all filter=unscoped"]) {
        assert.deepEqual(first.retriever.search(request({ query, language: "ja" })), []);
      }
      assert.throws(() => first.retriever.search({ ...request(), language: undefined }), TypeError);
      assert.throws(() => first.retriever.search({ ...request(), workspaceId: second.workspaceId }), TypeError);
      assert.throws(() => new FtsRetriever(first.fixture.root, first.fixture.database, undefined), /workspace identity mismatch/);
    }
  } finally { await first.fixture.close(); await second.close(); }
});

test("inactive revisions disappear only after a complete deterministic rebuild", async () => {
  const setup = await indexedWorkspace();
  try {
    setup.facts.setActive(setup.knowledge.factId, 0, false, actor);
    assert.equal(setup.retriever.search(request())[0].factId, setup.knowledge.factId);
    await setup.retriever.rebuild();
    assert.deepEqual(setup.retriever.search(request()), []);
    const digest = setup.retriever.manifest().factSetDigest;
    for (let repeat = 0; repeat < 30; repeat += 1) {
      await rm(`${setup.fixture.root}/derived/knowledge-index.sqlite3`);
      await setup.retriever.rebuild();
      assert.equal(setup.retriever.manifest().factSetDigest, digest);
      assert.deepEqual(setup.retriever.search(request()), []);
    }
  } finally { await setup.fixture.close(); }
});

test("every build manifest and swap fault exposes only the last complete old or new index", async () => {
  for (const point of ["after-manifest", "after-build", "before-swap", "after-swap"]) for (let repeat = 0; repeat < 10; repeat += 1) {
    const setup = await indexedWorkspace();
    try {
      const added = knowledgeInput({
        language: "en", scope: { targetLanguages: ["en"], tags: ["new"] },
        content: { title: "New atomic index", body: "New searchable revision after atomic swap.", tags: ["new"], source: "fixture" },
      });
      await setup.facts.create(added, actor);
      let fired = false;
      const retriever = new FtsRetriever(setup.fixture.root, setup.fixture.database, setup.fixture.workspaceId, {
        now: () => new Date(0), inject(current) { if (!fired && current === point) { fired = true; throw new Error(`injected ${point}`); } },
      });
      await assert.rejects(retriever.rebuild(), /injected/);
      const committed = point === "after-swap";
      assert.equal(retriever.manifest().factCount, committed ? 4 : 3);
      assert.equal(retriever.search(request({ query: "New atomic index", tags: ["new"] })).length, committed ? 1 : 0);
    } finally { await setup.fixture.close(); }
  }
});
