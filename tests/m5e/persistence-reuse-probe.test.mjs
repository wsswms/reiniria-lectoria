import assert from "node:assert/strict";
import test from "node:test";
import { KnowledgeFactService } from "../../src/knowledge/fact-service.mjs";
import { FtsRetriever } from "../../src/knowledge/fts-retriever.mjs";
import { probeAppliedKnowledgeReuse } from "../../src/m5e/persistence-reuse-probe.mjs";
import { termInput, workspace } from "../m5-1/helpers.mjs";

const actor = Object.freeze({ type: "fixture", id: "m5e-reuse-probe" });

test("Part2 reuse bindings require an exact active Part1 fact revision and digest returned by FTS", async () => {
  const fixture = await workspace();
  try {
    const facts = new KnowledgeFactService(fixture.root, fixture.database, fixture.workspaceId, { now: () => new Date(0) });
    const source = termInput({ language: "zh-CN", scope: { targetLanguages: ["zh-CN"], tags: ["nikon"] }, content: {
      term: "ぎょぎょっと20", preferredTranslations: [{ language: "zh-CN", text: "趣味鱼眼20" }],
      forbiddenTranslations: [], variants: ["Gyogyotto 20"], note: "Approved Part1 product-name knowledge.",
    } });
    await facts.create(source, actor); const retriever = new FtsRetriever(fixture.root, fixture.database, fixture.workspaceId, { now: () => new Date(0) });
    const manifest = await retriever.rebuild(); const clusters = [{ clusterId: "cluster-product", kind: "term",
      representativeQuestion: "How should the product name be translated?", semantic: { surface: "ぎょぎょっと20" } }];
    const application = { clusterId: "cluster-product", proposalId: "proposal-1", factId: source.factId,
      revisionId: source.revisionId, contentDigest: facts.get(source.factId).revision.contentDigest, applied: true,
      retrievalQuery: "ぎょぎょっと20", factKind: "term" };
    const result = probeAppliedKnowledgeReuse({ clusters, applications: [application], retriever,
      expectedFactSetDigest: manifest.factSetDigest, language: "zh-CN", targetLanguage: "zh-CN", tags: ["nikon"], documentIds: [] });
    assert.equal(result.bindings.length, 1); assert.equal(result.misses.length, 0);
    assert.deepEqual(result.bindings[0], { clusterId: "cluster-product", factId: source.factId, revisionId: source.revisionId,
      contentDigest: application.contentDigest, retrieverVersion: result.bindings[0].retrieverVersion, exact: true });

    const forged = probeAppliedKnowledgeReuse({ clusters, applications: [{ ...application, revisionId: "forged-revision" }], retriever,
      expectedFactSetDigest: manifest.factSetDigest, language: "zh-CN", targetLanguage: "zh-CN", tags: ["nikon"], documentIds: [] });
    assert.equal(forged.bindings.length, 0); assert.equal(forged.misses[0].reason, "lineage-mismatch");
  } finally { await fixture.close(); }
});

test("reuse probe rejects stale or wrong knowledge snapshots before searching", () => {
  const retriever = { manifest: () => ({ factSetDigest: `sha256:${"a".repeat(64)}` }), search: () => { throw new Error("must not search"); } };
  assert.throws(() => probeAppliedKnowledgeReuse({ clusters: [], applications: [], retriever,
    expectedFactSetDigest: `sha256:${"b".repeat(64)}`, language: "ja", targetLanguage: "zh-CN", tags: [], documentIds: [] }), /snapshot mismatch/);
});
