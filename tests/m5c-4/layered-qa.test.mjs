import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FlowPlanService } from "../../src/m5c/flow-plan-service.mjs";
import { M5CQAConflictError, M5CQAService } from "../../src/m5c/qa-service.mjs";
import { TemporaryContextService } from "../../src/m5c/temporary-context-service.mjs";
import { M5CRemediationService, RemediationConflictError } from "../../src/m5c/remediation-service.mjs";
import { M5CModelQAExecutor } from "../../src/m5c/model-qa-executor.mjs";
import { FlowRecoveryConflictError, FlowRecoveryService } from "../../src/m5c/flow-recovery-service.mjs";
import { TranslationFlowBudgetService } from "../../src/m5c/flow-budget-service.mjs";
import { WorkCopyService } from "../../src/translation/work-copy-service.mjs";
import { TranslationExecutor } from "../../src/provider/translation-executor.mjs";
import { PricingBudgetService } from "../../src/provider/cost-budget.mjs";
import { providerResponseContract } from "../../src/provider/contracts.mjs";
import { ValidationService } from "../../src/translation/validator.mjs";
import { ReviewService } from "../../src/translation/review-service.mjs";
import { ExportService } from "../../src/export/export-service.mjs";
import { setup } from "../m5c-1/helpers.mjs";
import { workspace as applicationWorkspace } from "../m3-4/helpers.mjs";

const user = { type: "user", id: "fixture-user" }; const system = { type: "system", id: "fixture-system" };

function ready(fixture) {
  const plans = new FlowPlanService(fixture.database, fixture.workspaceId); let plan = plans.create({ workflowId: fixture.workflowId, documentId: fixture.documentId,
    sourceRevisionId: fixture.sourceRevisionId, targetLanguage: "zh-CN" }, user); plan = plans.submitPlan(fixture.workflowId, plan.planHead.version, system);
  plans.decidePlan(fixture.workflowId, plan.planHead.version, "approved", user);
  const contexts = new TemporaryContextService(fixture.database, fixture.workspaceId); let context = contexts.assemble(fixture.workflowId, {}, system);
  contexts.decide(fixture.workflowId, context.head.version, "approved", user);
  const copies = new WorkCopyService(fixture.database, fixture.workspaceId);
  const segments = copies.getBundle(fixture.workflowId).segments;
  const targets = ["尼康3组镜头不是2组。", "2026年8月3日"];
  for (const [index, segment] of segments.entries()) {
    const candidate = copies.addCandidate(fixture.workflowId, segment.segmentId, targets[index], { type: "fixture", id: "machine-fixture" });
    copies.selectCandidate(fixture.workflowId, segment.segmentId, candidate.candidateId, null, user);
  }
  return copies;
}

test("layered QA catches measurement category changes and a blocking invariant cannot be accepted", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-qa-")); const fixture = setup(join(root, "app.sqlite3"));
  try {
    const copies = ready(fixture); const qa = new M5CQAService(fixture.database, fixture.workspaceId, { workCopies: copies });
    const run = qa.run(fixture.workflowId, { layers: ["invariant", "heuristic", "model"], scope: "full",
      modelFindings: [{ segmentId: copies.getBundle(fixture.workflowId).segments[0].segmentId, severity: "warning", code: "subject-risk", details: { confidence: "low" } }], model: { provider: "fixture-independent-qa" } });
    const invariant = run.findings.find((finding) => finding.code === "measurement-category-changed"); assert.ok(invariant); assert.equal(invariant.blocking, true);
    assert.throws(() => qa.decideFinding(run.qaRunId, invariant.findingId, "accept-issue", user), /cannot be accepted/);
    assert.throws(() => qa.assertEligible(fixture.workflowId, run.qaRunId), M5CQAConflictError);
  } finally { fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});

