const contains = (text, patterns) => patterns.some((pattern) => pattern.test(text));

export class LocalGuidanceInterpreter {
  interpret(rawText, { segmentId = null, relatedSegmentIds = [] } = {}) {
    if (typeof rawText !== "string" || rawText.trim().length === 0 || rawText.length > 16_384) throw new TypeError("rawText is invalid");
    const text = rawText.normalize("NFKC").trim(); const ambiguities = [];
    let scope = "document";
    if (contains(text, [/当前句/u, /this sentence/iu])) scope = "sentence";
    else if (contains(text, [/当前段/u, /this (?:paragraph|segment)/iu])) scope = "segment";
    else if (contains(text, [/术语/u, /term/iu])) scope = "term";
    else if (contains(text, [/关联段/u, /related segments?/iu])) scope = "related-segments";
    else if (contains(text, [/本次重译/u, /this retranslation/iu])) scope = "retranslation-only";
    else if (!contains(text, [/全文/u, /整篇/u, /document/iu, /whole/iu, /all/iu])) ambiguities.push("scope-unspecified");

    let action = null;
    if (contains(text, [/预算/u, /费用/u, /调用次数/u, /budget/iu, /cost/iu])) action = "budget-change";
    else if (contains(text, [/继续研究/u, /再查/u, /research/iu, /search/iu])) action = "research-scope";
    else if (contains(text, [/重译/u, /retranslate/iu])) action = "retranslation";
    else if (contains(text, [/接受问题/u, /接受风险/u, /accept (?:issue|risk)/iu])) action = "qa-disposition";
    else if (contains(text, [/上下文/u, /译为/u, /翻成/u, /context/iu, /translate as/iu])) action = "context-instruction";
    else if (contains(text, [/计划/u, /范围/u, /plan/iu, /scope/iu])) action = "plan-scope";
    else { action = "context-instruction"; ambiguities.push("action-unspecified"); }

    let instructionType = "preferred";
    if (contains(text, [/必须/u, /不得/u, /禁止/u, /\bmust\b/iu, /\bnever\b/iu])) instructionType = "hard-constraint";
    else if (contains(text, [/争议/u, /冲突/u, /disputed/iu, /conflict/iu])) instructionType = "disputed";
    else if (contains(text, [/仅提示/u, /警告/u, /warning/iu])) instructionType = "warning-only";
    else if (contains(text, [/背景/u, /background/iu])) instructionType = "background";

    const affectedSegmentIds = scope === "related-segments" ? relatedSegmentIds : ["sentence", "segment", "retranslation-only"].includes(scope) && segmentId ? [segmentId] : [];
    if (["sentence", "segment", "retranslation-only"].includes(scope) && !segmentId) ambiguities.push("segment-unspecified");
    const budgetDelta = {};
    const number = text.match(/(?:增加|追加|add|increase)\s*(\d+)\s*(?:次|calls?)/iu);
    if (number) budgetDelta.maxCalls = Number(number[1]);
    if (action === "budget-change" && !number) ambiguities.push("budget-delta-unspecified");
    if (contains(text, [/不限量/u, /无限/u, /unlimited/iu, /no limit/iu])) ambiguities.push("unbounded-budget-forbidden");
    if (contains(text, [/继续吧/u, /都可以/u, /随便/u, /^ok$/iu, /^continue$/iu])) ambiguities.push("intent-too-vague");
    return Object.freeze({ scope, instructionType, action, affectedSegmentIds: Object.freeze([...new Set(affectedSegmentIds)]),
      budgetDelta: Object.freeze(budgetDelta), stateDiff: Object.freeze({ summary: text.slice(0, 512), mutatesState: false }),
      ambiguities: Object.freeze([...new Set(ambiguities)]) });
  }
}
