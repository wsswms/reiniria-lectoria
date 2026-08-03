import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextDispositionService } from "../../src/m5c/context-disposition-service.mjs";
import { FlowRecoveryService } from "../../src/m5c/flow-recovery-service.mjs";
import { TranslationFlowBudgetService } from "../../src/m5c/flow-budget-service.mjs";
import { FlowPlanService } from "../../src/m5c/flow-plan-service.mjs";
import { CandidateKnowledgeNeedService } from "../../src/m5c/candidate-knowledge-need-service.mjs";
import { M5CResearchBridgeService } from "../../src/m5c/research-bridge-service.mjs";
import { TemporaryContextService } from "../../src/m5c/temporary-context-service.mjs";
import { contentDigest } from "../../src/m5c/contracts.mjs";
import { FtsRetriever } from "../../src/knowledge/fts-retriever.mjs";
import { DomainStateService } from "../../src/domain/state-service.mjs";
import { ResearchBudgetService } from "../../src/research/budget-service.mjs";
import { ResearchEvidenceService } from "../../src/research/evidence-service.mjs";
import { WebSearchArtifactService } from "../../src/research/web-search-artifact-service.mjs";
import { setup } from "../m5c-1/helpers.mjs";

const user = Object.freeze({ type: "user", id: "m5c-owner" });
const system = Object.freeze({ type: "system", id: "m5c-control-plane" });

function approvedPlan(fixture) {
  const service = new FlowPlanService(fixture.database, fixture.workspaceId);
  let flow = service.create({ workflowId: fixture.workflowId, documentId: fixture.documentId,
    sourceRevisionId: fixture.sourceRevisionId, targetLanguage: "zh-CN" }, user);
  flow = service.submitPlan(fixture.workflowId, flow.planHead.version, system);
  return { service, flow: service.decidePlan(fixture.workflowId, flow.planHead.version, "approved", user) };
}

