import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { buildDetectorV3DeepSeekBody } from "./detector-v3.mjs";
import { buildDetectorV3LiteDeepSeekBody } from "./detector-v3-lite.mjs";

export const PLANNER_EXPERIMENT_VERSION = "m5e-planner-prompt-temperature-v1";
export const PLANNER_EXPERIMENT_MODEL = "deepseek-v4-flash";
export const PLANNER_EXPERIMENT_MAX_OUTPUT_TOKENS = 65_536;
export const PLANNER_EXPERIMENT_INITIAL_CALLS = 48;
export const PLANNER_EXPERIMENT_CONFIRM_CALLS = 12;
export const PLANNER_EXPERIMENT_MAX_CALLS = 60;
export const PLANNER_EXPERIMENT_MAX_CONCURRENCY = 4;
export const PLANNER_EXPERIMENT_MAX_COST_MICROS_CNY = 15_000_000;

const sha = (value) => `sha256:${createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex")}`;

export function buildPlannerExperimentMatrix(documents, { phase = "initial", promptVariant, temperature } = {}) {
  if (!Array.isArray(documents) || documents.length !== 4 || new Set(documents.map((item) => item.document.documentId)).size !== 4) {
    throw new TypeError("Planner experiment requires four unique coverages");
  }
  let configs; let repeats;
  if (phase === "initial") { configs = [["current-v1", 0], ["current-v1", 1], ["lite-v1", 0], ["lite-v1", 1]]; repeats = 3; }
  else {
    if (!["current-v1", "lite-v1"].includes(promptVariant) || ![0, 1].includes(temperature)) throw new TypeError("confirmation configuration is invalid");
    configs = [[promptVariant, temperature]]; repeats = 3;
  }
  const tasks = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) for (const [documentIndex, coverage] of documents.entries()) {
    for (const [variant, value] of configs) tasks.push(Object.freeze({ phase, repeat, documentIndex, documentId: coverage.document.documentId,
      sourceLanguage: coverage.document.language, targetLanguage: coverage.document.targetLanguage,
      promptVariant: variant, temperature: value, coverage }));
  }
  const expected = phase === "initial" ? PLANNER_EXPERIMENT_INITIAL_CALLS : PLANNER_EXPERIMENT_CONFIRM_CALLS;
  if (tasks.length !== expected) throw new Error("Planner experiment matrix size mismatch");
  return Object.freeze(tasks.map((task, index) => Object.freeze({ ...task, sequence: index + 1,
    taskId: `${phase}-${String(index + 1).padStart(3, "0")}-${task.documentId.slice(-4)}-${task.promptVariant}-t${task.temperature}-r${task.repeat}` })));
}
export function plannerExperimentPromptMetrics(coverages) {
  if (!Array.isArray(coverages) || coverages.length !== 4) throw new TypeError("prompt metrics require four coverages");
  const rows = [];
  for (const coverage of coverages) for (const promptVariant of ["current-v1", "lite-v1"]) for (const temperature of [0, 1]) {
    const body = promptVariant === "lite-v1"
      ? buildDetectorV3LiteDeepSeekBody({ coverage, modelId: PLANNER_EXPERIMENT_MODEL,
        maxOutputTokens: PLANNER_EXPERIMENT_MAX_OUTPUT_TOKENS, temperature })
      : buildDetectorV3DeepSeekBody({ coverage, modelId: PLANNER_EXPERIMENT_MODEL,
        maxOutputTokens: PLANNER_EXPERIMENT_MAX_OUTPUT_TOKENS, temperature });
    const system = body.messages[0].content; const user = body.messages[1].content;
    rows.push(Object.freeze({ documentId: coverage.document.documentId, promptVariant, temperature,
      systemCharacters: system.length, userCharacters: user.length, bodyBytes: Buffer.byteLength(JSON.stringify(body)),
      systemDigest: sha(system), userDigest: sha(user), bodyDigest: sha(body) }));
  }
  return Object.freeze(rows);
}
