import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { flowBudgetPolicyContract } from "../../src/m5c/contracts.mjs";
import { knowledgeLoopArticleBudget, knowledgeLoopLimits, selectOfficialSearchResult, summarizeKnowledgeNeeds } from "../../scripts/m5c-real-knowledge-loop.mjs";

test("real knowledge loop fixes one enabled QA and bounded research and retranslation", () => {
  assert.deepEqual(knowledgeLoopLimits(), { plannerCalls: 2, initialTranslationCalls: 116, maximumRetranslationCalls: 32,
    enabledQaCalls: 2, maximumDeepSeekCalls: 152, maximumBraveCalls: 4, maximumBraveCostMicrosUsd: 20_000, automaticRetries: 0 });
});

test("real knowledge loop article budgets satisfy the production FlowBudget contract", () => {
  for (const segmentCount of [54, 62]) assert.doesNotThrow(() => flowBudgetPolicyContract({ schemaVersion: "1.0", workflowId: randomUUID(), revision: 1,
    ...knowledgeLoopArticleBudget(segmentCount), authorizedBy: { type: "user", id: "fixture" }, createdAt: new Date(0).toISOString() }));
});

test("real knowledge loop accepts only the fixed official Nikon search host", () => {
  const selected = selectOfficialSearchResult([{ url: "https://example.com/no", title: "x", description: "y" },
    { url: "https://nij.nikon.com/cms/enjoy/life/historynikkor/0054/", title: "Nikon", description: "Official article" }], "nij.nikon.com");
  assert.equal(new URL(selected.url).hostname, "nij.nikon.com");
  assert.throws(() => selectOfficialSearchResult([{ url: "https://example.com/no", title: "x", description: "y" }], "nij.nikon.com"), /official/);
});

test("knowledge need audit summary separates origins and user decisions", () => {
  assert.deepEqual(summarizeKnowledgeNeeds([{ originType: "plan-item", decision: { decision: "research" } },
    { originType: "translation-attempt", decision: { decision: "proceed-with-risk" } },
    { originType: "translation-attempt", decision: null }]),
  { total: 3, planner: 1, translation: 2, research: 1, guidance: 0, proceedWithRisk: 1, unresolved: 1 });
});