test("research requests can only originate from an approved current Plan and create no translation attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-research-")); const fixture = setup(join(root, "app.sqlite3"));
  try {
    const { flow } = approvedPlan(fixture); const item = flow.plan.items.find((candidate) => candidate.coverage === "uncovered"); assert.ok(item);
    const bridge = new M5CResearchBridgeService(fixture.database, fixture.workspaceId, { now: () => new Date(0) });
    let request = bridge.propose(fixture.workflowId, { originType: "plan-item", originId: item.itemId,
      questions: ["What is the approved translation of this term?"], gapKinds: ["term"] }, system);
    assert.equal(request.binding.planRevisionId, flow.plan.planRevisionId);
    assert.equal(fixture.database.prepare("SELECT count(*) AS count FROM translation_attempts WHERE workspace_id = ?").get(fixture.workspaceId).count, 0);
    assert.equal(fixture.database.prepare("SELECT state FROM translation_tasks WHERE workspace_id = ? AND task_id = ?").get(fixture.workspaceId, request.binding.anchorTaskId).state, "canceled");
    request = bridge.submit(request.request.requestId, request.head.version, system);
    request = bridge.decide(request.request.requestId, request.head.version, "approved", user);
    const grant = { schemaVersion: "1.0", grantId: randomUUID(), requestId: request.request.requestId,
      requestRevisionId: request.head.requestRevisionId,
      providers: [{ capability: "search", providerId: "fixture-search", fallbackOrder: 0,
        budget: { maxSearchCalls: 1, maxContentUrls: 0, maxModelTokens: 0, maxCostMicrosUsd: 0 } }],
      limits: { maxRounds: 1, maxSearchCalls: 1, maxResultsPerSearch: 1, maxContentUrls: 1, maxDurationSeconds: 60,
        maxRuns: 2, maxModelTokens: 0, maxCostMicrosUsd: 0 }, allowedDomains: ["example.com"], allowedLanguages: ["en", "zh-CN"],
      approvedBy: user, approvedAt: new Date(0).toISOString(), expiresAt: new Date(60_000).toISOString() };
    const issued = bridge.issueGrant(request.request.requestId, grant, user); assert.equal(issued.grant.status, "active");
    const createdRun = bridge.createRun(request.request.requestId, contentDigest({ fixture: "m5c-run" }), system);
    const startedRun = bridge.startRun(request.request.requestId, createdRun.run.runId, system); assert.equal(startedRun.run.state, "running");
    const usage = { calls: 1, inputTokens: 0, outputTokens: 0, costMicrosCny: 0, costMicrosUsd: 0, durationMs: 10 };
    const contenders = Array.from({ length: 50 }, (_, index) => ({ reservationId: `search:${index}`,
      details: { runId: startedRun.run.runId, providerId: "fixture-search", round: 1, query: `approved term ${index}`,
        language: "en", country: "US", idempotencyKey: `search-${index}` } }));
    const outcomes = await Promise.allSettled(contenders.map((contender) => Promise.resolve().then(() => bridge.reserveOperation(
      request.request.requestId, grant.grantId, "search", contender.reservationId, usage, contender.details))));
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const winnerIndex = outcomes.findIndex((outcome) => outcome.status === "fulfilled"); const winner = contenders[winnerIndex];
    const reservation = outcomes[winnerIndex].value;
    assert.equal(reservation.article.decision, "reserved"); assert.equal(reservation.research.entries[0].entryType, "reserved");
    assert.equal(bridge.reserveOperation(request.request.requestId, grant.grantId, "search", winner.reservationId,
      usage, winner.details).reused, true);
    assert.throws(() => bridge.reserveOperation(request.request.requestId, grant.grantId, "search", winner.reservationId,
      usage, { ...winner.details, query: "changed replay" }), /idempotency conflict/);
    assert.equal(fixture.database.prepare("SELECT count(*) AS count FROM flow_budget_ledger WHERE workspace_id = ? AND workflow_id = ? AND entry_type = 'reserved'")
      .get(fixture.workspaceId, fixture.workflowId).count, 1, "losing article reservations roll back atomically");
    assert.equal(fixture.database.prepare("SELECT count(*) AS count FROM research_queries WHERE workspace_id = ?")
      .get(fixture.workspaceId).count, 1, "only one ResearchGrant reservation is committed");
    assert.equal(fixture.database.prepare("SELECT count(*) AS count FROM m5c_research_operations WHERE workspace_id = ?")
      .get(fixture.workspaceId).count, 1, "the cross-ledger binding is atomic");

    const unknown = bridge.unknownOperation(request.request.requestId, winner.reservationId, { category: "timeout" });
    assert.equal(unknown.run.state, "paused"); assert.equal(unknown.run.reason, "unknown-outcome");
    assert.equal(bridge.reserveOperation(request.request.requestId, grant.grantId, "search", winner.reservationId,
      usage, winner.details).reused, true, "reservation replay remains available after its ResearchRun pauses");
    assert.equal(bridge.unknownOperation(request.request.requestId, winner.reservationId, { category: "timeout" }).article.reused, true);
    const retriedRun = bridge.retryUnknownRun(request.request.requestId, startedRun.run.runId, user);
    assert.equal(retriedRun.run.state, "queued"); assert.equal(retriedRun.run.attempt, 2);
    assert.equal(bridge.startRun(request.request.requestId, retriedRun.run.runId, system).run.state, "running");

    const flowControl = fixture.database.prepare("SELECT version FROM translation_flow_controls WHERE workspace_id = ? AND workflow_id = ?")
      .get(fixture.workspaceId, fixture.workflowId);
    const budgets = new TranslationFlowBudgetService(fixture.database, fixture.workspaceId); const current = budgets.get(fixture.workflowId);
    const { schemaVersion: _schemaVersion, workflowId: _workflowId, revision: _revision, authorizedBy: _authorizedBy,
      createdAt: _createdAt, ...limits } = current.policy;
    budgets.expand(fixture.workflowId, current.version, { ...limits, maxUnknownOutcomes: 2,
      categories: Object.fromEntries(Object.entries(limits.categories).map(([key, value]) => [key, { ...value }])) }, user);
    assert.equal(new FlowRecoveryService(fixture.database, fixture.workspaceId)
      .resolve(fixture.workflowId, flowControl.version, "retry", null, user).flowState, "research");
  } finally { fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});

