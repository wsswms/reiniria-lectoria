import { createHash } from "node:crypto";
import { DEFAULT_FLOW_BUDGET } from "../src/m5c/contracts.mjs";

export const KNOWLEDGE_LOOP_ARTICLES = Object.freeze({
  "nikon-omoshiro-part1": Object.freeze({ query: "site:nij.nikon.com ニコン おもしろレンズ工房 ぐぐっと ふわっと",
    expectedHost: "nij.nikon.com", segmentCount: 54 }),
  "nikon-omoshiro-part2": Object.freeze({ query: "site:nij.nikon.com ニコン おもしろレンズ工房 ぎょぎょっと20 どどっと400",
    expectedHost: "nij.nikon.com", segmentCount: 62 }),
});

export const BRAVE_COST_MICROS_USD_PER_CALL = 5_000;
export const MAX_RESEARCH_CALLS_PER_ARTICLE = 2;
export const MAX_RETRANSLATION_SEGMENTS_PER_ARTICLE = 16;
export const USER_RECOVERY_MODE = "authorized-malformed-once-per-stage";
export const MAX_USER_CONFIRMED_MALFORMED_RECOVERIES_PER_ARTICLE = 2;
export const TRANSLATION_OUTPUT_TOKENS = 16_384;
export const ROLE_OUTPUT_TOKENS = 65_536;
export const RESEARCH_STEP_CODES = Object.freeze({
  "promote-plan": "RESEARCH_PROMOTE_PLAN",
  "create-request": "RESEARCH_CREATE_REQUEST",
  "issue-grant": "RESEARCH_ISSUE_GRANT",
  "create-run": "RESEARCH_CREATE_RUN",
  "reserve-search": "RESEARCH_RESERVE_SEARCH",
  "invoke-search": "RESEARCH_INVOKE_SEARCH",
  "record-artifact": "RESEARCH_RECORD_ARTIFACT",
  "settle-search": "RESEARCH_SETTLE_SEARCH",
  "create-evidence": "RESEARCH_CREATE_EVIDENCE",
  "create-report": "RESEARCH_CREATE_REPORT",
  "complete-run": "RESEARCH_COMPLETE_RUN",
});

export function researchStepFailure(step, cause) {
  const code = RESEARCH_STEP_CODES[step];
  if (!code) throw new TypeError("real research step is invalid");
  return Object.assign(new Error("real research step failed"), {
    ...(typeof cause?.category === "string" ? { category: cause.category } : {}), code,
  });
}

const RECOVERY_LIMIT_KEYS = Object.freeze([
  ["calls", "maxCalls"],
  ["inputTokens", "maxInputTokens"],
  ["outputTokens", "maxOutputTokens"],
  ["costMicrosCny", "maxCostMicrosCny"],
  ["costMicrosUsd", "maxCostMicrosUsd"],
  ["durationMs", "maxDurationMs"],
]);

export function expandedKnowledgeLoopRecoveryPolicy(policy, category, usage) {
  if (!policy || typeof policy !== "object" || !new Set(["translation", "retranslation"]).has(category)
    || !usage || RECOVERY_LIMIT_KEYS.some(([usageKey]) => !Number.isSafeInteger(usage[usageKey]) || usage[usageKey] < 0)) {
    throw new TypeError("knowledge loop recovery expansion is invalid");
  }
  const categories = Object.fromEntries(Object.entries(policy.categories).map(([name, limits]) => [name, { ...limits }]));
  const limits = {
    maxCalls: policy.maxCalls,
    maxInputTokens: policy.maxInputTokens,
    maxOutputTokens: policy.maxOutputTokens,
    maxCostMicrosCny: policy.maxCostMicrosCny,
    maxCostMicrosUsd: policy.maxCostMicrosUsd,
    maxDurationMs: policy.maxDurationMs,
    maxResearchCycles: policy.maxResearchCycles,
    maxQaCycles: policy.maxQaCycles,
    maxRetranslations: policy.maxRetranslations,
    maxUnknownOutcomes: policy.maxUnknownOutcomes + 1,
    categories,
  };
  for (const [usageKey, limitKey] of RECOVERY_LIMIT_KEYS) {
    limits[limitKey] += usage[usageKey];
    categories[category][limitKey] += usage[usageKey];
  }
  return Object.freeze({ ...limits, categories: Object.freeze(Object.fromEntries(Object.entries(categories)
    .map(([name, value]) => [name, Object.freeze(value)]))) });
}

