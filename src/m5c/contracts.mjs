import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";

export const M5C_CONTRACT_VERSION = "1.0";
export const FLOW_BUDGET_CATEGORIES = Object.freeze([
  "planner", "search", "fetch", "research", "translation", "qa", "retranslation",
]);
export const CONTEXT_ITEM_TYPES = Object.freeze([
  "hard-constraint", "preferred", "background", "disputed", "warning-only",
]);
export const COVERAGE_STATES = Object.freeze([
  "covered", "partially-covered", "conflicted", "stale", "uncovered", "low-impact",
]);
export const GUIDANCE_SCOPES = Object.freeze([
  "sentence", "segment", "term", "related-segments", "document", "retranslation-only",
]);
export const GUIDANCE_ACTIONS = Object.freeze([
  "plan-scope", "research-scope", "context-instruction", "budget-change", "qa-disposition", "retranslation",
]);

export const DEFAULT_FLOW_BUDGET = Object.freeze({
  maxCalls: 256,
  maxInputTokens: 2_000_000,
  maxOutputTokens: 250_000,
  maxCostMicrosCny: 100_000_000,
  maxCostMicrosUsd: 4_000_000,
  maxDurationMs: 7_200_000,
  maxResearchCycles: 3,
  maxQaCycles: 3,
  maxRetranslations: 8,
  maxUnknownOutcomes: 1,
  categories: Object.freeze({
    planner: Object.freeze({ maxCalls: 8, maxInputTokens: 100_000, maxOutputTokens: 20_000, maxCostMicrosCny: 10_000_000, maxCostMicrosUsd: 0, maxDurationMs: 600_000 }),
    search: Object.freeze({ maxCalls: 100, maxInputTokens: 0, maxOutputTokens: 0, maxCostMicrosCny: 0, maxCostMicrosUsd: 4_000_000, maxDurationMs: 1_800_000 }),
    fetch: Object.freeze({ maxCalls: 50, maxInputTokens: 0, maxOutputTokens: 0, maxCostMicrosCny: 0, maxCostMicrosUsd: 0, maxDurationMs: 1_800_000 }),
    research: Object.freeze({ maxCalls: 12, maxInputTokens: 300_000, maxOutputTokens: 80_000, maxCostMicrosCny: 15_000_000, maxCostMicrosUsd: 0, maxDurationMs: 1_800_000 }),
    translation: Object.freeze({ maxCalls: 128, maxInputTokens: 1_000_000, maxOutputTokens: 100_000, maxCostMicrosCny: 25_000_000, maxCostMicrosUsd: 0, maxDurationMs: 3_600_000 }),
    qa: Object.freeze({ maxCalls: 24, maxInputTokens: 400_000, maxOutputTokens: 30_000, maxCostMicrosCny: 25_000_000, maxCostMicrosUsd: 0, maxDurationMs: 1_800_000 }),
    retranslation: Object.freeze({ maxCalls: 32, maxInputTokens: 200_000, maxOutputTokens: 20_000, maxCostMicrosCny: 15_000_000, maxCostMicrosUsd: 0, maxDurationMs: 1_200_000 }),
  }),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const set = (items) => new Set(items);
const TYPES = set(CONTEXT_ITEM_TYPES);
const COVERAGE = set(COVERAGE_STATES);
const SCOPES = set(GUIDANCE_SCOPES);
const ACTIONS = set(GUIDANCE_ACTIONS);
const CATEGORIES = set(FLOW_BUDGET_CATEGORIES);

export function contentDigest(value) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function object(input, name) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError(`${name} must be an object`);
  return input;
}

function exact(input, keys, name) {
  object(input, name);
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${name} has unknown or missing fields`);
}

function id(value, name) {
  if (!UUID.test(value ?? "")) throw new TypeError(`${name} must be a lowercase UUID`);
  return value;
}

function text(value, name, max = 16_384) {
  if (typeof value !== "string" || value.length < 1 || value.length > max) throw new TypeError(`${name} is invalid`);
  return value;
}

function nonnegative(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function positive(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function enumValue(value, allowed, name) {
  if (!allowed.has(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function ids(values, name, { allowEmpty = true } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0) || new Set(values).size !== values.length) throw new TypeError(`${name} must be a unique array`);
  return Object.freeze(values.map((value) => id(value, name)));
}

function actor(input, requiredType = null) {
  exact(input, ["type", "id"], "actor");
  const allowed = requiredType ? new Set([requiredType]) : new Set(["user", "system", "model", "fixture"]);
  return Object.freeze({ type: enumValue(input.type, allowed, "actor.type"), id: text(input.id, "actor.id", 256) });
}

function categoryLimit(input, name) {
  exact(input, ["maxCalls", "maxInputTokens", "maxOutputTokens", "maxCostMicrosCny", "maxCostMicrosUsd", "maxDurationMs"], name);
  return Object.freeze(Object.fromEntries(Object.keys(input).map((key) => [key, nonnegative(input[key], `${name}.${key}`)])));
}

export function flowBudgetPolicyContract(input) {
  exact(input, ["schemaVersion", "workflowId", "revision", "maxCalls", "maxInputTokens", "maxOutputTokens", "maxCostMicrosCny", "maxCostMicrosUsd", "maxDurationMs", "maxResearchCycles", "maxQaCycles", "maxRetranslations", "maxUnknownOutcomes", "categories", "authorizedBy", "createdAt"], "flowBudgetPolicy");
  if (input.schemaVersion !== M5C_CONTRACT_VERSION) throw new TypeError("unsupported flow budget schemaVersion");
  object(input.categories, "categories");
  if (Object.keys(input.categories).sort().join(",") !== [...FLOW_BUDGET_CATEGORIES].sort().join(",")) throw new TypeError("categories must be exhaustive");
  const categories = Object.freeze(Object.fromEntries(FLOW_BUDGET_CATEGORIES.map((name) => [name, categoryLimit(input.categories[name], `categories.${name}`)])));
  const output = Object.freeze({
    schemaVersion: input.schemaVersion, workflowId: id(input.workflowId, "workflowId"), revision: positive(input.revision, "revision"),
    maxCalls: positive(input.maxCalls, "maxCalls"), maxInputTokens: positive(input.maxInputTokens, "maxInputTokens"),
    maxOutputTokens: positive(input.maxOutputTokens, "maxOutputTokens"), maxCostMicrosCny: nonnegative(input.maxCostMicrosCny, "maxCostMicrosCny"),
    maxCostMicrosUsd: nonnegative(input.maxCostMicrosUsd, "maxCostMicrosUsd"), maxDurationMs: positive(input.maxDurationMs, "maxDurationMs"),
    maxResearchCycles: positive(input.maxResearchCycles, "maxResearchCycles"), maxQaCycles: positive(input.maxQaCycles, "maxQaCycles"),
    maxRetranslations: positive(input.maxRetranslations, "maxRetranslations"), maxUnknownOutcomes: positive(input.maxUnknownOutcomes, "maxUnknownOutcomes"),
    categories, authorizedBy: actor(input.authorizedBy, "user"), createdAt: text(input.createdAt, "createdAt", 64),
  });
  for (const key of ["maxInputTokens", "maxOutputTokens", "maxCostMicrosCny", "maxCostMicrosUsd"]) {
    const total = FLOW_BUDGET_CATEGORIES.reduce((sum, name) => sum + categories[name][key], 0);
    if (total > output[key]) throw new TypeError(`category ${key} exceeds flow total`);
  }
  return output;
}

export function budgetUsageContract(input) {
  exact(input, ["calls", "inputTokens", "outputTokens", "costMicrosCny", "costMicrosUsd", "durationMs"], "budgetUsage");
  return Object.freeze({ calls: positive(input.calls, "calls"), inputTokens: nonnegative(input.inputTokens, "inputTokens"),
    outputTokens: nonnegative(input.outputTokens, "outputTokens"), costMicrosCny: nonnegative(input.costMicrosCny, "costMicrosCny"),
    costMicrosUsd: nonnegative(input.costMicrosUsd, "costMicrosUsd"), durationMs: nonnegative(input.durationMs, "durationMs") });
}

export function contextPlanItemContract(input) {
  exact(input, ["itemId", "kind", "coverage", "instructionType", "impact", "segmentIds", "dependencies", "content"], "contextPlanItem");
  const kinds = new Set(["term", "entity", "fact", "relation", "style", "measurement"]);
  const impacts = new Set(["critical", "high", "medium", "low"]);
  object(input.dependencies, "dependencies"); object(input.content, "content");
  const coverage = enumValue(input.coverage, COVERAGE, "coverage");
  const instructionType = enumValue(input.instructionType, TYPES, "instructionType");
  if (["conflicted", "stale"].includes(coverage) && !["disputed", "warning-only"].includes(instructionType)) throw new TypeError("conflicted or stale items cannot be affirmative instructions");
  if (instructionType === "disputed" && coverage !== "conflicted") throw new TypeError("disputed items must be conflicted");
  return Object.freeze({ itemId: id(input.itemId, "itemId"), kind: enumValue(input.kind, kinds, "kind"), coverage,
    instructionType, impact: enumValue(input.impact, impacts, "impact"), segmentIds: ids(input.segmentIds, "segmentIds"),
    dependencies: Object.freeze({ ...input.dependencies }), content: Object.freeze({ ...input.content }) });
}

export function contextPlanContract(input) {
  exact(input, ["schemaVersion", "planRevisionId", "workflowId", "documentId", "sourceRevisionId", "targetLanguage", "revision", "plannerMode", "state", "items", "researchScope", "qaProfile", "createdBy", "createdAt"], "contextPlan");
  if (input.schemaVersion !== M5C_CONTRACT_VERSION) throw new TypeError("unsupported context plan schemaVersion");
  const states = new Set(["draft", "pending-user", "approved", "rejected", "canceled", "failed", "unknown", "stale"]);
  const plannerModes = new Set(["local", "model-assisted"]);
  if (!Array.isArray(input.items)) throw new TypeError("items must be an array");
  object(input.researchScope, "researchScope"); object(input.qaProfile, "qaProfile");
  return Object.freeze({ schemaVersion: input.schemaVersion, planRevisionId: id(input.planRevisionId, "planRevisionId"),
    workflowId: id(input.workflowId, "workflowId"), documentId: id(input.documentId, "documentId"), sourceRevisionId: id(input.sourceRevisionId, "sourceRevisionId"),
    targetLanguage: text(input.targetLanguage, "targetLanguage", 63), revision: positive(input.revision, "revision"),
    plannerMode: enumValue(input.plannerMode, plannerModes, "plannerMode"), state: enumValue(input.state, states, "state"),
    items: Object.freeze(input.items.map(contextPlanItemContract)), researchScope: Object.freeze({ ...input.researchScope }),
    qaProfile: Object.freeze({ ...input.qaProfile }), createdBy: actor(input.createdBy), createdAt: text(input.createdAt, "createdAt", 64) });
}

export function guidanceInterpretationContract(input) {
  exact(input, ["scope", "instructionType", "action", "affectedSegmentIds", "budgetDelta", "stateDiff", "ambiguities"], "guidanceInterpretation");
  if (!Array.isArray(input.ambiguities) || input.ambiguities.some((value) => typeof value !== "string")) throw new TypeError("ambiguities must be strings");
  object(input.budgetDelta, "budgetDelta"); object(input.stateDiff, "stateDiff");
  return Object.freeze({ scope: enumValue(input.scope, SCOPES, "scope"), instructionType: enumValue(input.instructionType, TYPES, "instructionType"),
    action: enumValue(input.action, ACTIONS, "action"), affectedSegmentIds: ids(input.affectedSegmentIds, "affectedSegmentIds"),
    budgetDelta: Object.freeze({ ...input.budgetDelta }), stateDiff: Object.freeze({ ...input.stateDiff }), ambiguities: Object.freeze([...input.ambiguities]) });
}

export function userGuidanceContract(input) {
  exact(input, ["schemaVersion", "guidanceRevisionId", "guidanceId", "workflowId", "revision", "rawText", "interpretation", "state", "createdBy", "createdAt"], "userGuidance");
  if (input.schemaVersion !== M5C_CONTRACT_VERSION) throw new TypeError("unsupported guidance schemaVersion");
  const states = new Set(["draft", "pending-user", "confirmed", "rejected", "canceled", "failed", "unknown"]);
  return Object.freeze({ schemaVersion: input.schemaVersion, guidanceRevisionId: id(input.guidanceRevisionId, "guidanceRevisionId"),
    guidanceId: id(input.guidanceId, "guidanceId"), workflowId: id(input.workflowId, "workflowId"), revision: positive(input.revision, "revision"),
    rawText: text(input.rawText, "rawText"), interpretation: guidanceInterpretationContract(input.interpretation),
    state: enumValue(input.state, states, "state"), createdBy: actor(input.createdBy), createdAt: text(input.createdAt, "createdAt", 64) });
}

export function assertBudgetCategory(value) { return enumValue(value, CATEGORIES, "category"); }
export function assertSha256(value, name = "digest") { if (!SHA256.test(value ?? "")) throw new TypeError(`${name} is invalid`); return value; }