test("a user-selected Planner uncertainty completes the search-snippet evidence and Report chain", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-planner-research-")); const fixture = setup(join(root, "app.sqlite3"));
  try {
    const { service: plans } = approvedPlan(fixture); const needs = new CandidateKnowledgeNeedService(fixture.database, fixture.workspaceId);
    let need = needs.capturePlan(fixture.workflowId).find((item) => item.impact === "high"); assert.ok(need);
    need = needs.decide(need.needId, "research", { reason: "offline full-chain fixture" }, user); needs.promoteResearchNeed(need.needId);
    let plan = plans.get(fixture.workflowId); plan = plans.submitPlan(fixture.workflowId, plan.planHead.version, system);
    plans.decidePlan(fixture.workflowId, plan.planHead.version, "approved", user); let request = needs.createResearchRequest(need.needId);
    const bridge = new M5CResearchBridgeService(fixture.database, fixture.workspaceId); request = bridge.submit(request.request.requestId, request.head.version, system);
    request = bridge.decide(request.request.requestId, request.head.version, "approved", user); const now = new Date();
    const issued = bridge.issueGrant(request.request.requestId, { schemaVersion: "1.0", grantId: randomUUID(), requestId: request.request.requestId,
      requestRevisionId: request.head.requestRevisionId, providers: [{ capability: "search", providerId: "brave-search", fallbackOrder: 0,
        budget: { maxSearchCalls: 1, maxContentUrls: 0, maxModelTokens: 0, maxCostMicrosUsd: 5_000 } }],
      limits: { maxRounds: 1, maxSearchCalls: 1, maxResultsPerSearch: 10, maxContentUrls: 1, maxDurationSeconds: 300,
        maxRuns: 1, maxModelTokens: 0, maxCostMicrosUsd: 5_000 }, allowedDomains: ["nij.nikon.com"], allowedLanguages: ["ja"],
      approvedBy: user, approvedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 300_000).toISOString() }, user);
    const run = bridge.startRun(request.request.requestId,
      bridge.createRun(request.request.requestId, contentDigest({ fixture: "planner-research" }), system).run.runId, system).run;
    const reservationId = `search:fixture:${need.needId}`; const usage = { calls: 1, inputTokens: 0, outputTokens: 0,
      costMicrosCny: 0, costMicrosUsd: 5_000, durationMs: 60_000 };
    const grantId = issued.grant.grant.grantId;
    const reserved = bridge.reserveOperation(request.request.requestId, grantId, "search", reservationId, usage,
      { runId: run.runId, providerId: "brave-search", round: 1, query: "site:nij.nikon.com Nikon", language: "ja", country: "JP", idempotencyKey: reservationId });
    const response = { adapterId: "brave-search", adapterVersion: "brave-web-search-v1", responseDigest: contentDigest({ fixture: "search" }),
      results: [{ rank: 1, title: "Nikon official", url: "https://nij.nikon.com/enjoy/life/historynikkor/0052/", description: "Official lens article" }],
      usage: { searchCalls: 1, contentUrls: 0, modelTokens: 0, costMicrosUsd: 5_000 } };
    const artifact = new WebSearchArtifactService(fixture.database, fixture.workspaceId).recordResearch(reserved.research.queryId, response);
    bridge.settleOperation(request.request.requestId, reservationId, { ...usage, durationMs: 1_000 }, { responseDigest: response.responseDigest });
    const selected = artifact.results[0]; const evidence = new ResearchEvidenceService(fixture.database, fixture.workspaceId);
    const source = evidence.addSource(run.runId, reserved.research.queryId, { canonicalUrl: selected.url, tier: "S1",
      lineage: "search-snippet", artifactType: "search-result", artifactId: selected.resultId });
    const quote = `${selected.title}\n${selected.description}`; const citation = evidence.cite(source.sourceId,
      { quote, locator: { start: 0, end: quote.length } });
    const claim = evidence.claim(run.runId, { text: quote, citationIds: [citation.citationId], inference: false,
      disputed: false, insufficient: false, narrowOfficial: true });
    const totals = new ResearchBudgetService(fixture.database, fixture.workspaceId).totals(grantId);
    const report = evidence.report(run.runId, { questionAnswers: [{ question: need.question, answer: quote, status: "supported" }],
      claimIds: [claim.claimId], usage: totals });
    assert.equal(report.outcome, "supported"); assert.equal(claim.supportLevel, "C2"); assert.equal(totals.searchCalls, 1);
    assert.equal(bridge.runs.transition(run.runId, "completed", { details: { reportId: report.reportId }, actor: system }).state, "completed");
  } finally { fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});

