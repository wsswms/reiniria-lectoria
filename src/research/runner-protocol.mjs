import { opaqueId } from "../domain/contracts.mjs";

export const RESEARCH_RUNNER_TASK_VERSION = "research-runner-task-v1";
export const RESEARCH_RUNNER_OUTPUT_VERSION = "research-runner-output-v1";
const PHASES = new Set(["discover", "collect", "synthesize"]);

function exact(input, keys, name) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key))) throw new TypeError(`${name} is invalid`);
}
function text(value, name, max = 16_384) { if (typeof value !== "string" || value.trim().length === 0 || value.length > max) throw new TypeError(`${name} is invalid`); return value; }
function positive(value, name, max) { if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError(`${name} is invalid`); return value; }

function provider(input) {
  exact(input, ["capability", "providerId"], "runner provider");
  if (!new Set(["search", "extract", "research-model"]).has(input.capability)) throw new TypeError("runner provider capability is invalid");
  return Object.freeze({ capability: input.capability, providerId: text(input.providerId, "providerId", 127) });
}

function observation(input) {
  exact(input, ["type", "id", "url", "title", "contentDigest", "untrusted"], "runner observation");
  if (!new Set(["search-result", "content"]).has(input.type) || input.untrusted !== true) throw new TypeError("runner observation is invalid");
  const output = { type: input.type, id: text(input.id, "observation id", 255), title: text(input.title, "observation title", 2_048),
    contentDigest: text(input.contentDigest, "contentDigest", 71), untrusted: true };
  if (input.url !== null) {
    const url = new URL(input.url);
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) throw new TypeError("runner observation URL is invalid");
    output.url = url.toString();
  } else output.url = null;
  return Object.freeze(output);
}

export function researchRunnerTaskContract(input) {
  exact(input, ["schemaVersion", "grantId", "runId", "round", "phase", "questions", "allowedProviders", "observations", "capability", "limits"], "research runner task");
  if (input.schemaVersion !== RESEARCH_RUNNER_TASK_VERSION || !PHASES.has(input.phase)) throw new TypeError("research runner task version or phase is invalid");
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 32) throw new TypeError("runner questions are invalid");
  if (!Array.isArray(input.allowedProviders) || input.allowedProviders.length < 1 || input.allowedProviders.length > 16) throw new TypeError("runner providers are invalid");
  if (!Array.isArray(input.observations) || input.observations.length > 64) throw new TypeError("runner observations are invalid");
  exact(input.capability, ["token"], "runner capability");
  exact(input.limits, ["inputBytes", "outputBytes", "toolCalls", "runtimeMs"], "runner limits");
  return Object.freeze({ schemaVersion: RESEARCH_RUNNER_TASK_VERSION, grantId: opaqueId(input.grantId, "grantId"), runId: opaqueId(input.runId, "runId"),
    round: positive(input.round, "round", 10), phase: input.phase,
    questions: Object.freeze(input.questions.map((item) => text(item, "question", 2_048))),
    allowedProviders: Object.freeze(input.allowedProviders.map(provider)), observations: Object.freeze(input.observations.map(observation)),
    capability: Object.freeze({ token: text(input.capability.token, "capability token", 16_384) }), limits: Object.freeze({
      inputBytes: positive(input.limits.inputBytes, "inputBytes", 4 * 1024 * 1024), outputBytes: positive(input.limits.outputBytes, "outputBytes", 4 * 1024 * 1024),
      toolCalls: positive(input.limits.toolCalls, "toolCalls", 32), runtimeMs: positive(input.limits.runtimeMs, "runtimeMs", 300_000),
    }) });
}

function action(input, task) {
  exact(input, ["tool", "providerId", "query", "url", "observationIds"], "runner action");
  if (!new Set(["search", "extract", "synthesize"]).has(input.tool)) throw new TypeError("runner action tool is invalid");
  const capability = input.tool === "synthesize" ? "research-model" : input.tool;
  if (!task.allowedProviders.some((item) => item.capability === capability && item.providerId === input.providerId)) throw new TypeError("runner action provider is not allowed");
  const output = { tool: input.tool, providerId: input.providerId, query: input.query === null ? null : text(input.query, "action query", 2_048),
    url: input.url === null ? null : new URL(input.url).toString(), observationIds: Object.freeze(input.observationIds.map((item) => text(item, "observationId", 255))) };
  if (output.observationIds.some((id) => !task.observations.some((item) => item.id === id))) throw new TypeError("runner action references an unknown observation");
  return Object.freeze(output);
}

export function researchRunnerOutputContract(input, taskInput) {
  const task = researchRunnerTaskContract(taskInput);
  exact(input, ["schemaVersion", "grantId", "runId", "round", "phase", "actions", "stopReason"], "research runner output");
  if (input.schemaVersion !== RESEARCH_RUNNER_OUTPUT_VERSION || input.grantId !== task.grantId || input.runId !== task.runId || input.round !== task.round || input.phase !== task.phase) throw new TypeError("research runner output identity mismatch");
  if (!Array.isArray(input.actions) || input.actions.length > task.limits.toolCalls) throw new TypeError("research runner output actions are invalid");
  const actions = input.actions.map((item) => action(item, task));
  return Object.freeze({ schemaVersion: RESEARCH_RUNNER_OUTPUT_VERSION, grantId: task.grantId, runId: task.runId, round: task.round,
    phase: task.phase, actions: Object.freeze(actions), stopReason: input.stopReason === null ? null : text(input.stopReason, "stopReason", 127) });
}
