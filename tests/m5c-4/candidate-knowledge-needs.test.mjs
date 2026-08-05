import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CandidateKnowledgeNeedService } from "../../src/m5c/candidate-knowledge-need-service.mjs";
import { FlowPlanService } from "../../src/m5c/flow-plan-service.mjs";
import { TemporaryContextService } from "../../src/m5c/temporary-context-service.mjs";
import { PricingBudgetService } from "../../src/provider/cost-budget.mjs";
import { providerResponseContract } from "../../src/provider/contracts.mjs";
import { TranslationExecutor } from "../../src/provider/translation-executor.mjs";
import { workspace as applicationWorkspace } from "../m3-4/helpers.mjs";

const user = { type: "user", id: "fixture-user" }; const system = { type: "system", id: "fixture-system" };
const sha = (value) => `sha256:${Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64)}`;

function providerFixture(segmentIds = [randomUUID()]) {
  const request = { workspaceId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), workflowId: randomUUID(),
    sourceRevisionId: randomUUID(), targetLanguage: "zh-CN", providerId: "fixture-provider", modelId: "fixture-model",
    maxOutputTokens: 2_048, promptVersion: "fixture-prompt", contextDigest: sha("context"),
    segments: segmentIds.map((segmentId, index) => ({ segmentId, sourceDigest: sha(`source-${index}`), sourceText: `source ${index}`, protected: [] })) };
  const response = { responseId: "fixture-response", providerId: request.providerId, modelId: request.modelId,
    candidates: segmentIds.map((segmentId) => ({ segmentId, text: "目标", knowledgeNeeds: [] })),
    usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, totalTokens: 15 } };
  return { request, response };
}

async function translatedFixture() {
  const fixture = await applicationWorkspace("lectoria-knowledge-needs-");
  const imported = await fixture.imports.import({ format: "text", content: "ぎょぎょっと20 uses a thick meniscus lens.\n\nThe design has 2 groups and 3 elements.", title: "knowledge needs" });
  fixture.imports.confirm(imported.importId, user); const workflowId = randomUUID(); const plans = new FlowPlanService(fixture.database, fixture.workspaceId);
  let plan = plans.create({ workflowId, documentId: imported.documentId, sourceRevisionId: imported.sourceRevisionId, targetLanguage: "zh-CN" }, user);
  plan = plans.submitPlan(workflowId, plan.planHead.version, system); plan = plans.decidePlan(workflowId, plan.planHead.version, "approved", user);
  const contexts = new TemporaryContextService(fixture.database, fixture.workspaceId); let context = contexts.assemble(workflowId, {}, system);
  context = contexts.decide(workflowId, context.head.version, "approved", user); const segmentId = context.context.items.flatMap((item) => item.segmentIds)[0]
    ?? fixture.database.prepare("SELECT segment_id AS segmentId FROM source_segment_versions WHERE workspace_id = ? AND source_revision_id = ? ORDER BY ordinal LIMIT 1").get(fixture.workspaceId, imported.sourceRevisionId).segmentId;
  const queued = contexts.enqueueTranslation(workflowId, { segmentIds: [segmentId], providerId: "fixture-provider", modelId: "fixture-model",
    policyVersion: "knowledge-needs-budget", idempotencyKey: "knowledge-needs", estimatedUsage: {
      calls: 1, inputTokens: 10_000, outputTokens: 2_048, costMicrosCny: 50_000, costMicrosUsd: 0, durationMs: 10_000 } });
  const pricing = new PricingBudgetService(fixture.database, fixture.workspaceId);
  pricing.addPricing({ providerId: "fixture-provider", modelId: "fixture-model", pricingVersion: "fixture-cny", currency: "CNY",
    inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, cachedInputMicrosPerMillion: 0, source: "offline-fixture" });
  pricing.addPolicy({ policyVersion: "knowledge-needs-budget", currency: "CNY", softLimitMicros: 100_000, hardLimitMicros: 200_000, unknownPriceAction: "block" });
  pricing.assignTask(queued.task.task.task_id, "knowledge-needs-budget");
  const executor = new TranslationExecutor(fixture.database, fixture.workspaceId, { budgets: pricing, pricingVersion: "fixture-cny", credentialRef: "fixture:m5c",
    invokeProvider: async (request) => providerResponseContract({ responseId: "response-knowledge-needs", providerId: request.providerId, modelId: request.modelId,
      candidates: request.segments.map((segment) => ({ segmentId: segment.segmentId, text: "鱼眼镜头使用厚弯月形镜片。", knowledgeNeeds: [{
        kind: "term", impact: "high", question: "ぎょぎょっと20 的官方中文产品称呼是什么？", relatedSegmentIds: [segment.segmentId] }] })),
      usage: { inputTokens: 20, outputTokens: 10, cachedInputTokens: 0, totalTokens: 30 } }, request) });
  const result = await executor.executeNext(); return { fixture, workflowId, plans, contexts, segmentId, result };
}

