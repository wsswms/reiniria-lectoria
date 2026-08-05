import assert from "node:assert/strict";
import test from "node:test";
import { observePlanKnowledgeNeeds, observeTranslationKnowledgeNeeds } from "../../src/m5e/observation-adapter.mjs";

test("M5E observes structured Planner items without changing M5C persistence or decisions", () => {
  const observed = observePlanKnowledgeNeeds({ planRevisionId: "plan-1", items: [{ itemId: "item-1", kind: "term", coverage: "uncovered",
    instructionType: "warning-only", impact: "high", segmentIds: ["s2", "s1"], dependencies: {}, content: { value: "ぎょぎょっと20", type: "product-name" } },
  { itemId: "item-low", kind: "style", coverage: "low-impact", instructionType: "preferred", impact: "low", segmentIds: ["s3"], dependencies: {}, content: { rule: "playful" } }] });
  assert.equal(observed.length, 2); assert.deepEqual(observed[0].relatedSegmentIds, ["s1", "s2"]);
  assert.deepEqual(observed[0].semantic, { type: "product-name", value: "ぎょぎょっと20" });
  assert.equal(observed[0].originType, "plan-item");
});

test("translation observations remain conservative when the Provider supplied no structured semantic identity", () => {
  const observed = observeTranslationKnowledgeNeeds({ attemptId: "attempt-1", segmentId: "s1" }, [{ kind: "fact", impact: "critical",
    question: "Was the lens released in 1995?", relatedSegmentIds: ["s1"] }]);
  assert.equal(observed[0].semantic, undefined); assert.equal(observed[0].originType, "translation-attempt");
});
