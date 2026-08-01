import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowApi } from "../../src/application/workflow-api.mjs";
import { runWorkflowCli } from "../../src/cli/workflow-cli.mjs";
import { KnowledgeIterationService } from "../../src/knowledge/iteration-service.mjs";
import { KnowledgeIntegrityService } from "../../src/knowledge/integrity-service.mjs";
import { QualityService } from "../../src/quality/quality-service.mjs";
import { WorkCopyService } from "../../src/translation/work-copy-service.mjs";
import { internetWorkspace, proposedTerm, searchAndFetch, user } from "../m5-5/helpers.mjs";

async function approvedProposal(setup) {
  const flow = await searchAndFetch(setup);
  const proposal = setup.proposals.create({ investigationId: setup.investigation.investigationId,
    fetchSnapshotId: flow.snapshot.fetchSnapshotId, operation: "create", proposedSource: proposedTerm(setup, { language: "zh-CN" }) }, user);
  return setup.proposals.decide(proposal.proposalId, 0, "approved", user);
}

test("approved proposal applies exactly one fact rebuilds FTS and makes old evidence and quality stale", async () => {
  const setup = await internetWorkspace();
  try {
    const workCopies = new WorkCopyService(setup.fixture.database, setup.fixture.workspaceId, { now: setup.fixture.clock.now });
    const candidate = workCopies.addCandidate(setup.workflow.workflowId, setup.workflow.segmentId,
      "请使用工作区备份。", { type: "fixture", id: "candidate" });
    const quality = new QualityService(setup.fixture.database, setup.fixture.workspaceId, { now: setup.fixture.clock.now, workCopies });
    const oldQuality = quality.runCandidate(setup.workflow.workflowId, setup.workflow.segmentId, candidate.candidateId,
      { evidenceIds: [setup.bound.snapshot.evidenceId] });
    assert.equal(setup.evidence.currentStatus(setup.bound.snapshot.evidenceId).current, true);
    assert.equal(oldQuality.current, true);

    const proposal = await approvedProposal(setup);
    const results = await Promise.all(Array.from({ length: 100 }, () => new KnowledgeIterationService(
      setup.fixture.root, setup.fixture.database, setup.fixture.workspaceId, {
        now: setup.fixture.clock.now, facts: setup.facts, retriever: setup.retriever, proposals: setup.proposals,
      }).apply(proposal.proposalId, user)));
    assert.equal(new Set(results.map((item) => item.application.applicationId)).size, 1);
    assert.equal(setup.facts.get(proposal.revision.factId).revision.revisionId, proposal.revision.proposedSource.revisionId);
    assert.equal(setup.facts.listRevisions(proposal.revision.factId).length, 1);
    assert.deepEqual(setup.evidence.currentStatus(setup.bound.snapshot.evidenceId), { current: false, reason: "index" });
    assert.deepEqual(quality.currentStatus(oldQuality.qualityRunId), { current: false, reason: "rule-or-fact" });
    assert.ok(setup.retriever.search({ query: "workspace", language: "zh-CN", kinds: ["term"], tags: [],
      documentIds: [setup.workflow.documentId], topK: 10 }).some((hit) => hit.factId === proposal.revision.factId));
    assert.throws(() => setup.fixture.database.prepare("DELETE FROM knowledge_proposal_applications").run(), /immutable/);
  } finally { await setup.fixture.close(); }
});

test("fact commit followed by interruption fails closed and a retry completes application and index", async () => {
  const setup = await internetWorkspace();
  try {
    const proposal = await approvedProposal(setup);
    const interrupted = new KnowledgeIterationService(setup.fixture.root, setup.fixture.database, setup.fixture.workspaceId, {
      now: setup.fixture.clock.now, facts: setup.facts, retriever: setup.retriever, proposals: setup.proposals,
      inject: (point) => { if (point === "after-fact") throw new Error("injected after fact"); },
    });
    await assert.rejects(interrupted.apply(proposal.proposalId, user), /injected/);
    assert.equal(setup.facts.get(proposal.revision.factId).revision.revisionId, proposal.revision.proposedSource.revisionId);
    assert.throws(() => setup.retriever.search({ query: "workspace", language: "zh-CN", kinds: ["term"], tags: [],
      documentIds: [setup.workflow.documentId], topK: 10 }), /stale/);
    assert.throws(() => interrupted.get(proposal.proposalId), /not found/);

    const recovered = new KnowledgeIterationService(setup.fixture.root, setup.fixture.database, setup.fixture.workspaceId, {
      now: setup.fixture.clock.now, facts: setup.facts, retriever: setup.retriever, proposals: setup.proposals,
    });
    const result = await recovered.apply(proposal.proposalId, user);
    assert.equal(result.application.factRevisionId, proposal.revision.proposedSource.revisionId);
    assert.equal(result.manifest.factCount, 3);
  } finally { await setup.fixture.close(); }
});

