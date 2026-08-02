import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalGuidanceInterpreter } from "../../src/m5c/guidance-interpreter.mjs";
import { FlowPlanService } from "../../src/m5c/flow-plan-service.mjs";
import { PlanDependencyService } from "../../src/m5c/plan-dependency-service.mjs";
import { M5CPlannerExecutor } from "../../src/m5c/planner-executor.mjs";
import { setup, sha, timestamp } from "../m5c-1/helpers.mjs";

const user = { type: "user", id: "fixture-user" };
const system = { type: "system", id: "fixture-system" };

test("local natural-language interpretation produces a reviewable diff and fails closed on vague authorization", () => {
  const segmentId = randomUUID(); const interpreter = new LocalGuidanceInterpreter();
  const explicit = interpreter.interpret("当前段必须把 Nikon 译为尼康并重译", { segmentId });
  assert.deepEqual(explicit.affectedSegmentIds, [segmentId]); assert.equal(explicit.scope, "segment");
  assert.equal(explicit.instructionType, "hard-constraint"); assert.equal(explicit.action, "retranslation");
  assert.equal(explicit.stateDiff.mutatesState, false); assert.deepEqual(explicit.ambiguities, []);
  const vague = interpreter.interpret("不限量，继续吧");
  assert.ok(vague.ambiguities.includes("unbounded-budget-forbidden"));
  assert.ok(vague.ambiguities.includes("intent-too-vague"));
});

test("confirmed guidance remains a separate user decision and interpretation alone changes no flow state", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-guidance-")); const fixture = setup(join(root, "app.sqlite3"));
  try {
    const service = new FlowPlanService(fixture.database, fixture.workspaceId);
    service.create({ workflowId: fixture.workflowId, documentId: fixture.documentId, sourceRevisionId: fixture.sourceRevisionId, targetLanguage: "zh-CN" }, user);
    const segmentId = fixture.database.prepare("SELECT segment_id AS segmentId FROM source_segment_versions WHERE workspace_id = ? AND source_revision_id = ? ORDER BY ordinal LIMIT 1")
      .get(fixture.workspaceId, fixture.sourceRevisionId).segmentId;
    const proposed = service.interpretGuidance(fixture.workflowId, "当前段建议译为尼康", { segmentId }, system);
    assert.equal(service.get(fixture.workflowId).flow.flowState, "planning"); assert.equal(proposed.state, "pending-user");
    const confirmed = service.decideGuidance(proposed.guidance.guidanceId, proposed.version, "confirmed", user);
    assert.equal(confirmed.state, "confirmed"); assert.equal(service.get(fixture.workflowId).flow.flowState, "planning");
  } finally { fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});

test("plan stale propagates only from actually bound segment revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-stale-")); const fixture = setup(join(root, "app.sqlite3"));
  try {
    const plans = new FlowPlanService(fixture.database, fixture.workspaceId);
    const created = plans.create({ workflowId: fixture.workflowId, documentId: fixture.documentId, sourceRevisionId: fixture.sourceRevisionId, targetLanguage: "zh-CN" }, user);
    const dependencies = new PlanDependencyService(fixture.database, fixture.workspaceId);
    assert.equal(dependencies.evaluate(fixture.workflowId).current, true);
    const original = fixture.database.prepare("SELECT * FROM source_segment_versions WHERE workspace_id = ? AND source_revision_id = ? ORDER BY ordinal")
      .all(fixture.workspaceId, fixture.sourceRevisionId);
    const nextRevisionId = randomUUID(); fixture.database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)")
      .run(fixture.workspaceId, nextRevisionId, fixture.documentId, sha("raw-2"), sha("normalized-2"), timestamp);
    for (const [index, row] of original.entries()) fixture.database.prepare("INSERT INTO source_segment_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(fixture.workspaceId, fixture.documentId, nextRevisionId, row.segment_id, row.kind, row.structural_path,
        index === 0 ? `${row.source_text} changed` : row.source_text, index === 0 ? sha(`${row.source_text} changed`) : row.source_digest,
        row.ordinal, row.translatable, row.protected_json, index === 0 ? "changed" : "unchanged");
    const evaluated = dependencies.evaluate(fixture.workflowId);
    assert.equal(evaluated.current, false); assert.ok(evaluated.staleItemIds.length > 0);
    const allItems = created.plan.items.map((item) => item.itemId);
    assert.ok(evaluated.staleItemIds.length < allItems.length, "unaffected plan items remain current");
    const marked = dependencies.markStale(fixture.workflowId, created.planHead.version);
    assert.equal(marked.changed, true); assert.equal(plans.get(fixture.workflowId).planHead.state, "stale");
  } finally { fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});

