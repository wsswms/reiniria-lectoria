import assert from "node:assert/strict";
import test from "node:test";
import { buildKnowledgeNeedFunnel, candidateSetDigest } from "../../src/m5e/knowledge-need-cluster.mjs";

const need = (needId, overrides = {}) => ({
  needId, originType: "plan-item", originId: `origin-${needId}`, kind: "term", impact: "high",
  question: "How should ぎょぎょっと20 be translated?", relatedSegmentIds: [`segment-${needId}`],
  semantic: { surface: "ぎょぎょっと20", entityType: "product-name" }, ...overrides,
});

test("deterministic funnel separates raw occurrences, canonical candidates, clusters and actionable research", () => {
  const input = [
    need("a"),
    need("b", { question: "  How should ぎょぎょっと２０ be translated？ ", relatedSegmentIds: ["segment-b", "segment-a"] }),
    need("c", { question: "How should Gyogyotto 20 be translated?", semantic: { surface: "Gyogyotto 20", entityType: "product-name" } }),
    need("d", { kind: "measurement", impact: "critical", question: "Is this a three-element design?",
      semantic: { subject: "ぎょぎょっと20", value: "3", unit: "枚", dimension: "lens-elements" } }),
    need("e", { kind: "measurement", impact: "critical", question: "Is this a three-group design?",
      semantic: { subject: "ぎょぎょっと20", value: "3", unit: "群", dimension: "lens-groups" } }),
  ];
  const aliases = [{ kind: "term", alias: "Gyogyotto 20", canonical: "ぎょぎょっと20", approvedBy: { type: "user", id: "u1" } }];
  const first = buildKnowledgeNeedFunnel(input, { aliases });
  const second = buildKnowledgeNeedFunnel([...input].reverse(), { aliases });
  assert.deepEqual(first, second);
  assert.deepEqual(first.counts, { rawOccurrences: 5, canonicalCandidates: 4, clusters: 3, actionableResearch: 3 });
  const term = first.clusters.find((item) => item.kind === "term");
  assert.deepEqual(term.memberNeedIds, ["a", "b", "c"]);
  assert.deepEqual(term.relatedSegmentIds, ["segment-a", "segment-b", "segment-c"]);
  assert.equal(first.clusters.filter((item) => item.kind === "measurement").length, 2);
});

test("unstructured semantic lookalikes never fuzzy-merge and unapproved aliases are rejected", () => {
  const input = [
    need("a", { semantic: undefined, question: "400 mm telephoto" }),
    need("b", { semantic: undefined, question: "400mm super-telephoto" }),
  ];
  assert.equal(buildKnowledgeNeedFunnel(input).clusters.length, 2);
  assert.throws(() => buildKnowledgeNeedFunnel(input, { aliases: [
    { kind: "term", alias: "a", canonical: "b", approvedBy: { type: "model", id: "planner" } },
  ] }), /user-approved/);
});

test("only exact persisted bindings or user dispositions remove clusters from actionable research", () => {
  const base = buildKnowledgeNeedFunnel([
    need("a", { impact: "critical" }),
    need("b", { kind: "fact", question: "Who designed it?", semantic: { subject: "lens", predicate: "designer", object: "大下孝一" } }),
    need("c", { kind: "style", impact: "medium", question: "Should the nickname remain playful?", semantic: { rule: "preserve-playful-nickname" } }),
  ]);
  const [critical, fact, style] = base.clusters;
  const resolved = buildKnowledgeNeedFunnel([
    need("a", { impact: "critical" }),
    need("b", { kind: "fact", question: "Who designed it?", semantic: { subject: "lens", predicate: "designer", object: "大下孝一" } }),
    need("c", { kind: "style", impact: "medium", question: "Should the nickname remain playful?", semantic: { rule: "preserve-playful-nickname" } }),
  ], {
    knowledgeBindings: [{ clusterId: critical.clusterId, factId: "fact-1", revisionId: "revision-1",
      contentDigest: `sha256:${"a".repeat(64)}`, retrieverVersion: "fts-v1", exact: true }],
    dispositions: [{ clusterId: fact.clusterId, decision: "guidance", decidedBy: { type: "user", id: "u1" } }],
  });
  assert.equal(resolved.counts.actionableResearch, 0);
  assert.equal(resolved.clusters.find((item) => item.clusterId === critical.clusterId).resolution, "persisted-knowledge");
  assert.equal(resolved.clusters.find((item) => item.clusterId === fact.clusterId).resolution, "user-guidance");
  assert.equal(resolved.clusters.find((item) => item.clusterId === style.clusterId).resolution, "deferred-low-impact");
});

test("candidate set digest ignores run-specific need and segment identities but changes with semantic output", () => {
  const first = buildKnowledgeNeedFunnel([need("a")]);
  const second = buildKnowledgeNeedFunnel([need("run-2", { originId: "different", relatedSegmentIds: ["another-segment"] })]);
  assert.equal(candidateSetDigest(first), candidateSetDigest(second));
  const changed = buildKnowledgeNeedFunnel([need("run-3", { semantic: { surface: "どどっと400", entityType: "product-name" } })]);
  assert.notEqual(candidateSetDigest(first), candidateSetDigest(changed));
});
