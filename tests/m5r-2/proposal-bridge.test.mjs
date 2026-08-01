import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { KnowledgeIterationService } from "../../src/knowledge/iteration-service.mjs";
import { BraveSearchAdapter } from "../../src/search/brave-search-adapter.mjs";
import { RestrictedFetchProxy } from "../../src/search/fetch-proxy.mjs";
import { InvestigationService } from "../../src/search/investigation-service.mjs";
import { ProposalConflictError } from "../../src/search/knowledge-proposal-service.mjs";
import { ResearchConflictError } from "../../src/research/foundation-service.mjs";
import { ResearchProposalBridge } from "../../src/research/proposal-bridge.mjs";
import { termInput } from "../m5-1/helpers.mjs";
import { researchWorkspace, system, user } from "./helpers.mjs";

async function legacyEvidence(fixture) {
  const adapter = new BraveSearchAdapter({ fetchImpl: async () => new Response(JSON.stringify({ web: { results: [
    { title: "Synthetic terminology", url: "https://official.example/proposal", description: "Synthetic public evidence" },
  ] } }), { status: 200, headers: { "content-type": "application/json" } }) });
  const fetchProxy = new RestrictedFetchProxy({ now: fixture.now, resolver: async () => ["93.184.216.34"], robotsAllowed: async () => true,
    transport: async () => new Response("<main>Workspace and archive are fixed product terms.</main>",
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }) });
  const investigations = new InvestigationService(fixture.setup.fixture.database, fixture.setup.fixture.workspaceId, { now: fixture.now,
    searchInvoker: (request) => adapter.search(request, { credential: "offline-fixture" }), fetchProxy, handleKey: Buffer.alloc(32, 4) });
  const investigation = investigations.create({ taskId: fixture.bound.task.task.task_id, workflowId: fixture.setup.workflow.workflowId,
    segmentId: fixture.setup.workflow.segmentId, query: "synthetic terminology", maxResults: 1, country: "US", searchLanguage: "en" }, user);
  const search = await investigations.search(investigation.investigationId);
  const fetched = await investigations.fetch(investigation.investigationId, search.results[0].resultId, search.results[0].handle, user);
  return { investigation, fetched };
}

async function report(fixture, outcome = "supported") {
  const claimIds = [];
  if (outcome === "supported") {
    const extracted = [];
    for (const [index, url] of ["https://official.example/reference", "https://independent.example/reference"].entries())
      extracted.push(await fixture.gateway.extract(fixture.capability, fixture.run.runId, { providerId: "fake-content", round: 1, url,
        language: "en", country: "US", idempotencyKey: `proposal-extract-${index}` }));
    const quote = "Workspace is the product term.";
    const citations = extracted.map((item, index) => {
      const source = fixture.evidence.addSource(fixture.run.runId, item.queryId, { canonicalUrl: item.url, tier: index === 0 ? "S1" : "S2",
        lineage: "provider-processed", artifactType: "provider-content-snapshot", artifactId: item.snapshotId });
      const start = item.content.indexOf(quote);
      return fixture.evidence.cite(source.sourceId, { quote, locator: { start, end: start + quote.length } });
    });
    claimIds.push(fixture.evidence.claim(fixture.run.runId, { text: "Workspace is authoritative", citationIds: citations.map((item) => item.citationId),
      inference: false, disputed: false, insufficient: false, narrowOfficial: false }).claimId);
  } else claimIds.push(fixture.evidence.claim(fixture.run.runId, { text: `${outcome} evidence`, citationIds: [], inference: false,
    disputed: outcome === "disputed", insufficient: outcome === "insufficient", narrowOfficial: false }).claimId);
  return fixture.evidence.report(fixture.run.runId, { questionAnswers: [{ question: "term", answer: outcome, status: outcome }], claimIds,
    usage: fixture.budgets.totals(fixture.grant.grantId) });
}

test("one supported report creates multiple independent existing proposal revisions and reuses user decision and application", async () => {
  const fixture = await researchWorkspace();
  try {
    const researchReport = await report(fixture);
    const legacy = await legacyEvidence(fixture);
    const proposedSources = ["workspace", "archive"].map((term) => termInput({ factId: randomUUID(), revisionId: randomUUID(), language: "en",
      scope: { targetLanguages: ["zh-CN"], tags: [], documentIds: [fixture.setup.workflow.documentId] },
      content: { term, preferredTranslations: [{ language: "zh-CN", text: term === "workspace" ? "工作区" : "归档" }],
        forbiddenTranslations: [], variants: [], note: "Research report proposal" } }));
    const bridge = new ResearchProposalBridge(fixture.setup.fixture.database, fixture.setup.fixture.workspaceId);
    const created = bridge.createFromReport({ reportId: researchReport.reportId, investigationId: legacy.investigation.investigationId,
      fetchSnapshotId: legacy.fetched.fetchSnapshotId, proposals: proposedSources.map((proposedSource) => ({ operation: "create", proposedSource })) }, system);
    assert.equal(created.length, 2);
    assert.equal(new Set(created.map((item) => item.proposalId)).size, 2);
    assert.equal(new Set(created.map((item) => item.revision.factId)).size, 2);
    const evidenceCounts = created.map((item) => fixture.setup.fixture.database.prepare(
      "SELECT count(*) AS count FROM knowledge_proposal_research_evidence WHERE workspace_id = ? AND proposal_revision_id = ?")
      .get(fixture.setup.fixture.workspaceId, item.revision.proposalRevisionId).count);
    assert.deepEqual(evidenceCounts, [2, 2]);
    const iterations = new KnowledgeIterationService(fixture.setup.fixture.root, fixture.setup.fixture.database, fixture.setup.fixture.workspaceId,
      { now: fixture.now, facts: fixture.setup.facts, retriever: fixture.setup.retriever, proposals: bridge.proposals });
    for (const proposal of created) {
      for (let repeat = 0; repeat < 200; repeat += 1) {
        assert.throws(() => bridge.proposals.decide(proposal.proposalId, 0, "approved", system), ProposalConflictError);
        assert.throws(() => iterations.apply(proposal.proposalId, system), ProposalConflictError);
      }
      bridge.proposals.decide(proposal.proposalId, 0, "approved", user);
      const applied = await iterations.apply(proposal.proposalId, user);
      assert.equal(applied.application.factId, proposal.revision.factId);
    }
  } finally { await fixture.close(); }
});

for (const outcome of ["disputed", "insufficient"]) test(`${outcome} reports cannot create affirmative knowledge proposals`, async () => {
  const fixture = await researchWorkspace();
  try {
    const researchReport = await report(fixture, outcome);
    const legacy = await legacyEvidence(fixture);
    const bridge = new ResearchProposalBridge(fixture.setup.fixture.database, fixture.setup.fixture.workspaceId);
    assert.throws(() => bridge.createFromReport({ reportId: researchReport.reportId, investigationId: legacy.investigation.investigationId,
      fetchSnapshotId: legacy.fetched.fetchSnapshotId, proposals: [{ operation: "create", proposedSource: termInput() }] }, system), ResearchConflictError);
  } finally { await fixture.close(); }
});