test("translation doubts become immutable candidates without authorizing research", async () => {
  const value = await translatedFixture();
  try {
    assert.equal(value.result.status, "completed", JSON.stringify(value.result)); assert.equal(value.result.knowledgeNeeds.length, 1);
    const needs = new CandidateKnowledgeNeedService(value.fixture.database, value.fixture.workspaceId); const need = needs.list(value.workflowId)[0];
    assert.equal(need.originType, "translation-attempt"); assert.equal(need.decision, null);
    assert.equal(value.fixture.database.prepare("SELECT count(*) AS count FROM research_requests WHERE workspace_id = ?").get(value.fixture.workspaceId).count, 0);
    assert.equal(needs.captureTranslation(need.attemptId, [{ kind: need.kind, impact: need.impact, question: need.question,
      relatedSegmentIds: need.relatedSegmentIds }])[0].needId, need.needId, "identical replay is deduplicated");
    const decided = needs.decide(need.needId, "guidance", { guidance: "保留日文商品昵称" }, user);
    assert.equal(decided.decision.decision, "guidance");
    assert.equal(value.fixture.database.prepare("SELECT count(*) AS count FROM research_requests WHERE workspace_id = ?").get(value.fixture.workspaceId).count, 0);
    assert.throws(() => needs.promoteResearchNeed(need.needId), /research decision/);
  } finally { await value.fixture.close(); }
});

test("translation knowledge need response rejects malformed, excessive, duplicate and cross-segment proposals", () => {
  const segmentIds = [randomUUID(), randomUUID()]; const { request, response } = providerFixture(segmentIds);
  const valid = { kind: "term", impact: "high", question: "官方名称是什么？", relatedSegmentIds: [segmentIds[0]] };
  const candidate = { ...response.candidates[0], knowledgeNeeds: [valid] };
  assert.doesNotThrow(() => providerResponseContract({ ...response, candidates: [candidate, response.candidates[1]] }, request));
  assert.throws(() => providerResponseContract({ ...response, candidates: [{ ...candidate, knowledgeNeeds: Array(9).fill(valid) }, response.candidates[1]] }, request), /bounded|unique/);
  assert.throws(() => providerResponseContract({ ...response, candidates: [{ ...candidate, knowledgeNeeds: [valid, valid] }, response.candidates[1]] }, request), /unique/);
  assert.throws(() => providerResponseContract({ ...response, candidates: [{ ...candidate, knowledgeNeeds: [{ ...valid, relatedSegmentIds: [segmentIds[1]] }] }, response.candidates[1]] }, request), /segment-bound/);
  assert.throws(() => providerResponseContract({ ...response, candidates: [{ ...candidate, knowledgeNeeds: [{ ...valid, authorizeNetwork: true }] }, response.candidates[1]] }, request), /invalid/);
});

test("proceed-with-risk is immutable, user-only and creates no research side effect", async () => {
  const value = await translatedFixture();
  try {
    const needs = new CandidateKnowledgeNeedService(value.fixture.database, value.fixture.workspaceId); const need = needs.list(value.workflowId)[0];
    assert.throws(() => needs.decide(need.needId, "research", {}, system), /not authorized/);
    const decided = needs.decide(need.needId, "proceed-with-risk", { reason: "用户接受名称保留风险" }, user);
    assert.equal(decided.decision.decision, "proceed-with-risk"); assert.throws(() => needs.decide(need.needId, "research", {}, user), /already decided/);
    assert.throws(() => needs.promoteResearchNeed(need.needId), /research decision/);
    assert.equal(value.fixture.database.prepare("SELECT count(*) AS count FROM research_requests WHERE workspace_id = ?").get(value.fixture.workspaceId).count, 0);
    for (const [table, column] of [["candidate_knowledge_needs", "created_at"], ["candidate_knowledge_need_decisions", "decided_at"]]) {
      assert.throws(() => value.fixture.database.prepare(`UPDATE ${table} SET ${column} = ${column} WHERE workspace_id = ?`).run(value.fixture.workspaceId), /immutable/);
      assert.throws(() => value.fixture.database.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(value.fixture.workspaceId), /immutable/);
    }
  } finally { await value.fixture.close(); }
});

