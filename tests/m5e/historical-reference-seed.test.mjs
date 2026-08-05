import assert from "node:assert/strict";
import test from "node:test";
import { buildHistoricalReferenceSeed } from "../../src/m5e/historical-reference-seed.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;

test("historical Planner, translation needs and QA findings form an auditable seed, not an auto-approved gold set", () => {
  const seed = buildHistoricalReferenceSeed([{ articleId: "part1", sourceDigest: digest("1"), planner: { planRevisionId: "plan-1", items: [{
    itemId: "p1", kind: "term", coverage: "uncovered", instructionType: "warning-only", impact: "high", segmentIds: ["s1"],
    dependencies: {}, content: { value: "ぎょぎょっと20" } }] }, translationAttempts: [{ attemptId: "a1", segmentId: "s1", needs: [{
      kind: "fact", impact: "critical", question: "Was it released in 1995?", relatedSegmentIds: ["s1"] }] }],
    qaFindings: [{ severity: "error", code: "mistranslated-product-name", segmentId: "s1", details: { reason: "nickname mismatch" } }] }]);
  assert.equal(seed.status, "pending-human-adjudication"); assert.equal(seed.counts.rawOccurrences, 2);
  assert.equal(seed.families.length, 3); assert.equal(seed.families.some((item) => item.origin === "qa" && item.kind === "term"), true);
  assert.match(seed.seedDigest, /^sha256:/); assert.equal(Object.hasOwn(seed, "familySetDigest"), false);
});
