import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { WorkflowApi } from "../../src/application/workflow-api.mjs";
import { runWorkflowCli } from "../../src/cli/workflow-cli.mjs";
import { ReimportService } from "../../src/document/reimport-service.mjs";
import { ExportService } from "../../src/export/export-service.mjs";
import { EvidenceService } from "../../src/knowledge/evidence-service.mjs";
import { KnowledgeFactService } from "../../src/knowledge/fact-service.mjs";
import { FtsRetriever } from "../../src/knowledge/fts-retriever.mjs";
import { KnowledgeIterationService } from "../../src/knowledge/iteration-service.mjs";
import { QualityService } from "../../src/quality/quality-service.mjs";
import { BraveSearchAdapter } from "../../src/search/brave-search-adapter.mjs";
import { RestrictedFetchProxy } from "../../src/search/fetch-proxy.mjs";
import { InvestigationService } from "../../src/search/investigation-service.mjs";
import { KnowledgeProposalService } from "../../src/search/knowledge-proposal-service.mjs";
import { ReviewService } from "../../src/translation/review-service.mjs";
import { validFixtures } from "../fixtures/m3-2/corpus.mjs";
import { workspace } from "../m3-4/helpers.mjs";
import { enqueueInput, orchestrator } from "../m4-3/helpers.mjs";
import { termInput } from "../m5-1/helpers.mjs";

const user = Object.freeze({ type: "user", id: "m5-6-user" });
const translations = Object.freeze({ "zh-CN": "内布隆", ja: "ネビュロン", en: "Nebulon-approved" });

function withGap(source) {
  if (source.format === "markdown") return { ...source, content: `${source.content}\n\nNebulon term.` };
  if (source.format === "html") return { ...source, content: `${source.content}<p>Nebulon term.</p>` };
  return { ...source, content: `${source.content}\n\nNebulon term.` };
}