test("editing a bound segment automatically stales QA and final deterministic QA binds the new target revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-final-qa-")); const fixture = setup(join(root, "app.sqlite3"));
  try {
    const copies = ready(fixture); const qa = new M5CQAService(fixture.database, fixture.workspaceId, { workCopies: copies });
    const first = qa.run(fixture.workflowId, { layers: ["invariant"], scope: "full" }); const segment = copies.getBundle(fixture.workflowId).segments[0];
    copies.edit(fixture.workflowId, segment.segmentId, segment.version, "尼康三片镜头不是2组。", user);
    assert.equal(qa.get(first.qaRunId).current, false); assert.throws(() => qa.assertEligible(fixture.workflowId, first.qaRunId), /current completed/);
    const finalRun = qa.run(fixture.workflowId, { layers: ["invariant"], scope: "deterministic-final" });
    assert.equal(finalRun.findings.filter((finding) => finding.severity === "error").length, 0);
    assert.equal(qa.assertEligible(fixture.workflowId, finalRun.qaRunId).targetRevisionId, finalRun.targetRevisionId);
    assert.notEqual(finalRun.targetRevisionId, first.targetRevisionId);
  } finally { fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});

test("model and heuristic findings require explicit user disposition but may be accepted without upgrading them to facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-qa-decision-")); const fixture = setup(join(root, "app.sqlite3"));
  try {
    const copies = ready(fixture); const segment = copies.getBundle(fixture.workflowId).segments[0];
    copies.edit(fixture.workflowId, segment.segmentId, segment.version, "尼康3片镜头是2组。", user);
    const qa = new M5CQAService(fixture.database, fixture.workspaceId, { workCopies: copies });
    let run = qa.run(fixture.workflowId, { layers: ["invariant", "heuristic", "model"], modelFindings: [{ segmentId: segment.segmentId,
      severity: "error", code: "subject-object-risk", details: { source: "fixture" } }] });
    for (const finding of run.findings) if (finding.layer !== "invariant") run = qa.decideFinding(run.qaRunId, finding.findingId, "accept-issue", user);
    assert.equal(qa.assertEligible(fixture.workflowId, run.qaRunId).current, true);
  } finally { fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});

test("local retranslation is segment-scoped idempotent and stops at the article limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-retranslation-")); const fixture = setup(join(root, "app.sqlite3"));
  try {
    const copies = ready(fixture); const qa = new M5CQAService(fixture.database, fixture.workspaceId, { workCopies: copies }); const segment = copies.getBundle(fixture.workflowId).segments[0];
    let run = qa.run(fixture.workflowId, { layers: ["invariant", "model"], modelFindings: [{ segmentId: segment.segmentId, severity: "error", code: "relation-risk", details: {} }] });
    const finding = run.findings.find((item) => item.layer === "model"); run = qa.decideFinding(run.qaRunId, finding.findingId, "retranslate", user);
    const remediation = new M5CRemediationService(fixture.database, fixture.workspaceId);
    const request = { providerId: "deepseek", modelId: "deepseek-chat", idempotencyKey: "retry-one", estimatedUsage: { calls: 1, inputTokens: 100, outputTokens: 100, costMicrosCny: 100, costMicrosUsd: 0, durationMs: 100 } };
    const first = remediation.retranslate(run.qaRunId, [finding.findingId], request, user); assert.equal(first.task.attempts.length, 1); assert.equal(first.reused, false);
    assert.equal(remediation.retranslate(run.qaRunId, [finding.findingId], request, user).reused, true);
    fixture.database.prepare("UPDATE translation_flow_controls SET retranslation_count = 8 WHERE workspace_id = ? AND workflow_id = ?").run(fixture.workspaceId, fixture.workflowId);
    assert.throws(() => remediation.retranslate(run.qaRunId, [finding.findingId], { ...request, idempotencyKey: "retry-two" }, user), RemediationConflictError);
  } finally { fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});

