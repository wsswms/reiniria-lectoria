export const LEXICAL_STAGE_A_V2_MAX_ATTEMPTS = 16;
export const LEXICAL_STAGE_A_V2_MAX_CONCURRENCY = 8;
export const LEXICAL_STAGE_A_V2_MAX_COST_MICROS_CNY = 20_000_000;
export const LEXICAL_STAGE_A_V2_UNKNOWN_RESERVATION_MICROS_CNY = 500_000;

export function lexicalStageAV2Plan(documents) {
  if (!Array.isArray(documents) || documents.length !== 4
    || documents.some((item) => typeof item?.documentId !== "string" || item.documentId.length < 1)) {
    throw new TypeError("lexical Stage A v2 documents are invalid");
  }
  const tasks = [];
  for (let repeat = 1; repeat <= 2; repeat += 1) for (const [documentIndex, document] of documents.entries()) {
    tasks.push(Object.freeze({ taskId: `pro-a-v2-d${documentIndex + 1}-r${repeat}`, stage: "stage-a",
      stageAPromptVersion: "precision-v2", repeat, documentIndex, documentId: document.documentId,
      dependencyTaskIds: Object.freeze([]), sequence: tasks.length + 1 }));
  }
  return Object.freeze(tasks);
}

function nonnegative(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} is invalid`);
  return value;
}

export function lexicalStageAV2BudgetExposure({ knownCostMicrosCny, unknownUsageCalls, pendingCalls = 0 }) {
  nonnegative(knownCostMicrosCny, "known cost"); nonnegative(unknownUsageCalls, "unknown usage calls");
  nonnegative(pendingCalls, "pending calls");
  if (pendingCalls > LEXICAL_STAGE_A_V2_MAX_CONCURRENCY) throw new TypeError("lexical Stage A v2 pending calls are invalid");
  return knownCostMicrosCny + (unknownUsageCalls + pendingCalls) * LEXICAL_STAGE_A_V2_UNKNOWN_RESERVATION_MICROS_CNY;
}

export function lexicalStageAV2WaveAllowed(input) {
  return lexicalStageAV2BudgetExposure(input) <= LEXICAL_STAGE_A_V2_MAX_COST_MICROS_CNY;
}