test("approved Planner high and critical uncovered items become bounded candidate needs", async () => {
  const value = await translatedFixture();
  try {
    const needs = new CandidateKnowledgeNeedService(value.fixture.database, value.fixture.workspaceId); const current = value.plans.get(value.workflowId);
    const base = current.plan.items[0]; let revised = value.plans.reviseApprovedForKnowledgeNeed(value.workflowId, current.planHead.version,
      { itemId: randomUUID(), kind: "fact", coverage: "uncovered", instructionType: "warning-only", impact: "critical",
        segmentIds: [value.segmentId], dependencies: {}, content: { question: "镜片结构是否为官方规格？" } }, system);
    revised = value.plans.submitPlan(value.workflowId, revised.planHead.version, system); value.plans.decidePlan(value.workflowId, revised.planHead.version, "approved", user);
    const captured = needs.capturePlan(value.workflowId);
    assert.equal(captured.some((item) => item.originType === "plan-item" && item.impact === "critical" && item.relatedSegmentIds.includes(value.segmentId)), true);
    assert.equal(captured.every((item) => ["critical", "high"].includes(item.impact)), true);
    assert.equal(base === undefined || typeof base === "object", true);
  } finally { await value.fixture.close(); }
});

test("model-assisted Plan cannot silently enter Context assembly before every captured need is disposed", async () => {
  const fixture = await applicationWorkspace("lectoria-planner-needs-gate-");
  try {
    const imported = await fixture.imports.import({ format: "text", content: "ALPHA causes BETA.", title: "planner gate" });
    fixture.imports.confirm(imported.importId, user); const workflowId = randomUUID(); const plans = new FlowPlanService(fixture.database, fixture.workspaceId);
    let plan = plans.create({ workflowId, documentId: imported.documentId, sourceRevisionId: imported.sourceRevisionId, targetLanguage: "zh-CN" }, user);
    plan = plans.revisePlan(workflowId, plan.planHead.version, { plannerMode: "model-assisted", items: plan.plan.items.map((item) => ({ ...item, itemId: randomUUID() })),
      researchScope: { mode: "proposed" }, qaProfile: { checks: ["relation"] } }, { type: "model", id: "fixture-planner" });
    plan = plans.submitPlan(workflowId, plan.planHead.version, system); plans.decidePlan(workflowId, plan.planHead.version, "approved", user);
    const contexts = new TemporaryContextService(fixture.database, fixture.workspaceId); assert.throws(() => contexts.assemble(workflowId), /require user disposition/);
    const needs = new CandidateKnowledgeNeedService(fixture.database, fixture.workspaceId); const captured = needs.list(workflowId);
    assert.equal(captured.length > 0, true); for (const need of captured) needs.decide(need.needId, "proceed-with-risk", { reason: "offline fixture" }, user);
    const context = contexts.assemble(workflowId); assert.equal(context.head.state, "pending-user");
  } finally { await fixture.close(); }
});

test("only a user research decision reopens Plan before creating a bounded research request", async () => {
  const value = await translatedFixture();
  try {
    const needs = new CandidateKnowledgeNeedService(value.fixture.database, value.fixture.workspaceId); let need = needs.list(value.workflowId)[0];
    need = needs.decide(need.needId, "research", { reason: "需要官方产品名证据" }, user); const promoted = needs.promoteResearchNeed(need.needId);
    assert.equal(promoted.planBinding.planItemId.length > 0, true); let plan = value.plans.get(value.workflowId); assert.equal(plan.planHead.state, "draft");
    assert.equal(value.contexts.get(value.workflowId).head.state, "stale"); assert.throws(() => needs.createResearchRequest(need.needId), /must be approved/);
    plan = value.plans.submitPlan(value.workflowId, plan.planHead.version, system); value.plans.decidePlan(value.workflowId, plan.planHead.version, "approved", user);
    const request = needs.createResearchRequest(need.needId); assert.equal(request.head.state, "draft");
    assert.deepEqual(request.request.questions, [need.question]); assert.equal(request.request.segmentIds.includes(value.segmentId), true);
    assert.equal(value.fixture.database.prepare("SELECT count(*) AS count FROM research_grants WHERE workspace_id = ?").get(value.fixture.workspaceId).count, 0);
    let context = value.contexts.assemble(value.workflowId, {}, system); context = value.contexts.decide(value.workflowId, context.head.version, "approved", user);
    const scoped = value.contexts.enqueueTranslation(value.workflowId, { segmentIds: [value.segmentId], providerId: "fixture-provider", modelId: "fixture-model",
      policyVersion: "knowledge-needs-budget", idempotencyKey: "knowledge-needs-retranslation", budgetCategory: "retranslation",
      estimatedUsage: { calls: 1, inputTokens: 100, outputTokens: 100, costMicrosCny: 100, costMicrosUsd: 0, durationMs: 100 } });
    assert.equal(scoped.task.attempts.length, 1); assert.equal(scoped.task.attempts[0].segment_id, value.segmentId);
  } finally { await value.fixture.close(); }
});