test("controlled model QA binds a bounded request and settles the article QA budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-model-qa-")); const fixture = setup(join(root, "app.sqlite3"));
  try {
    const copies = ready(fixture); const segment = copies.getBundle(fixture.workflowId).segments[0]; let captured;
    const executor = new M5CModelQAExecutor(fixture.database, fixture.workspaceId, { workCopies: copies,
      invokeModelQa: async (request) => { captured = request; return { responseId: "fixture-response-1",
        findings: [{ segmentId: segment.segmentId, severity: "warning", code: "relation-risk", details: { reason: "fixture" } }],
        usage: { calls: 1, inputTokens: 200, outputTokens: 30, costMicrosCny: 500, costMicrosUsd: 0, durationMs: 25 } }; } });
    const result = await executor.execute(fixture.workflowId, { providerId: "fixture-qa", modelId: "fixture-model", idempotencyKey: "qa-one",
      estimatedUsage: { calls: 1, inputTokens: 500, outputTokens: 100, costMicrosCny: 1_000, costMicrosUsd: 0, durationMs: 100 } });
    assert.equal(captured.schemaVersion, "m5c-model-qa-request-v1"); assert.equal(captured.workingCopyDigest, copies.getBundle(fixture.workflowId).digest);
    assert.ok(result.run.findings.some((finding) => finding.code === "relation-risk" && finding.layer === "model"));
    const entries = fixture.database.prepare("SELECT entry_type AS entryType FROM flow_budget_ledger WHERE workspace_id = ? AND workflow_id = ? AND reservation_id = 'qa:qa-one' ORDER BY entry_type")
      .all(fixture.workspaceId, fixture.workflowId).map((row) => row.entryType).sort();
    assert.deepEqual(entries, ["reserved", "settled"]);
  } finally { fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});

test("a malformed model QA result is conservatively unknown and atomically pauses the article", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-model-qa-unknown-")); const fixture = setup(join(root, "app.sqlite3"));
  try {
    const copies = ready(fixture); const executor = new M5CModelQAExecutor(fixture.database, fixture.workspaceId, { workCopies: copies,
      invokeModelQa: async () => ({ responseId: "malformed-finding", findings: [{ segmentId: "outside-scope", severity: "error", code: "bad", details: {} }],
        usage: { calls: 1, inputTokens: 20, outputTokens: 5, costMicrosCny: 25, costMicrosUsd: 0, durationMs: 10 } }) });
    await assert.rejects(() => executor.execute(fixture.workflowId, { providerId: "fixture-qa", modelId: "fixture-model", idempotencyKey: "qa-unknown",
      estimatedUsage: { calls: 1, inputTokens: 100, outputTokens: 20, costMicrosCny: 100, costMicrosUsd: 0, durationMs: 20 } }),
    (error) => error.category === "malformed-response");
    assert.deepEqual(fixture.database.prepare(`SELECT flow_state AS flowState, outcome_state AS outcomeState, pause_reason AS pauseReason
      FROM translation_flow_controls WHERE workspace_id = ? AND workflow_id = ?`).get(fixture.workspaceId, fixture.workflowId),
    { flowState: "paused", outcomeState: "unknown", pauseReason: "qa-unknown-outcome" });
    assert.deepEqual(fixture.database.prepare("SELECT entry_type AS entryType FROM flow_budget_ledger WHERE workspace_id = ? AND workflow_id = ? AND reservation_id = 'qa:qa-unknown' ORDER BY rowid")
      .all(fixture.workspaceId, fixture.workflowId).map((row) => row.entryType), ["reserved", "unknown"]);
  } finally { fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});

