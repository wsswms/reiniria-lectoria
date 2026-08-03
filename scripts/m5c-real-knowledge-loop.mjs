import { createHash } from "node:crypto";

export const KNOWLEDGE_LOOP_ARTICLES = Object.freeze({
  "nikon-omoshiro-part1": Object.freeze({ query: "site:nij.nikon.com ニコン おもしろレンズ工房 ぐぐっと ふわっと",
    expectedHost: "nij.nikon.com", segmentCount: 54 }),
  "nikon-omoshiro-part2": Object.freeze({ query: "site:nij.nikon.com ニコン おもしろレンズ工房 ぎょぎょっと20 どどっと400",
    expectedHost: "nij.nikon.com", segmentCount: 62 }),
});

export const BRAVE_COST_MICROS_USD_PER_CALL = 5_000;
export const MAX_RESEARCH_CALLS_PER_ARTICLE = 2;
export const MAX_RETRANSLATION_SEGMENTS_PER_ARTICLE = 16;

export function knowledgeLoopLimits() {
  const translationCalls = Object.values(KNOWLEDGE_LOOP_ARTICLES).reduce((sum, article) => sum + article.segmentCount, 0);
  return Object.freeze({ plannerCalls: 2, initialTranslationCalls: translationCalls, maximumRetranslationCalls: 32, enabledQaCalls: 2,
    maximumDeepSeekCalls: translationCalls + 36, maximumBraveCalls: 4,
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
