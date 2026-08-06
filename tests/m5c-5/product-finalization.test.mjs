import assert from "node:assert/strict";
import test from "node:test";
import { createQaEvaluationReport, DEFAULT_QA_MODE, finalizeProductRevision, qaMode, safeFinalizationFailure } from "../../src/m5c/finalization.mjs";

const zero = Object.freeze({ calls: 0, inputTokens: 0, outputTokens: 0, costMicrosCny: 0, costMicrosUsd: 0, durationMs: 0 });
const run = (mode, id = mode, targetRevisionId = "target-1") => ({ mode, qaRunId: `qa-${id}`, workflowId: "flow-1", targetRevisionId,
  status: "completed", current: true, model: { thinking: mode }, findings: [], usage: zero });
const validation = Object.freeze({ validationRunId: "validator-1", findings: [] });

test("product finalization defaults to one enabled current QA run", () => {
  assert.equal(DEFAULT_QA_MODE, "enabled");
  const artifact = finalizeProductRevision({ workflowId: "flow-1", qaRun: run("enabled"), workingCopyDigest: "sha256:working", validation,
    flowBudgetUsage: zero, qaUsage: zero });
  assert.equal(artifact.selectedQaMode, "enabled"); assert.equal(artifact.requiredQaRunId, "qa-enabled");
  assert.equal(artifact.status, "completed-awaiting-user-disposition"); assert.equal("runs" in artifact, false);
});

test("an explicitly disabled product uses only its disabled QA run", () => {
  const artifact = finalizeProductRevision({ workflowId: "flow-1", qaMode: "disabled", qaRun: run("disabled"), workingCopyDigest: "sha256:working",
    validation, flowBudgetUsage: zero, qaUsage: zero });
  assert.equal(artifact.selectedQaMode, "disabled"); assert.equal(artifact.requiredQaRunId, "qa-disabled");
  assert.throws(() => finalizeProductRevision({ workflowId: "flow-1", qaMode: "disabled", qaRun: run("enabled"), workingCopyDigest: "digest",
    validation, flowBudgetUsage: zero, qaUsage: zero }), /does not match/);
  assert.throws(() => qaMode("both"), /disabled or enabled/);
});

test("paired QA is an independent evaluation report and never a product requirement", () => {
  const report = createQaEvaluationReport([run("enabled"), run("disabled")]);
  assert.equal(report.scope, "evaluation-only"); assert.equal(report.productFinalizationRequired, false); assert.equal(report.runs.length, 2);
  assert.throws(() => createQaEvaluationReport([run("enabled"), run("disabled", "disabled", "target-2")]), /same target revision/);
});

test("finalization rejects stale runs and failure classification never includes error text", () => {
  assert.throws(() => finalizeProductRevision({ workflowId: "flow-1", qaRun: { ...run("enabled"), current: false }, workingCopyDigest: "digest",
    validation, flowBudgetUsage: zero, qaUsage: zero }), /current completed/);
  const failure = safeFinalizationFailure(Object.assign(new Error("private article正文"), { category: "revision-mismatch", code: "REVISION_MISMATCH" }), "replay");
  assert.deepEqual(failure, { status: "failed", stage: "replay", category: "revision-mismatch", code: "REVISION_MISMATCH" });
  assert.equal(JSON.stringify(failure).includes("正文"), false);
});