test("a user-expanded unknown stop line permits an explicit model QA retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-model-qa-retry-")); const fixture = setup(join(root, "app.sqlite3"));
  try {
    const copies = ready(fixture); let calls = 0;
    const executor = new M5CModelQAExecutor(fixture.database, fixture.workspaceId, { workCopies: copies,
      invokeModelQa: async () => { calls += 1; if (calls === 1) throw Object.assign(new Error("private timeout"), { category: "timeout" });
        return { responseId: "fixture-response-retry", findings: [],
          usage: { calls: 1, inputTokens: 20, outputTokens: 5, costMicrosCny: 25, costMicrosUsd: 0, durationMs: 10 } }; } });
    const request = { providerId: "fixture-qa", modelId: "fixture-model", idempotencyKey: "qa-first",
      estimatedUsage: { calls: 1, inputTokens: 100, outputTokens: 20, costMicrosCny: 100, costMicrosUsd: 0, durationMs: 20 } };
    await assert.rejects(() => executor.execute(fixture.workflowId, request), (error) => error.category === "timeout");
    const paused = fixture.database.prepare("SELECT version FROM translation_flow_controls WHERE workspace_id = ? AND workflow_id = ?")
      .get(fixture.workspaceId, fixture.workflowId);
    const budgets = new TranslationFlowBudgetService(fixture.database, fixture.workspaceId); const current = budgets.get(fixture.workflowId);
    const { schemaVersion: _schemaVersion, workflowId: _workflowId, revision: _revision, authorizedBy: _authorizedBy,
      createdAt: _createdAt, ...limits } = current.policy;
    budgets.expand(fixture.workflowId, current.version, { ...limits, maxUnknownOutcomes: 2,
      categories: Object.fromEntries(Object.entries(limits.categories).map(([key, value]) => [key, { ...value }])) }, user);
    const recovery = new FlowRecoveryService(fixture.database, fixture.workspaceId);
    assert.deepEqual(recovery.resolve(fixture.workflowId, paused.version, "retry", null, user), {
      workflowId: fixture.workflowId, action: "retry", previousPauseReason: "qa-unknown-outcome", flowState: "qa", outcomeState: "none" });
    const retried = await executor.execute(fixture.workflowId, { ...request, idempotencyKey: "qa-user-retry" });
    assert.equal(typeof retried.run.qaRunId, "string"); assert.equal(calls, 2);
    assert.deepEqual(fixture.database.prepare("SELECT entry_type AS entryType FROM flow_budget_ledger WHERE workspace_id = ? AND workflow_id = ? AND reservation_id = 'qa:qa-user-retry' ORDER BY rowid")
      .all(fixture.workspaceId, fixture.workflowId).map((row) => row.entryType), ["reserved", "settled"]);
  } finally { fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});

test("flow termination is user-only immutable idempotent and cancels active work", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-terminate-")); const fixture = setup(join(root, "app.sqlite3"));
  try {
    const copies = ready(fixture); const contexts = new TemporaryContextService(fixture.database, fixture.workspaceId);
    const queued = contexts.enqueueTranslation(fixture.workflowId, { providerId: "fixture-provider", modelId: "fixture-model",
      idempotencyKey: "terminate-active", estimatedUsage: {
        calls: 2, inputTokens: 100, outputTokens: 20, costMicrosCny: 100, costMicrosUsd: 0, durationMs: 20 } });
    const executor = new M5CModelQAExecutor(fixture.database, fixture.workspaceId, { workCopies: copies,
      invokeModelQa: async () => { throw Object.assign(new Error("private disconnect"), { category: "unknown-outcome" }); } });
    await assert.rejects(() => executor.execute(fixture.workflowId, { providerId: "fixture-qa", modelId: "fixture-model", idempotencyKey: "qa-terminate",
      estimatedUsage: { calls: 1, inputTokens: 100, outputTokens: 20, costMicrosCny: 100, costMicrosUsd: 0, durationMs: 20 } }));
    const paused = fixture.database.prepare("SELECT version FROM translation_flow_controls WHERE workspace_id = ? AND workflow_id = ?")
      .get(fixture.workspaceId, fixture.workflowId);
    const recovery = new FlowRecoveryService(fixture.database, fixture.workspaceId);
    assert.throws(() => recovery.resolve(fixture.workflowId, paused.version, "terminate", null, system), FlowRecoveryConflictError);
    const terminated = recovery.resolve(fixture.workflowId, paused.version, "terminate", null, user);
    assert.deepEqual(recovery.resolve(fixture.workflowId, paused.version, "terminate", null, user), terminated);
    assert.throws(() => recovery.resolve(fixture.workflowId, paused.version, "retry", null, user), /idempotency conflict/);
    assert.equal(terminated.flowState, "canceled"); assert.equal(terminated.outcomeState, "failed");
    assert.equal(fixture.database.prepare("SELECT state FROM translation_tasks WHERE workspace_id = ? AND task_id = ?")
      .get(fixture.workspaceId, queued.task.task.task_id).state, "canceled");
    assert.equal(fixture.database.prepare("SELECT count(*) AS count FROM translation_flow_recovery_decisions WHERE workspace_id = ? AND workflow_id = ?")
      .get(fixture.workspaceId, fixture.workflowId).count, 1);
  } finally { fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});

