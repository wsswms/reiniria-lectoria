import { stableJson } from "../domain/contracts.mjs";

const PLAN_KINDS = new Set(["term", "entity", "fact", "relation", "style", "measurement"]);
const IMPACTS = new Set(["critical", "high", "medium", "low"]);

function text(value, name, maximum = 4_096) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

function segments(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) throw new TypeError("segmentIds are invalid");
  return Object.freeze([...new Set(value.map((item) => text(item, "segmentId", 255)))].sort());
}

function semantic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Planner content must be a structured object");
  return Object.freeze(JSON.parse(stableJson(value)));
}

export function observePlanKnowledgeNeeds(plan) {
  text(plan?.planRevisionId, "planRevisionId", 255);
  if (!Array.isArray(plan.items) || plan.items.length > 4_096) throw new TypeError("Plan items are invalid");
  return Object.freeze(plan.items.map((item) => {
    if (!PLAN_KINDS.has(item.kind) || !IMPACTS.has(item.impact)) throw new TypeError("Plan item is invalid");
    const itemId = text(item.itemId, "itemId", 255); const content = semantic(item.content);
    return Object.freeze({ needId: `plan:${plan.planRevisionId}:${itemId}`, originType: "plan-item", originId: itemId,
      kind: item.kind, impact: item.impact, question: `Resolve ${item.kind} translation uncertainty: ${stableJson(content)}`,
      relatedSegmentIds: segments(item.segmentIds), semantic: content });
  }).sort((left, right) => left.needId.localeCompare(right.needId)));
}

export function observeTranslationKnowledgeNeeds(attempt, needs) {
  const attemptId = text(attempt?.attemptId, "attemptId", 255); text(attempt?.segmentId, "segmentId", 255);
  if (!Array.isArray(needs) || needs.length > 8) throw new TypeError("translation knowledge needs are invalid");
  return Object.freeze(needs.map((item, index) => {
    if (!PLAN_KINDS.has(item.kind) || !IMPACTS.has(item.impact)) throw new TypeError("translation knowledge need is invalid");
    return Object.freeze({ needId: `translation:${attemptId}:${index}`, originType: "translation-attempt", originId: attemptId,
      kind: item.kind, impact: item.impact, question: text(item.question, "question"), relatedSegmentIds: segments(item.relatedSegmentIds) });
  }));
}