test("only selected temporary items create drafts and approval remains separate from FTS application", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5c-disposition-"));
  for (const directory of ["private/objects", "private/ledger", "derived", "staging", "dictionary", "style", "knowledge"]) await mkdir(join(root, directory), { recursive: true });
  const fixture = setup(join(root, "app.sqlite3"));
  try {
    approvedPlan(fixture); const contexts = new TemporaryContextService(fixture.database, fixture.workspaceId);
    let context = contexts.assemble(fixture.workflowId, {}, system); context = contexts.decide(fixture.workflowId, context.head.version, "approved", user);
    const states = new DomainStateService(fixture.database, fixture.workspaceId, { now: () => new Date(0) });
    let workflow = states.get(fixture.workflowId);
    for (const next of ["queued", "generating", "draft-machine", "candidate-valid", "editing", "human-reviewed", "approved-for-export", "exported"])
      workflow = states.transition(fixture.workflowId, workflow.version, next, ["human-reviewed", "approved-for-export"].includes(next) ? user : system);
    fixture.database.prepare("UPDATE translation_flow_controls SET flow_state = 'disposition' WHERE workspace_id = ? AND workflow_id = ?").run(fixture.workspaceId, fixture.workflowId);
    const retriever = new FtsRetriever(root, fixture.database, fixture.workspaceId); await retriever.rebuild();
    const service = new ContextDispositionService(root, fixture.database, fixture.workspaceId, { retriever });
    const source = { schemaVersion: "1.0", factId: randomUUID(), revisionId: randomUUID(), kind: "term", language: "zh-CN",
      scope: { targetLanguages: ["zh-CN"], tags: ["m5c"], documentIds: [fixture.documentId] },
      content: { term: "Nikon", preferredTranslations: [{ language: "zh-CN", text: "尼康" }], forbiddenTranslations: [], variants: [] } };
    const selected = context.context.items[0]; const result = service.decide(fixture.workflowId,
      [{ contextItemId: selected.contextItemId, proposedSource: source }], user);
    assert.equal(result.proposals.length, 1); assert.equal(result.selectedItemIds.length, 1);
    assert.equal(retriever.search({ query: "Nikon", language: "zh-CN", kinds: ["term"], tags: [], documentIds: [fixture.documentId], topK: 5 }).length, 0);
    const proposal = service.decideProposal(result.proposals[0].proposalId, "approved", user);
    assert.equal(proposal.decision.decision, "approved");
    assert.equal(retriever.search({ query: "Nikon", language: "zh-CN", kinds: ["term"], tags: [], documentIds: [fixture.documentId], topK: 5 }).length, 0);
    await service.applyProposal(proposal.proposalId, user);
    assert.equal(retriever.search({ query: "Nikon", language: "zh-CN", kinds: ["term"], tags: [], documentIds: [fixture.documentId], topK: 5 }).length, 1);
    assert.equal(fixture.database.prepare("SELECT count(*) AS count FROM knowledge_facts WHERE workspace_id = ?").get(fixture.workspaceId).count, 1);
  } finally { fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});