test("approved revise proposal advances the exact base revision and rejects stale replay", async () => {
  const setup = await internetWorkspace();
  try {
    const flow = await searchAndFetch(setup);
    const source = proposedTerm(setup, { factId: setup.term.factId, language: setup.term.language });
    const proposal = setup.proposals.create({ investigationId: setup.investigation.investigationId,
      fetchSnapshotId: flow.snapshot.fetchSnapshotId, operation: "revise", baseFactRevisionId: setup.term.revisionId,
      proposedSource: source }, user);
    setup.proposals.decide(proposal.proposalId, 0, "approved", user);
    const iterations = new KnowledgeIterationService(setup.fixture.root, setup.fixture.database, setup.fixture.workspaceId, {
      now: setup.fixture.clock.now, facts: setup.facts, retriever: setup.retriever, proposals: setup.proposals,
    });
    const result = await iterations.apply(proposal.proposalId, user);
    assert.equal(result.application.operation, "revise");
    assert.equal(setup.facts.get(setup.term.factId).revision.revisionId, source.revisionId);
    assert.equal(setup.facts.listRevisions(setup.term.factId).length, 2);
    const competing = setup.proposals.create({ investigationId: setup.investigation.investigationId,
      fetchSnapshotId: flow.snapshot.fetchSnapshotId, operation: "revise", baseFactRevisionId: source.revisionId,
      proposedSource: proposedTerm(setup, { factId: setup.term.factId, language: setup.term.language }) }, user);
    setup.proposals.decide(competing.proposalId, 0, "approved", user);
    await setup.facts.revise(setup.term.factId, setup.facts.get(setup.term.factId).head.version,
      proposedTerm(setup, { factId: setup.term.factId, language: setup.term.language }), { type: "fixture", id: "competing-update" });
    await assert.rejects(iterations.apply(competing.proposalId, user), /base is stale/);
  } finally { await setup.fixture.close(); }
});

test("unified CLI exposes proposal application rebuild and search without granting non-users", async () => {
  const setup = await internetWorkspace();
  try {
    const proposal = await approvedProposal(setup);
    const iterations = new KnowledgeIterationService(setup.fixture.root, setup.fixture.database, setup.fixture.workspaceId, {
      now: setup.fixture.clock.now, facts: setup.facts, retriever: setup.retriever, proposals: setup.proposals,
    });
    const api = new WorkflowApi({ imports: null, reimports: null, states: null, workCopies: null, validation: null,
      reviews: null, exports: null, proposals: setup.proposals, iterations, retriever: setup.retriever });
    assert.throws(() => runWorkflowCli(api, ["proposal:apply", JSON.stringify({ proposalId: proposal.proposalId,
      actor: { type: "system", id: "automatic" } })]), /only a user/);
    const applied = await runWorkflowCli(api, ["proposal:apply", JSON.stringify({ proposalId: proposal.proposalId, actor: user })]);
    const fetched = runWorkflowCli(api, ["proposal:get", JSON.stringify({ proposalId: proposal.proposalId })]);
    const hits = runWorkflowCli(api, ["knowledge:search", JSON.stringify({ request: { query: "workspace", language: "zh-CN",
      kinds: ["term"], tags: [], documentIds: [setup.workflow.documentId], topK: 5 } })]);
    assert.equal(applied.application.proposalId, fetched.proposalId);
    assert.ok(hits.some((hit) => hit.factId === proposal.revision.factId));
  } finally { await setup.fixture.close(); }
});

test("integrity diagnostics repair a deleted derived index and reject corrupted internet evidence", async () => {
  const setup = await internetWorkspace();
  try {
    const proposal = await approvedProposal(setup);
    const iterations = new KnowledgeIterationService(setup.fixture.root, setup.fixture.database, setup.fixture.workspaceId, {
      now: setup.fixture.clock.now, facts: setup.facts, retriever: setup.retriever, proposals: setup.proposals,
    });
    await iterations.apply(proposal.proposalId, user);
    const integrity = new KnowledgeIntegrityService(setup.fixture.database, setup.fixture.workspaceId, {
      facts: setup.facts, retriever: setup.retriever, investigations: setup.investigations, iterations,
    });
    const api = new WorkflowApi({ imports: null, reimports: null, states: null, workCopies: null, validation: null,
      reviews: null, exports: null, integrity });
    assert.equal((await runWorkflowCli(api, ["knowledge:diagnose", "{}"])).status, "ok");
    const { rm } = await import("node:fs/promises");
    await rm(`${setup.fixture.root}/derived/knowledge-index.sqlite3`);
    await assert.rejects(integrity.diagnose(), /integrity/);
    assert.equal((await runWorkflowCli(api, ["knowledge:repair-derived", "{}"])).status, "ok");
    setup.fixture.database.exec("DROP TRIGGER internet_fetch_snapshots_no_update");
    setup.fixture.database.prepare("UPDATE internet_fetch_snapshots SET extracted_text = extracted_text || 'tampered'").run();
    await assert.rejects(integrity.diagnose(), (error) => error.failures.some((item) => item.startsWith("fetch:")));
  } finally { await setup.fixture.close(); }
});