test("machine translation settles FlowBudget and final target revision QA gates review and export", async () => {
  const fixture = await applicationWorkspace("lectoria-m5c-complete-flow-"); const root = fixture.root;
  try {
    const imported = await fixture.imports.import({ format: "text", content: "Nikon 3枚 lens is not 2组.\n\n2026年8月3日", title: "M5C complete flow" });
    fixture.imports.confirm(imported.importId, user); const workflowId = randomUUID();
    const plans = new FlowPlanService(fixture.database, fixture.workspaceId); let plan = plans.create({ workflowId,
      documentId: imported.documentId, sourceRevisionId: imported.sourceRevisionId, targetLanguage: "zh-CN" }, user);
    plan = plans.submitPlan(workflowId, plan.planHead.version, system); plans.decidePlan(workflowId, plan.planHead.version, "approved", user);
    const contexts = new TemporaryContextService(fixture.database, fixture.workspaceId); let context = contexts.assemble(workflowId, {}, system);
    context = contexts.decide(workflowId, context.head.version, "approved", user);
    const queued = contexts.enqueueTranslation(workflowId, { providerId: "fixture-provider", modelId: "fixture-model",
      policyVersion: "m5c-provider-budget", idempotencyKey: "complete-flow", estimatedUsage: {
        calls: 2, inputTokens: 10_000, outputTokens: 2_048, costMicrosCny: 50_000, costMicrosUsd: 0, durationMs: 10_000 } });
    const pricing = new PricingBudgetService(fixture.database, fixture.workspaceId);
    pricing.addPricing({ providerId: "fixture-provider", modelId: "fixture-model", pricingVersion: "fixture-cny", currency: "CNY",
      inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, cachedInputMicrosPerMillion: 0, source: "offline-fixture" });
    pricing.addPolicy({ policyVersion: "m5c-provider-budget", currency: "CNY", softLimitMicros: 100_000, hardLimitMicros: 200_000, unknownPriceAction: "block" });
    pricing.assignTask(queued.task.task.task_id, "m5c-provider-budget");
    const executor = new TranslationExecutor(fixture.database, fixture.workspaceId, { budgets: pricing, pricingVersion: "fixture-cny",
      credentialRef: "fixture:m5c", invokeProvider: async (request) => providerResponseContract({ responseId: `response-${request.attemptId}`,
        providerId: request.providerId, modelId: request.modelId,
        candidates: request.segments.map((segment) => ({ segmentId: segment.segmentId, text: segment.sourceText })),
        usage: { inputTokens: 20, outputTokens: 10, cachedInputTokens: 0, totalTokens: 30 } }, request) });
    assert.equal((await executor.executeNext()).status, "completed"); assert.equal((await executor.executeNext()).status, "completed");
    const flowLedger = fixture.database.prepare("SELECT entry_type AS entryType FROM flow_budget_ledger WHERE workspace_id = ? AND workflow_id = ? AND reservation_id = 'translation:complete-flow' ORDER BY entry_type")
      .all(fixture.workspaceId, workflowId).map((row) => row.entryType).sort();
    assert.deepEqual(flowLedger, ["reserved", "settled"]);
    const copies = new WorkCopyService(fixture.database, fixture.workspaceId); const bundle = copies.getBundle(workflowId);
    for (const segment of bundle.segments) {
      const candidate = copies.listCandidates(workflowId, segment.segmentId).find((item) => item.sourceType === "machine"); assert.ok(candidate);
      copies.selectCandidate(workflowId, segment.segmentId, candidate.candidateId, null, user);
    }
    const validationService = new ValidationService(fixture.database, fixture.workspaceId, { workCopies: copies });
    const validation = validationService.run(workflowId);
    assert.deepEqual(validation.findings.filter((item) => item.severity === "error"), []);
    const qa = new M5CQAService(fixture.database, fixture.workspaceId, { workCopies: copies });
    const finalQa = qa.run(workflowId, { layers: ["invariant", "heuristic"], scope: "full" });
    for (const finding of finalQa.findings.filter((item) => item.severity === "warning")) qa.decideFinding(finalQa.qaRunId, finding.findingId, "accept-issue", user);
    assert.equal(qa.assertEligible(workflowId, finalQa.qaRunId).targetRevisionId, finalQa.targetRevisionId);
    const reviews = new ReviewService(fixture.database, fixture.workspaceId, { validation: validationService, quality: qa });
    let workflow = fixture.database.prepare("SELECT version FROM translation_workflows WHERE workspace_id = ? AND workflow_id = ?").get(fixture.workspaceId, workflowId);
    workflow = reviews.humanReview(workflowId, validation.validationRunId, workflow.version, user, finalQa.qaRunId);
    workflow = reviews.approve(workflowId, validation.validationRunId, workflow.version, user, finalQa.qaRunId);
    const exports = new ExportService({ database: fixture.database, root, trustedWorkspaceId: fixture.workspaceId,
      workCopies: copies, validation: validationService, quality: qa });
    const output = await exports.export(workflowId, validation.validationRunId, "text", finalQa.qaRunId);
    assert.equal(output.manifest.artifact_format, "text");
    assert.equal(fixture.database.prepare("SELECT flow_state AS flowState FROM translation_flow_controls WHERE workspace_id = ? AND workflow_id = ?").get(fixture.workspaceId, workflowId).flowState, "disposition");
  } finally { await fixture.close(); }
});

