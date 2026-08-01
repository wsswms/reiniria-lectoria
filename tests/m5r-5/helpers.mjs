import { randomUUID } from "node:crypto";
import { KnowledgeIterationService } from "../../src/knowledge/iteration-service.mjs";
import { QualityService } from "../../src/quality/quality-service.mjs";
import { ResearchProposalBridge } from "../../src/research/proposal-bridge.mjs";
import { BraveSearchAdapter } from "../../src/search/brave-search-adapter.mjs";
import { RestrictedFetchProxy } from "../../src/search/fetch-proxy.mjs";
import { InvestigationService } from "../../src/search/investigation-service.mjs";
import { WorkCopyService } from "../../src/translation/work-copy-service.mjs";
import { termInput } from "../m5-1/helpers.mjs";
import { researchWorkspace, system, user } from "../m5r-2/helpers.mjs";

export async function legacyResearchEvidence(fixture) {
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

export async function supportedResearchReport(fixture, suffix = randomUUID(), { beforeReport } = {}) {
  const extracted = [];
  for (const [index, url] of ["https://official.example/reference", "https://independent.example/reference"].entries()) {
    extracted.push(await fixture.gateway.extract(fixture.capability, fixture.run.runId, { providerId: "fake-content", round: 1, url,
      language: "en", country: "US", idempotencyKey: `${suffix}:extract:${index}` }));
  }
  const quote = "Workspace is the product term.";
  const citations = extracted.map((item, index) => {
    const source = fixture.evidence.addSource(fixture.run.runId, item.queryId, { canonicalUrl: item.url, tier: index === 0 ? "S1" : "S2",
      lineage: "provider-processed", artifactType: "provider-content-snapshot", artifactId: item.snapshotId });
    const start = item.content.indexOf(quote);
    return fixture.evidence.cite(source.sourceId, { quote, locator: { start, end: start + quote.length } });
  });
  const claim = fixture.evidence.claim(fixture.run.runId, { text: "Workspace is authoritative", citationIds: citations.map((item) => item.citationId),
    inference: false, disputed: false, insufficient: false, narrowOfficial: false });
  beforeReport?.(claim);
  return fixture.evidence.report(fixture.run.runId, { questionAnswers: [{ question: "term", answer: "supported", status: "supported" }],
    claimIds: [claim.claimId], usage: fixture.budgets.totals(fixture.grant.grantId) });
}

export async function populatedResearchWorkspace(suffix = randomUUID()) {
  const fixture = await researchWorkspace();
  const report = await supportedResearchReport(fixture, suffix);
  const legacy = await legacyResearchEvidence(fixture);
  const bridge = new ResearchProposalBridge(fixture.setup.fixture.database, fixture.setup.fixture.workspaceId);
  const proposedSources = ["workspace", "archive"].map((term) => termInput({ factId: randomUUID(), revisionId: randomUUID(), language: "zh-CN",
    scope: { targetLanguages: ["zh-CN"], tags: [], documentIds: [fixture.setup.workflow.documentId] },
    content: { term, preferredTranslations: [{ language: "zh-CN", text: term === "workspace" ? "工作区" : "归档" }],
      forbiddenTranslations: [], variants: [], note: "Research report proposal" } }));
  const proposals = bridge.createFromReport({ reportId: report.reportId, investigationId: legacy.investigation.investigationId,
    fetchSnapshotId: legacy.fetched.fetchSnapshotId, proposals: proposedSources.map((proposedSource) => ({ operation: "create", proposedSource })) }, system);
  const workCopies = new WorkCopyService(fixture.setup.fixture.database, fixture.setup.fixture.workspaceId, { now: fixture.now });
  const candidate = workCopies.addCandidate(fixture.setup.workflow.workflowId, fixture.setup.workflow.segmentId,
    "请安全使用工作区备份。", { type: "fixture", id: "m5r-5-candidate" });
  const quality = new QualityService(fixture.setup.fixture.database, fixture.setup.fixture.workspaceId, { now: fixture.now, workCopies });
  const qualityRun = quality.runCandidate(fixture.setup.workflow.workflowId, fixture.setup.workflow.segmentId, candidate.candidateId,
    { evidenceIds: [fixture.bound.snapshot.evidenceId] });
  const iterations = new KnowledgeIterationService(fixture.setup.fixture.root, fixture.setup.fixture.database, fixture.setup.fixture.workspaceId,
    { now: fixture.now, facts: fixture.setup.facts, retriever: fixture.setup.retriever, proposals: bridge.proposals });
  const applications = [];
  for (const proposal of proposals) {
    bridge.proposals.decide(proposal.proposalId, 0, "approved", user);
    applications.push(await iterations.apply(proposal.proposalId, user));
  }
  return { fixture, report, legacy, bridge, proposals, applications, qualityRun };
}
