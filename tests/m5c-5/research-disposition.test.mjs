import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextDispositionService } from "../../src/m5c/context-disposition-service.mjs";
import { FlowPlanService } from "../../src/m5c/flow-plan-service.mjs";
import { M5CResearchBridgeService } from "../../src/m5c/research-bridge-service.mjs";
import { TemporaryContextService } from "../../src/m5c/temporary-context-service.mjs";
import { FtsRetriever } from "../../src/knowledge/fts-retriever.mjs";
import { DomainStateService } from "../../src/domain/state-service.mjs";
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
        maxRuns: 1, maxModelTokens: 0, maxCostMicrosUsd: 0 }, allowedDomains: ["example.com"], allowedLanguages: ["en", "zh-CN"],
      approvedBy: user, approvedAt: new Date(0).toISOString(), expiresAt: new Date(60_000).toISOString() };
    const issued = bridge.issueGrant(request.request.requestId, grant, user); assert.equal(issued.grant.status, "active");
    const reservation = bridge.reserveOperation(request.request.requestId, grant.grantId, "search", "search:one",
      { calls: 1, inputTokens: 0, outputTokens: 0, costMicrosCny: 0, costMicrosUsd: 0, durationMs: 10 });
    assert.equal(reservation.decision, "reserved");
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