test("a malformed translation response after provider handoff is conservatively unknown and pauses every remaining segment", async () => {
  const fixture = await applicationWorkspace("lectoria-m5c-unknown-flow-");
  try {
    const imported = await fixture.imports.import({ format: "text", content: "First public segment.\n\nSecond public segment.", title: "M5C unknown flow" });
    fixture.imports.confirm(imported.importId, user); const workflowId = randomUUID();
    const plans = new FlowPlanService(fixture.database, fixture.workspaceId); let plan = plans.create({ workflowId,
      documentId: imported.documentId, sourceRevisionId: imported.sourceRevisionId, targetLanguage: "zh-CN" }, user);
    plan = plans.submitPlan(workflowId, plan.planHead.version, system); plans.decidePlan(workflowId, plan.planHead.version, "approved", user);
    const contexts = new TemporaryContextService(fixture.database, fixture.workspaceId); let context = contexts.assemble(workflowId, {}, system);
    context = contexts.decide(workflowId, context.head.version, "approved", user);
    const queued = contexts.enqueueTranslation(workflowId, { providerId: "fixture-provider", modelId: "fixture-model",
      policyVersion: "m5c-unknown-provider-budget", idempotencyKey: "unknown-flow", estimatedUsage: {
        calls: 2, inputTokens: 10_000, outputTokens: 2_048, costMicrosCny: 50_000, costMicrosUsd: 0, durationMs: 10_000 } });
    const pricing = new PricingBudgetService(fixture.database, fixture.workspaceId);
    pricing.addPricing({ providerId: "fixture-provider", modelId: "fixture-model", pricingVersion: "fixture-cny", currency: "CNY",
      inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, cachedInputMicrosPerMillion: 0, source: "offline-fixture" });
    pricing.addPolicy({ policyVersion: "m5c-unknown-provider-budget", currency: "CNY", softLimitMicros: 100_000, hardLimitMicros: 200_000, unknownPriceAction: "block" });
    pricing.assignTask(queued.task.task.task_id, "m5c-unknown-provider-budget");
    let calls = 0; const executor = new TranslationExecutor(fixture.database, fixture.workspaceId, { budgets: pricing, pricingVersion: "fixture-cny",
      credentialRef: "fixture:m5c", invokeProvider: async () => { calls += 1; throw Object.assign(new Error("private malformed response"), { category: "malformed-response", retryable: false }); } });
    const result = await executor.executeNext(); assert.equal(result.status, "failed"); assert.equal(result.error.category, "malformed-response");
    assert.equal((await executor.executeNext()).status, "idle"); assert.equal(calls, 1);
    const control = fixture.database.prepare("SELECT flow_state AS flowState, outcome_state AS outcomeState, pause_reason AS pauseReason, version FROM translation_flow_controls WHERE workspace_id = ? AND workflow_id = ?")
      .get(fixture.workspaceId, workflowId);
    assert.deepEqual({ flowState: control.flowState, outcomeState: control.outcomeState, pauseReason: control.pauseReason },
      { flowState: "paused", outcomeState: "unknown", pauseReason: "translation-unknown-outcome" });
    const ledger = fixture.database.prepare("SELECT entry_type AS entryType FROM flow_budget_ledger WHERE workspace_id = ? AND workflow_id = ? AND reservation_id = 'translation:unknown-flow' ORDER BY rowid")
      .all(fixture.workspaceId, workflowId).map((row) => row.entryType);
    assert.deepEqual(ledger, ["reserved", "unknown"]);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM translation_candidates WHERE workspace_id = ? AND workflow_id = ?").get(fixture.workspaceId, workflowId).total, 0);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM budget_reservations WHERE workspace_id = ? AND state = 'reserved'").get(fixture.workspaceId).total, 0);

    const flowBudgets = new TranslationFlowBudgetService(fixture.database, fixture.workspaceId); const current = flowBudgets.get(workflowId);
    const { schemaVersion: _schemaVersion, workflowId: _workflowId, revision: _revision, authorizedBy: _authorizedBy,
      createdAt: _createdAt, ...limits } = current.policy;
    flowBudgets.expand(workflowId, current.version, { ...limits, maxUnknownOutcomes: 2,
      categories: Object.fromEntries(Object.entries(limits.categories).map(([key, value]) => [key, { ...value }])) }, user);
    const recovery = new FlowRecoveryService(fixture.database, fixture.workspaceId);
    const resumed = recovery.resolve(workflowId, control.version, "retry", { providerId: "fixture-provider", modelId: "fixture-model",
      policyVersion: "m5c-unknown-provider-budget", idempotencyKey: "unknown-flow-user-retry", estimatedUsage: {
        calls: 2, inputTokens: 10_000, outputTokens: 2_048, costMicrosCny: 50_000, costMicrosUsd: 0, durationMs: 10_000 } }, user);
    assert.equal(resumed.flowState, "translating"); assert.ok(resumed.taskId); pricing.assignTask(resumed.taskId, "m5c-unknown-provider-budget");
    const retryExecutor = new TranslationExecutor(fixture.database, fixture.workspaceId, { budgets: pricing, pricingVersion: "fixture-cny",
      credentialRef: "fixture:m5c", invokeProvider: async (request) => providerResponseContract({ responseId: `retry-${request.attemptId}`,
        providerId: request.providerId, modelId: request.modelId, candidates: request.segments.map((segment) => ({ segmentId: segment.segmentId, text: segment.sourceText })),
        usage: { inputTokens: 20, outputTokens: 10, cachedInputTokens: 0, totalTokens: 30 } }, request) });
    assert.equal((await retryExecutor.executeNext()).status, "completed"); assert.equal((await retryExecutor.executeNext()).status, "completed");
    assert.equal((await retryExecutor.executeNext()).status, "idle");
    assert.deepEqual(fixture.database.prepare("SELECT entry_type AS entryType FROM flow_budget_ledger WHERE workspace_id = ? AND workflow_id = ? AND reservation_id = 'translation:unknown-flow-user-retry' ORDER BY rowid")
      .all(fixture.workspaceId, workflowId).map((row) => row.entryType), ["reserved", "settled"]);
  } finally { await fixture.close(); }
});
