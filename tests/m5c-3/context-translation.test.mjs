import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDeepSeekRequest } from "../../src/provider/deepseek-provider.mjs";
import { buildContextManifest } from "../../src/provider/prompt-context.mjs";
import { FlowPlanService } from "../../src/m5c/flow-plan-service.mjs";
import { TemporaryContextConflictError, TemporaryContextService } from "../../src/m5c/temporary-context-service.mjs";
import { setup } from "../m5c-1/helpers.mjs";

const user = { type: "user", id: "fixture-user" }; const system = { type: "system", id: "fixture-system" };

function approvedPlan(fixture) {
  const plans = new FlowPlanService(fixture.database, fixture.workspaceId); let result = plans.create({ workflowId: fixture.workflowId,
    documentId: fixture.documentId, sourceRevisionId: fixture.sourceRevisionId, targetLanguage: "zh-CN" }, user);
  result = plans.submitPlan(fixture.workflowId, result.planHead.version, system);
  return plans.decidePlan(fixture.workflowId, result.planHead.version, "approved", user);
}

test("one user decision approves the exact temporary context revision and weak items stay non-affirmative", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-context-")); const fixture = setup(join(root, "app.sqlite3"));
  try {
    approvedPlan(fixture); const contexts = new TemporaryContextService(fixture.database, fixture.workspaceId);
    let context = contexts.assemble(fixture.workflowId, {}, system);
    assert.equal(context.head.state, "pending-user");
    assert.ok(context.context.items.some((item) => item.instructionType === "warning-only" && item.affirmative === false));
    assert.throws(() => contexts.decide(fixture.workflowId, context.head.version, "approved", system), TemporaryContextConflictError);
    context = contexts.decide(fixture.workflowId, context.head.version, "approved", user);
    assert.equal(context.head.state, "approved"); assert.equal(context.decision.decision, "approved");
    const weak = context.context.items.find((item) => item.instructionType === "warning-only");
    assert.throws(() => fixture.database.prepare("UPDATE temporary_context_items SET affirmative = 1 WHERE workspace_id = ? AND context_item_id = ?")
      .run(fixture.workspaceId, weak.contextItemId), /immutable|affirmative/);
  } finally { fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});

test("approved context is filtered per segment bound to every machine attempt and included in provider payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-translation-")); const fixture = setup(join(root, "app.sqlite3"));
  try {
    const plan = approvedPlan(fixture); const contexts = new TemporaryContextService(fixture.database, fixture.workspaceId);
    let context = contexts.assemble(fixture.workflowId, {}, system); context = contexts.decide(fixture.workflowId, context.head.version, "approved", user);
    const queued = contexts.enqueueTranslation(fixture.workflowId, { providerId: "deepseek", modelId: "deepseek-chat",
      idempotencyKey: "m5c-translation-1", estimatedUsage: { calls: 2, inputTokens: 10_000, outputTokens: 2_048, costMicrosCny: 1_000, costMicrosUsd: 0, durationMs: 60_000 } });
    assert.equal(queued.task.attempts.length, 2);
    const bindings = fixture.database.prepare("SELECT * FROM m5c_translation_attempt_bindings WHERE workspace_id = ? AND workflow_id = ?")
      .all(fixture.workspaceId, fixture.workflowId); assert.equal(bindings.length, 2);
    const attempt = queued.task.attempts[0]; const built = buildContextManifest(fixture.database, fixture.workspaceId, { workflowId: fixture.workflowId,
      segmentIds: [attempt.segment_id], temporaryContextRevisionId: context.context.contextRevisionId });
    assert.equal(built.contextDigest, attempt.context_digest); assert.ok(built.manifest.translationContext.items.length > 0);
    const request = { workspaceId: fixture.workspaceId, taskId: attempt.task_id, attemptId: attempt.attempt_id, workflowId: fixture.workflowId,
      sourceRevisionId: fixture.sourceRevisionId, targetLanguage: "zh-CN", providerId: "deepseek", modelId: "deepseek-chat", maxOutputTokens: 1_024,
      promptVersion: attempt.prompt_version, contextDigest: built.contextDigest,
      segments: built.manifest.segments.map((segment) => ({ segmentId: segment.segmentId, sourceDigest: segment.sourceDigest, sourceText: segment.sourceText, protected: segment.protected })),
      translationContext: built.manifest.translationContext };
    const outbound = buildDeepSeekRequest(request); const userPayload = JSON.parse(outbound.body.messages[1].content);
    assert.equal(userPayload.translationContext.contextRevisionId, context.context.contextRevisionId);
    assert.match(outbound.body.messages[0].content, /Disputed and warning-only items.*never be asserted/);
    assert.equal(plan.plan.planRevisionId, bindings[0].plan_revision_id);
  } finally { fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});