test("twelve documents across three formats complete the approved internet knowledge iteration through one API and CLI", async () => {
  const fixture = await workspace("lectoria-m5-6-e2e-");
  fixture.clock = { now: () => new Date(0), advance() {} };
  try {
    const selected = ["markdown", "html", "text"].flatMap((format) => validFixtures.filter((item) => item.format === format).slice(0, 4)).map(withGap);
    assert.equal(selected.length, 12);
    const facts = new KnowledgeFactService(fixture.root, fixture.database, fixture.workspaceId, { now: fixture.clock.now });
    const retriever = new FtsRetriever(fixture.root, fixture.database, fixture.workspaceId, { now: fixture.clock.now });
    await retriever.rebuild();
    const evidence = new EvidenceService(fixture.database, fixture.workspaceId, retriever, { now: fixture.clock.now });
    const adapter = new BraveSearchAdapter({ fetchImpl: async () => new Response(JSON.stringify({ web: { results: [
      { title: "Public Nebulon glossary", url: "https://example.com/nebulon", description: "Public synthetic terminology reference" },
    ] } }), { status: 200, headers: { "content-type": "application/json" } }) });
    const fetchProxy = new RestrictedFetchProxy({ now: fixture.clock.now, resolver: async () => ["93.184.216.34"],
      robotsAllowed: async () => true, transport: async () => new Response(
        "<html><head><title>Nebulon glossary</title><script>approve()</script></head><body>Public synthetic Nebulon terminology evidence.</body></html>",
        { status: 200, headers: { "content-type": "text/html" } }) });
    const investigations = new InvestigationService(fixture.database, fixture.workspaceId, { now: fixture.clock.now,
      searchInvoker: (request) => adapter.search(request, { credential: "fixture-only-secret" }), fetchProxy, handleKey: Buffer.alloc(32, 9) });
    const proposals = new KnowledgeProposalService(fixture.database, fixture.workspaceId, { now: fixture.clock.now });
    const iterations = new KnowledgeIterationService(fixture.root, fixture.database, fixture.workspaceId,
      { now: fixture.clock.now, facts, retriever, proposals });
    const quality = new QualityService(fixture.database, fixture.workspaceId, { now: fixture.clock.now,
      workCopies: fixture.workCopies, validation: fixture.validation });
    const reviews = new ReviewService(fixture.database, fixture.workspaceId, { now: fixture.clock.now,
      validation: fixture.validation, quality });
    const exports = new ExportService({ database: fixture.database, root: fixture.root, trustedWorkspaceId: fixture.workspaceId,
      now: fixture.clock.now, workCopies: fixture.workCopies, validation: fixture.validation, quality });
    const api = new WorkflowApi({ imports: fixture.imports,
      reimports: new ReimportService({ database: fixture.database, root: fixture.root, trustedWorkspaceId: fixture.workspaceId, now: fixture.clock.now }),
      states: fixture.states, workCopies: fixture.workCopies, validation: fixture.validation, quality, reviews, exports,
      investigations, proposals, iterations, retriever });

    let completed = 0;
    for (const [index, source] of selected.entries()) {
      const targetLanguage = ["zh-CN", "ja", "en"][index % 3];
      const imported = await runWorkflowCli(api, ["document:import", JSON.stringify({ format: source.format, content: source.content, title: source.id })]);
      runWorkflowCli(api, ["document:confirm", JSON.stringify({ importId: imported.importId, actor: user })]);
      const workflowId = randomUUID();
      runWorkflowCli(api, ["workflow:create", JSON.stringify({ importId: imported.importId, workflowId, targetLanguage })]);
      const bundle = runWorkflowCli(api, ["working-copy:get", JSON.stringify({ workflowId })]);
      const gap = bundle.segments.find((segment) => segment.sourceText.includes("Nebulon"));
      assert.ok(gap);
      const emptyEvidence = evidence.capture({ workflowId, segmentId: gap.segmentId, query: "Nebulon",
        kinds: ["term"], tags: [], topK: 5 });
      assert.equal(emptyEvidence.hits.length, 0);
      const task = orchestrator(fixture).enqueue(enqueueInput({ workflowId, documentId: imported.documentId,
        sourceRevisionId: imported.sourceRevisionId, targetLanguage, segmentId: gap.segmentId }, `m5-6-${index}`, {
        segmentIds: [gap.segmentId],
      }));
      const investigation = runWorkflowCli(api, ["internet:create", JSON.stringify({ request: {
        taskId: task.task.task_id, workflowId, segmentId: gap.segmentId, query: "Nebulon terminology",
        maxResults: 1, country: "US", searchLanguage: "en",
      }, actor: user })]);
      const search = await runWorkflowCli(api, ["internet:search", JSON.stringify({ investigationId: investigation.investigationId })]);
      const snapshot = await runWorkflowCli(api, ["internet:fetch", JSON.stringify({ investigationId: investigation.investigationId,
        resultId: search.results[0].resultId, handle: search.results[0].handle, actor: user })]);
      const proposed = termInput({ language: targetLanguage,
        scope: { targetLanguages: [targetLanguage], tags: [], documentIds: [imported.documentId] },
        content: { term: "Nebulon", preferredTranslations: [{ language: targetLanguage, text: translations[targetLanguage] }],
          forbiddenTranslations: [], variants: [], note: "Approved public synthetic proposal" } });
      const proposal = runWorkflowCli(api, ["proposal:create", JSON.stringify({ request: { investigationId: investigation.investigationId,
        fetchSnapshotId: snapshot.fetchSnapshotId, operation: "create", proposedSource: proposed }, actor: { type: "system", id: "proposal-generator" } })]);
      runWorkflowCli(api, ["proposal:decide", JSON.stringify({ proposalId: proposal.proposalId, expectedVersion: 0,
        decision: index % 4 === 3 ? "rejected" : "approved", actor: user })]);
      if (index % 4 === 3) {
        await assert.rejects(runWorkflowCli(api, ["proposal:apply", JSON.stringify({ proposalId: proposal.proposalId, actor: user })]), /not approved/);
        const replacement = termInput({ language: targetLanguage,
          scope: { targetLanguages: [targetLanguage], tags: [], documentIds: [imported.documentId] },
          content: { term: "Nebulon", preferredTranslations: [{ language: targetLanguage, text: translations[targetLanguage] }],
            forbiddenTranslations: [], variants: [], note: "Approved replacement proposal" } });
        const second = runWorkflowCli(api, ["proposal:create", JSON.stringify({ request: { investigationId: investigation.investigationId,
          fetchSnapshotId: snapshot.fetchSnapshotId, operation: "create", proposedSource: replacement }, actor: user })]);
        runWorkflowCli(api, ["proposal:decide", JSON.stringify({ proposalId: second.proposalId, expectedVersion: 0, decision: "approved", actor: user })]);
        await runWorkflowCli(api, ["proposal:apply", JSON.stringify({ proposalId: second.proposalId, actor: user })]);
      } else await runWorkflowCli(api, ["proposal:apply", JSON.stringify({ proposalId: proposal.proposalId, actor: user })]);
      assert.equal(evidence.currentStatus(emptyEvidence.evidenceId).current, false);
      const currentEvidence = evidence.capture({ workflowId, segmentId: gap.segmentId, query: "Nebulon",
        kinds: ["term"], tags: [], topK: 5 });
      assert.equal(currentEvidence.hits.length, 1);

      for (const segment of bundle.segments) {
        const goodText = segment.sourceText.replaceAll("Nebulon", translations[targetLanguage]);
        if (segment.segmentId === gap.segmentId) {
          runWorkflowCli(api, ["candidate:add", JSON.stringify({ workflowId, segmentId: segment.segmentId,
            text: segment.sourceText, actor: { type: "fixture", id: "candidate-a" } })]);
        }
        const good = runWorkflowCli(api, ["candidate:add", JSON.stringify({ workflowId, segmentId: segment.segmentId,
          text: goodText, actor: { type: "fixture", id: "candidate-b" } })]);
        if (segment.segmentId === gap.segmentId) {
          const ids = runWorkflowCli(api, ["candidate:list", JSON.stringify({ workflowId, segmentId: segment.segmentId })]).map((item) => item.candidateId);
          const comparison = runWorkflowCli(api, ["quality:compare", JSON.stringify({ workflowId, segmentId: segment.segmentId,
            candidateIds: ids, evidenceIds: [currentEvidence.evidenceId] })]);
          assert.equal(comparison.members.length, 2);
        }
        const head = runWorkflowCli(api, ["candidate:select", JSON.stringify({ workflowId, segmentId: segment.segmentId,
          candidateId: good.candidateId, expectedHeadVersion: null, actor: user })]);
        runWorkflowCli(api, ["working-copy:edit", JSON.stringify({ workflowId, segmentId: segment.segmentId,
          expectedHeadVersion: head.version, text: goodText, actor: user })]);
      }
      const validation = runWorkflowCli(api, ["validate", JSON.stringify({ workflowId })]);
      for (const finding of validation.findings.filter((item) => item.severity === "warning")) runWorkflowCli(api,
        ["warning:confirm", JSON.stringify({ workflowId, validationRunId: validation.validationRunId, findingId: finding.findingId, actor: user })]);
      const qualityRun = runWorkflowCli(api, ["quality:run-working", JSON.stringify({ workflowId, evidenceIds: [currentEvidence.evidenceId] })]);
      for (const finding of qualityRun.findings.filter((item) => item.severity === "warning")) runWorkflowCli(api,
        ["quality:confirm-warning", JSON.stringify({ workflowId, qualityRunId: qualityRun.qualityRunId, findingId: finding.findingId, actor: user })]);
      runWorkflowCli(api, ["review", JSON.stringify({ workflowId, validationRunId: validation.validationRunId,
        qualityRunId: qualityRun.qualityRunId, expectedWorkflowVersion: 0, actor: user })]);
      runWorkflowCli(api, ["approve", JSON.stringify({ workflowId, validationRunId: validation.validationRunId,
        qualityRunId: qualityRun.qualityRunId, expectedWorkflowVersion: 1, actor: user })]);
      const ordinary = await runWorkflowCli(api, ["export", JSON.stringify({ workflowId, validationRunId: validation.validationRunId,
        qualityRunId: qualityRun.qualityRunId, format: source.format })]);
      const canonical = await runWorkflowCli(api, ["export", JSON.stringify({ workflowId, validationRunId: validation.validationRunId,
        qualityRunId: qualityRun.qualityRunId, format: "canonical" })]);
      assert.equal(ordinary.manifest.artifact_format, source.format);
      assert.equal(canonical.manifest.artifact_format, "canonical");
      completed += 1;
    }
    assert.equal(completed, 12);
    assert.equal(fixture.database.pragma("foreign_key_check").length, 0);
  } finally { await fixture.close(); }
});