test("model-assisted planning is budgeted while disabled or failed planning keeps the mandatory local Plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-planner-")); const fixture = setup(join(root, "app.sqlite3"));
  try {
    const plans = new FlowPlanService(fixture.database, fixture.workspaceId); const local = plans.create({ workflowId: fixture.workflowId,
      documentId: fixture.documentId, sourceRevisionId: fixture.sourceRevisionId, targetLanguage: "zh-CN" }, user);
    const executor = new M5CPlannerExecutor(fixture.database, fixture.workspaceId, { plans, invokePlanner: async () => ({ responseId: "planner-fixture",
      items: local.plan.items, researchScope: local.plan.researchScope, qaProfile: local.plan.qaProfile,
      usage: { calls: 1, inputTokens: 100, outputTokens: 20, costMicrosCny: 100, costMicrosUsd: 0, durationMs: 10 } }) });
    const assisted = await executor.execute(fixture.workflowId, { providerId: "fixture-planner", modelId: "fixture-model", idempotencyKey: "planner-one",
      estimatedUsage: { calls: 1, inputTokens: 200, outputTokens: 50, costMicrosCny: 200, costMicrosUsd: 0, durationMs: 50 } });
    assert.equal(assisted.status, "model-assisted"); assert.equal(assisted.plan.plan.plannerMode, "model-assisted"); assert.equal(assisted.plan.plan.revision, 2);

    const disabledId = randomUUID(); const disabled = plans.create({ workflowId: disabledId, documentId: fixture.documentId,
      sourceRevisionId: fixture.sourceRevisionId, targetLanguage: "ja", plannerEnabled: false }, user);
    let calls = 0; const disabledExecutor = new M5CPlannerExecutor(fixture.database, fixture.workspaceId, { plans,
      invokePlanner: async () => { calls += 1; throw new Error("must not run"); } });
    const fallback = await disabledExecutor.execute(disabledId, { providerId: "fixture-planner", modelId: "fixture-model", idempotencyKey: "disabled",
      estimatedUsage: { calls: 1, inputTokens: 1, outputTokens: 1, costMicrosCny: 0, costMicrosUsd: 0, durationMs: 1 } });
    assert.equal(fallback.status, "local-only"); assert.equal(fallback.plan.plan.planRevisionId, disabled.plan.planRevisionId); assert.equal(calls, 0);

    const unknownId = randomUUID(); plans.create({ workflowId: unknownId, documentId: fixture.documentId,
      sourceRevisionId: fixture.sourceRevisionId, targetLanguage: "en" }, user);
    const uncertain = new M5CPlannerExecutor(fixture.database, fixture.workspaceId, { plans,
      invokePlanner: async () => { throw Object.assign(new Error("bounded malformed fixture"), { category: "malformed-response" }); } });
    const paused = await uncertain.execute(unknownId, { providerId: "fixture-planner", modelId: "fixture-model", idempotencyKey: "unknown",
      estimatedUsage: { calls: 1, inputTokens: 10, outputTokens: 10, costMicrosCny: 10, costMicrosUsd: 0, durationMs: 10 } });
    assert.equal(paused.status, "paused-unknown"); assert.deepEqual(plans.get(unknownId).flow,
      { workflowId: unknownId, flowState: "paused", outcomeState: "unknown", pauseReason: "planner-unknown-outcome",
        plannerEnabled: 1, version: 1, qaCycles: 0, researchCycles: 0, retranslationCount: 0 });

    const malformedId = randomUUID(); const malformedLocal = plans.create({ workflowId: malformedId, documentId: fixture.documentId,
      sourceRevisionId: fixture.sourceRevisionId, targetLanguage: "ko" }, user);
    const malformed = new M5CPlannerExecutor(fixture.database, fixture.workspaceId, { plans,
      invokePlanner: async () => ({ responseId: "planner-malformed", items: malformedLocal.plan.items,
        researchScope: malformedLocal.plan.researchScope, qaProfile: malformedLocal.plan.qaProfile,
        usage: { calls: "one" } }) });
    const malformedResult = await malformed.execute(malformedId, { providerId: "fixture-planner", modelId: "fixture-model", idempotencyKey: "malformed-usage",
      estimatedUsage: { calls: 1, inputTokens: 10, outputTokens: 10, costMicrosCny: 10, costMicrosUsd: 0, durationMs: 10 } });
    assert.equal(malformedResult.status, "paused-unknown"); assert.equal(malformedResult.category, "malformed-response");
    assert.equal(plans.get(malformedId).plan.revision, 1, "a malformed response cannot partly revise the Plan");
    assert.deepEqual(fixture.database.prepare("SELECT entry_type AS entryType FROM flow_budget_ledger WHERE workspace_id = ? AND workflow_id = ? AND reservation_id = 'planner:malformed-usage' ORDER BY rowid")
      .all(fixture.workspaceId, malformedId).map((row) => row.entryType), ["reserved", "unknown"]);
  } finally { fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});
