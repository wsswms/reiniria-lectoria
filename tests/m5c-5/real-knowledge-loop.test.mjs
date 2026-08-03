import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { flowBudgetPolicyContract } from "../../src/m5c/contracts.mjs";
import { knowledgeLoopArticleBudget, knowledgeLoopLimits, RESEARCH_STEP_CODES, researchStepFailure,
  selectOfficialSearchResult, summarizeKnowledgeNeeds } from "../../scripts/m5c-real-knowledge-loop.mjs";

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

test("real research failures expose only fixed safe step codes", () => {
  assert.deepEqual(Object.values(RESEARCH_STEP_CODES), ["RESEARCH_PROMOTE_PLAN", "RESEARCH_CREATE_REQUEST", "RESEARCH_ISSUE_GRANT",
    "RESEARCH_CREATE_RUN", "RESEARCH_RESERVE_SEARCH", "RESEARCH_INVOKE_SEARCH", "RESEARCH_RECORD_ARTIFACT",
    "RESEARCH_SETTLE_SEARCH", "RESEARCH_CREATE_EVIDENCE", "RESEARCH_CREATE_REPORT", "RESEARCH_COMPLETE_RUN"]);
  const failure = researchStepFailure("create-request", { category: "policy", message: "private source text", url: "https://private.invalid" });
  assert.deepEqual({ message: failure.message, category: failure.category, code: failure.code, keys: Object.keys(failure).sort() },
    { message: "real research step failed", category: "policy", code: "RESEARCH_CREATE_REQUEST", keys: ["category", "code"] });
  assert.throws(() => researchStepFailure("private-step", {}), /invalid/);
});