export function knowledgeLoopArticleBudget(segmentCount) {
  if (!Number.isSafeInteger(segmentCount) || segmentCount < 1 || segmentCount > 128) throw new TypeError("segment count is invalid");
  const zero = Object.freeze({ maxCalls: 0, maxInputTokens: 0, maxOutputTokens: 0, maxCostMicrosCny: 0, maxCostMicrosUsd: 0, maxDurationMs: 0 });
  return Object.freeze({ ...DEFAULT_FLOW_BUDGET, maxCalls: segmentCount + 22, maxInputTokens: 3_000_000,
    maxOutputTokens: ROLE_OUTPUT_TOKENS * 2 + (segmentCount + MAX_RETRANSLATION_SEGMENTS_PER_ARTICLE) * TRANSLATION_OUTPUT_TOKENS,
    maxCostMicrosCny: 50_000_000, maxCostMicrosUsd: 2_000_000, maxDurationMs: 20_000_000,
    maxResearchCycles: 2, maxQaCycles: 1, maxRetranslations: 1, maxUnknownOutcomes: 1,
    categories: Object.freeze({
      planner: Object.freeze({ maxCalls: 1, maxInputTokens: 150_000, maxOutputTokens: ROLE_OUTPUT_TOKENS,
        maxCostMicrosCny: 5_000_000, maxCostMicrosUsd: 0, maxDurationMs: 600_000 }),
      search: Object.freeze({ maxCalls: MAX_RESEARCH_CALLS_PER_ARTICLE, maxInputTokens: 0, maxOutputTokens: 0,
        maxCostMicrosCny: 0, maxCostMicrosUsd: 1_000_000, maxDurationMs: 120_000 }),
      fetch: zero, research: zero,
      translation: Object.freeze({ maxCalls: segmentCount, maxInputTokens: 1_500_000, maxOutputTokens: segmentCount * TRANSLATION_OUTPUT_TOKENS,
        maxCostMicrosCny: 15_000_000, maxCostMicrosUsd: 0, maxDurationMs: segmentCount * 180_000 }),
      qa: Object.freeze({ maxCalls: 1, maxInputTokens: 400_000, maxOutputTokens: ROLE_OUTPUT_TOKENS,
        maxCostMicrosCny: 10_000_000, maxCostMicrosUsd: 0, maxDurationMs: 900_000 }),
      retranslation: Object.freeze({ maxCalls: MAX_RETRANSLATION_SEGMENTS_PER_ARTICLE, maxInputTokens: 500_000,
        maxOutputTokens: MAX_RETRANSLATION_SEGMENTS_PER_ARTICLE * TRANSLATION_OUTPUT_TOKENS,
        maxCostMicrosCny: 10_000_000, maxCostMicrosUsd: 0, maxDurationMs: MAX_RETRANSLATION_SEGMENTS_PER_ARTICLE * 180_000 }),
    }) });
}

export function knowledgeLoopLimits() {
  const translationCalls = Object.values(KNOWLEDGE_LOOP_ARTICLES).reduce((sum, article) => sum + article.segmentCount, 0);
  const maximumUserConfirmedMalformedRecoveries = Object.keys(KNOWLEDGE_LOOP_ARTICLES).length * MAX_USER_CONFIRMED_MALFORMED_RECOVERIES_PER_ARTICLE;
  return Object.freeze({ plannerCalls: 2, initialTranslationCalls: translationCalls, maximumRetranslationCalls: 32, enabledQaCalls: 2,
    maximumUserConfirmedMalformedRecoveries, maximumDeepSeekCalls: translationCalls + 36 + maximumUserConfirmedMalformedRecoveries, maximumBraveCalls: 4,
    maximumBraveCostMicrosUsd: 4 * BRAVE_COST_MICROS_USD_PER_CALL, automaticRetries: 0 });
}

export function selectOfficialSearchResult(results, expectedHost) {
  if (!Array.isArray(results) || typeof expectedHost !== "string") throw new TypeError("search result selection is invalid");
  const selected = results.find((item) => {
    try { return new URL(item.url).hostname === expectedHost && typeof item.title === "string" && typeof item.description === "string"
      && item.title.length + item.description.length > 0; } catch { return false; }
  });
  if (!selected) throw new Error("official search evidence was not returned");
  return Object.freeze(selected);
}

export function summarizeKnowledgeNeeds(needs) {
  if (!Array.isArray(needs)) throw new TypeError("knowledge needs must be an array");
  const counts = { total: needs.length, planner: 0, translation: 0, research: 0, guidance: 0, proceedWithRisk: 0, unresolved: 0 };
  for (const need of needs) {
    if (need.originType === "plan-item") counts.planner += 1; else if (need.originType === "translation-attempt") counts.translation += 1;
    const decision = need.decision?.decision; if (decision === "research") counts.research += 1; else if (decision === "guidance") counts.guidance += 1;
    else if (decision === "proceed-with-risk") counts.proceedWithRisk += 1; else counts.unresolved += 1;
  }
  return Object.freeze(counts);
}

export const digest = (value) => `sha256:${createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
