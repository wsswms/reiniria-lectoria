import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { stableJson } from "../../src/domain/contracts.mjs";
import { buildReferenceAdjudicationProposal, confirmReferenceAdjudication } from "../../src/m5e/reference-adjudication.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
function seed() {
  const value = { schemaVersion: "m5e-historical-reference-seed-v1", status: "pending-human-adjudication", sourceSetDigest: sha("sources"), counts: {}, mappingDigest: sha("mapping"), families: [
    { familyId: "local", origin: "candidate", kind: "term", impact: "high", segmentIds: ["s1"], description: "resolve term translation uncertainty: lens" },
    { familyId: "medium", origin: "candidate", kind: "fact", impact: "medium", segmentIds: ["s2"], description: "A useful but non-high question?" },
    { familyId: "name-1", origin: "candidate", kind: "term", impact: "high", segmentIds: ["s3"], description: "「おもしろレンズ」应如何翻译?" },
    { familyId: "name-2", origin: "candidate", kind: "term", impact: "critical", segmentIds: ["s4"], description: "“おもしろレンズ”是否译为趣味镜头?" },
    { familyId: "qa", origin: "qa", kind: "relation", impact: "high", segmentIds: ["s5"], description: "negation-mismatch: {}" },
  ] };
  return Object.freeze({ ...value, seedDigest: sha(value) });
}

test("adjudication proposal removes detector noise and low scope, conservatively merges only one exact quoted subject", () => {
  const proposal = buildReferenceAdjudicationProposal(seed(), { createdAt: "2026-08-03T00:00:00Z" });
  assert.deepEqual(proposal.counts, { seedFamilies: 5, suggestedIncluded: 3, suggestedExcluded: 2, proposedFamilies: 2, proposedMerges: 1 });
  assert.equal(proposal.status, "pending-user-confirmation");
  assert.equal(proposal.proposedFamilies.find((item) => item.kind === "term").impact, "critical");
  assert.throws(() => confirmReferenceAdjudication(proposal, { confirmedAt: "2026-08-03T01:00:00Z", confirmedBy: { type: "model", id: "planner" } }), /only a user/);
  const frozen = confirmReferenceAdjudication(proposal, { confirmedAt: "2026-08-03T01:00:00Z", confirmedBy: { type: "user", id: "owner" } });
  assert.equal(frozen.families.length, 2); assert.match(frozen.familySetDigest, /^sha256:/);
  assert.equal(frozen.adjudicationMapping.length, 2); assert.match(frozen.adjudicationMappingDigest, /^sha256:/);
});

test("adjudication proposal fails closed on a modified seed", () => {
  assert.throws(() => buildReferenceAdjudicationProposal({ ...seed(), families: [] }, { createdAt: "2026-08-03T00:00:00Z" }), /integrity/);
});
