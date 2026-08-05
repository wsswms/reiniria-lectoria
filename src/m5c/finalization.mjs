import { contentDigest } from "./contracts.mjs";

export const DEFAULT_QA_MODE = "enabled";
export const QA_MODES = Object.freeze(["disabled", "enabled"]);

export function qaMode(input = DEFAULT_QA_MODE) {
  if (!QA_MODES.includes(input)) throw new TypeError("QA mode must be disabled or enabled");
  return input;
}

function usage(input) {
  const keys = ["calls", "inputTokens", "outputTokens", "costMicrosCny", "costMicrosUsd", "durationMs"];
  if (!input || keys.some((key) => !Number.isSafeInteger(input[key]) || input[key] < 0)) throw new TypeError("finalization usage is invalid");
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, input[key]])));
}

function selectedRun(workflowId, selectedMode, run) {
  if (!run || run.workflowId !== workflowId || run.status !== "completed" || run.current !== true
    || typeof run.qaRunId !== "string" || typeof run.targetRevisionId !== "string") throw new Error("current completed QA run is required");
  if (run.model?.thinking !== selectedMode) throw new Error("QA run mode does not match the selected product mode");
  return run;
}

export function finalizeProductRevision({ workflowId, qaMode: requestedMode = DEFAULT_QA_MODE, qaRun, workingCopyDigest,
  validation, flowBudgetUsage, qaUsage }) {
  if (typeof workflowId !== "string" || workflowId.length === 0 || typeof workingCopyDigest !== "string" || workingCopyDigest.length === 0)
    throw new TypeError("product finalization identity is invalid");
  const selectedMode = qaMode(requestedMode); const run = selectedRun(workflowId, selectedMode, qaRun);
  if (!validation || typeof validation.validationRunId !== "string" || !Array.isArray(validation.findings)) throw new TypeError("validation result is required");
  const value = { schemaVersion: "m5c-product-finalization-v1", status: "completed-awaiting-user-disposition", workflowId,
    targetRevisionId: run.targetRevisionId, workingCopyDigest, selectedQaMode: selectedMode, requiredQaRunId: run.qaRunId,
    qa: { qaRunId: run.qaRunId, current: true, findings: run.findings.length, usage: usage(qaUsage) },
    validator: { validationRunId: validation.validationRunId, findings: validation.findings.length }, flowBudgetUsage: usage(flowBudgetUsage),
    approvalPerformed: false, riskAcceptancePerformed: false, exportPerformed: false };
  return Object.freeze({ ...value, artifactDigest: contentDigest(value) });
}

export function createQaEvaluationReport(runs) {
  if (!Array.isArray(runs) || runs.length !== 2) throw new TypeError("evaluation requires exactly two QA runs");
  const byMode = new Map(runs.map((item) => [qaMode(item.mode), item]));
  if (byMode.size !== 2 || QA_MODES.some((mode) => !byMode.has(mode))) throw new TypeError("evaluation requires disabled and enabled runs");
  const targetRevisionIds = new Set(runs.map((item) => item.targetRevisionId));
  if (targetRevisionIds.size !== 1) throw new Error("evaluation QA runs must bind the same target revision");
  const summaries = QA_MODES.map((mode) => { const item = byMode.get(mode);
    return Object.freeze({ mode, qaRunId: item.qaRunId, targetRevisionId: item.targetRevisionId,
      findings: item.findings.length, usage: usage(item.usage) }); });
  const value = { schemaVersion: "m5c-qa-evaluation-report-v1", scope: "evaluation-only", productFinalizationRequired: false,
    targetRevisionId: summaries[0].targetRevisionId, runs: Object.freeze(summaries) };
  return Object.freeze({ ...value, reportDigest: contentDigest(value) });
}

export function safeFinalizationFailure(error, stage = "finalization") {
  const allowedStages = new Set(["finalization", "evaluation-report", "replay"]); const allowedCategories = new Set(["contract", "stale-qa", "revision-mismatch", "io", "evaluation"]);
  const category = allowedCategories.has(error?.category) ? error.category : "evaluation";
  return Object.freeze({ status: "failed", stage: allowedStages.has(stage) ? stage : "finalization", category,
    code: typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(error.code) ? error.code : null });
}
