import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";

export const LEXICAL_EXPERIMENT_VERSION = "m5e-lexical-two-stage-v1";
export const LEXICAL_EXPERIMENT_MODEL = "deepseek-v4-flash";
export const LEXICAL_EXPERIMENT_TEMPERATURE = 1;
export const LEXICAL_EXPERIMENT_MAX_OUTPUT_TOKENS = 65_536;
export const LEXICAL_EXPERIMENT_MAX_CALLS = 100;
export const LEXICAL_EXPERIMENT_MAX_CONCURRENCY = 4;
export const LEXICAL_EXPERIMENT_MAX_COST_MICROS_CNY = 20_000_000;
export const LEXICAL_EXPERIMENT_UNKNOWN_COST_RESERVATION_MICROS_CNY = 500_000;

const sha = (value) => `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
const text = (value, name) => {
  if (typeof value !== "string" || value.length < 1 || value.length > 255) throw new TypeError(`${name} is invalid`); return value;
};

export function buildLexicalExperimentPlan(documents) {
  if (!Array.isArray(documents) || documents.length !== 4 || new Set(documents.map((item) => item?.documentId)).size !== 4) {
    throw new TypeError("lexical experiment requires four unique documents");
  }
  const rows = documents.map((document, documentIndex) => Object.freeze({ documentIndex,
    documentId: text(document.documentId, "documentId"), sourceLanguage: text(document.language, "sourceLanguage"),
    targetLanguage: text(document.targetLanguage, "targetLanguage") }));
  const tasks = []; const stageA = new Map();
  for (let repeat = 1; repeat <= 8; repeat += 1) for (const row of rows) {
    const taskId = `lex-a-d${row.documentIndex + 1}-r${repeat}`; const task = Object.freeze({ stage: "stage-a", repeat,
      unionWidth: 1, dependencyTaskIds: Object.freeze([]), ...row, taskId }); tasks.push(task);
    const list = stageA.get(row.documentId) ?? []; list.push(task); stageA.set(row.documentId, list);
  }
  // Interleave all three Stage B variants after Stage A. If the independent
  // cost stop is reached, the completed prefix still contains comparable
  // single, pair and union8 evidence instead of starving the union arm.
  for (let repeat = 1; repeat <= 8; repeat += 1) for (const row of rows) {
    const dependencies = stageA.get(row.documentId); const dependency = dependencies[repeat - 1];
    tasks.push(Object.freeze({ stage: "stage-b-single", repeat, unionWidth: 1,
      dependencyTaskIds: Object.freeze([dependency.taskId]), ...row, taskId: `lex-b1-d${row.documentIndex + 1}-r${repeat}` }));
    if (repeat <= 4) tasks.push(Object.freeze({ stage: "stage-b-pair", repeat, unionWidth: 2,
      dependencyTaskIds: Object.freeze([dependencies[(repeat - 1) * 2].taskId, dependencies[(repeat - 1) * 2 + 1].taskId]), ...row,
      taskId: `lex-b2-d${row.documentIndex + 1}-p${repeat}` }));
    if (repeat <= 5) tasks.push(Object.freeze({ stage: "stage-b-union8", repeat, unionWidth: 8,
      dependencyTaskIds: Object.freeze(dependencies.map((item) => item.taskId)), ...row,
      taskId: `lex-b8-d${row.documentIndex + 1}-r${repeat}` }));
  }
  if (tasks.length !== LEXICAL_EXPERIMENT_MAX_CALLS) throw new Error("lexical experiment matrix size mismatch");
  return Object.freeze(tasks.map((task, index) => Object.freeze({ ...task, sequence: index + 1,
    taskDigest: sha({ ...task, sequence: index + 1 }) })));
}

export function lexicalExperimentBudgetExposure({ knownCostMicrosCny, unknownUsageCalls }) {
  if (!Number.isSafeInteger(knownCostMicrosCny) || knownCostMicrosCny < 0
    || !Number.isSafeInteger(unknownUsageCalls) || unknownUsageCalls < 0) throw new TypeError("lexical experiment budget exposure is invalid");
  return knownCostMicrosCny + unknownUsageCalls * LEXICAL_EXPERIMENT_UNKNOWN_COST_RESERVATION_MICROS_CNY;
}

export function lexicalExperimentWaveAllowed({ knownCostMicrosCny, unknownUsageCalls, pendingCalls }) {
  if (!Number.isSafeInteger(pendingCalls) || pendingCalls < 1 || pendingCalls > LEXICAL_EXPERIMENT_MAX_CONCURRENCY) {
    throw new TypeError("lexical experiment wave is invalid");
  }
  return lexicalExperimentBudgetExposure({ knownCostMicrosCny,
    unknownUsageCalls: unknownUsageCalls + pendingCalls }) <= LEXICAL_EXPERIMENT_MAX_COST_MICROS_CNY;
}