test("a multi-segment Plan item is projected to the owning Provider request segment", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-context-projection-")); const fixture = setup(join(root, "app.sqlite3"));
  try {
    const plans = new FlowPlanService(fixture.database, fixture.workspaceId); let plan = plans.create({ workflowId: fixture.workflowId,
      documentId: fixture.documentId, sourceRevisionId: fixture.sourceRevisionId, targetLanguage: "zh-CN" }, user);
    plan = plans.submitPlan(fixture.workflowId, plan.planHead.version, system); plan = plans.decidePlan(fixture.workflowId, plan.planHead.version, "approved", user);
    const segmentIds = fixture.database.prepare("SELECT segment_id AS segmentId FROM source_segment_versions WHERE workspace_id = ? AND source_revision_id = ? ORDER BY ordinal")
      .all(fixture.workspaceId, fixture.sourceRevisionId).map((item) => item.segmentId);
    plan = plans.reviseApprovedForKnowledgeNeed(fixture.workflowId, plan.planHead.version, { itemId: randomUUID(), kind: "relation",
      coverage: "covered", instructionType: "background", impact: "medium", segmentIds, dependencies: {}, content: { relation: "shared fixture" } }, system);
    plan = plans.submitPlan(fixture.workflowId, plan.planHead.version, system); plans.decidePlan(fixture.workflowId, plan.planHead.version, "approved", user);
    const contexts = new TemporaryContextService(fixture.database, fixture.workspaceId); let context = contexts.assemble(fixture.workflowId, {}, system);
    context = contexts.decide(fixture.workflowId, context.head.version, "approved", user); const built = buildContextManifest(fixture.database, fixture.workspaceId,
      { workflowId: fixture.workflowId, segmentIds: [segmentIds[0]], temporaryContextRevisionId: context.context.contextRevisionId });
    const scoped = built.manifest.translationContext.items.find((item) => item.content.relation === "shared fixture"); assert.ok(scoped);
    assert.deepEqual(scoped.segmentIds, [segmentIds[0]]);
    assert.doesNotThrow(() => buildDeepSeekRequest({ workspaceId: fixture.workspaceId, taskId: randomUUID(), attemptId: randomUUID(),
      workflowId: fixture.workflowId, sourceRevisionId: fixture.sourceRevisionId, targetLanguage: "zh-CN", providerId: "deepseek",
      modelId: "deepseek-chat", maxOutputTokens: 1_024, promptVersion: "lectoria-translation-v1", contextDigest: built.contextDigest,
      segments: built.manifest.segments.map((segment) => ({ segmentId: segment.segmentId, sourceDigest: segment.sourceDigest,
        sourceText: segment.sourceText, protected: segment.protected })), translationContext: built.manifest.translationContext }));
  } finally { fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});

test("missing context approval budget or binding prevents any provider lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-context-gate-")); const fixture = setup(join(root, "app.sqlite3"));
  try {
    approvedPlan(fixture); const contexts = new TemporaryContextService(fixture.database, fixture.workspaceId);
    const pending = contexts.assemble(fixture.workflowId, {}, system);
    assert.throws(() => contexts.enqueueTranslation(fixture.workflowId, { providerId: "deepseek", modelId: "deepseek-chat", idempotencyKey: "blocked" }), /approved ContextUseDecision/);
    assert.equal(fixture.database.prepare("SELECT count(*) AS count FROM translation_attempts WHERE workspace_id = ?").get(fixture.workspaceId).count, 0);
    assert.equal(pending.head.state, "pending-user");
  } finally { fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});
