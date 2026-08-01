import { providerRequestContract, providerResponseContract } from "../provider/contracts.mjs";

const RUNNER_TASK_VERSION = "runner-task-v1";
const RUNNER_OUTPUT_VERSION = "runner-output-v1";

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

export function runnerTaskContract(input) {
  if (!input || typeof input !== "object" || input.schemaVersion !== RUNNER_TASK_VERSION) throw new TypeError("runner task version is invalid");
  const request = providerRequestContract(input.request);
  if (!input.capability || typeof input.capability.token !== "string" || input.capability.token.length === 0 || input.capability.token.length > 4096) {
    throw new TypeError("runner capability is invalid");
  }
  const limits = Object.freeze({
    inputBytes: positiveInteger(input.limits?.inputBytes, "inputBytes", 4 * 1024 * 1024),
    outputBytes: positiveInteger(input.limits?.outputBytes, "outputBytes", 4 * 1024 * 1024),
    toolCalls: positiveInteger(input.limits?.toolCalls, "toolCalls", 32),
    runtimeMs: positiveInteger(input.limits?.runtimeMs, "runtimeMs", 300_000),
  });
  return Object.freeze({
    schemaVersion: RUNNER_TASK_VERSION,
    request,
    capability: Object.freeze({ token: input.capability.token }),
    limits,
  });
}

export function runnerOutputContract(input, taskInput, { expectedToolReceipts = [] } = {}) {
  const task = runnerTaskContract(taskInput);
  if (!input || typeof input !== "object" || input.schemaVersion !== RUNNER_OUTPUT_VERSION || input.status !== "completed") {
    throw new TypeError("runner output is not completed");
  }
  for (const [name, expected] of [
    ["taskId", task.request.taskId], ["attemptId", task.request.attemptId],
    ["providerId", task.request.providerId], ["modelId", task.request.modelId],
  ]) if (input[name] !== expected) throw new TypeError(`runner ${name} mismatch`);
  if (!Array.isArray(input.toolReceiptDigests)) throw new TypeError("runner tool receipts are invalid");
  const actualReceipts = [...input.toolReceiptDigests].sort();
  const wantedReceipts = [...expectedToolReceipts].sort();
  if (actualReceipts.length !== wantedReceipts.length || actualReceipts.some((value, index) => value !== wantedReceipts[index])) {
    throw new TypeError("runner tool receipts mismatch");
  }
  const response = providerResponseContract(input.response, task.request);
  return Object.freeze({
    schemaVersion: RUNNER_OUTPUT_VERSION,
    status: "completed",
    taskId: task.request.taskId,
    attemptId: task.request.attemptId,
    providerId: task.request.providerId,
    modelId: task.request.modelId,
    response,
    toolReceiptDigests: Object.freeze(actualReceipts),
    runtime: typeof input.runtime === "string" ? input.runtime : "unknown",
  });
}

export { RUNNER_OUTPUT_VERSION, RUNNER_TASK_VERSION };
