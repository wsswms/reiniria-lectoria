import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stableJson } from "../../src/domain/contracts.mjs";
import { EvidenceService } from "../../src/knowledge/evidence-service.mjs";
import { KnowledgeFactService } from "../../src/knowledge/fact-service.mjs";
import { FtsRetriever } from "../../src/knowledge/fts-retriever.mjs";
import { KnowledgeIterationService } from "../../src/knowledge/iteration-service.mjs";
import { providerResponseContract } from "../../src/provider/contracts.mjs";
import { PricingBudgetService } from "../../src/provider/cost-budget.mjs";
import { buildContextManifest } from "../../src/provider/prompt-context.mjs";
import { TranslationTaskOrchestrator } from "../../src/provider/task-orchestrator.mjs";
import { TranslationExecutor } from "../../src/provider/translation-executor.mjs";
import { ManualRetranslationService } from "../../src/research/manual-retranslation-service.mjs";
import { BraveSearchAdapter } from "../../src/search/brave-search-adapter.mjs";
import { RestrictedFetchProxy } from "../../src/search/fetch-proxy.mjs";
import { InvestigationService } from "../../src/search/investigation-service.mjs";
import { KnowledgeProposalService } from "../../src/search/knowledge-proposal-service.mjs";
import { enqueueInput } from "../m4-3/helpers.mjs";
import { termInput } from "../m5-1/helpers.mjs";
import { createExportable } from "../m3-5/helpers.mjs";
import { workspace } from "../m3-4/helpers.mjs";
import { user } from "./helpers.mjs";

function rows(database, table) { return stableJson(database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()); }

test("knowledge application preserves exported history and only a user can launch an evidence-bound retranslation candidate", async () => {
  const fixture = await workspace("lectoria-m5r-2-retranslation-");
  try {
    const prepared = await createExportable(fixture, { id: "manual-retranslation", format: "text", content: "Use workspace safely." },
      (segment) => `Historique: ${segment.sourceText}`);
    const segment = prepared.workflow.segments[0];
    const tasks = new TranslationTaskOrchestrator(fixture.database, fixture.workspaceId, { now: () => new Date(0) });
    const initialContext = buildContextManifest(fixture.database, fixture.workspaceId,
      { workflowId: prepared.workflow.workflowId, segmentIds: [segment.segmentId] });
    const initialTask = tasks.enqueue(enqueueInput({ ...prepared.workflow, segmentId: segment.segmentId }, "proposal-scope",
      { contextDigest: initialContext.contextDigest, promptVersion: initialContext.manifest.promptVersion }));
    const adapter = new BraveSearchAdapter({ fetchImpl: async () => new Response(JSON.stringify({ web: { results: [
      { title: "Synthetic workspace term", url: "https://example.com/workspace", description: "Public synthetic evidence" },
    ] } }), { status: 200, headers: { "content-type": "application/json" } }) });
    const proxy = new RestrictedFetchProxy({ now: () => new Date(0), resolver: async () => ["93.184.216.34"], robotsAllowed: async () => true,
      transport: async () => new Response("<main>Use espace de travail for workspace.</main>",
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }) });
    const investigations = new InvestigationService(fixture.database, fixture.workspaceId, { now: () => new Date(0),
      searchInvoker: (request) => adapter.search(request, { credential: "offline-fixture" }), fetchProxy: proxy, handleKey: Buffer.alloc(32, 3) });
    const investigation = investigations.create({ taskId: initialTask.task.task_id, workflowId: prepared.workflow.workflowId,
      segmentId: segment.segmentId, query: "workspace French term", maxResults: 1, country: "US", searchLanguage: "en" }, user);
    const search = await investigations.search(investigation.investigationId);
    const fetched = await investigations.fetch(investigation.investigationId, search.results[0].resultId, search.results[0].handle, user);
    tasks.cancel(initialTask.task.task_id);
    const facts = new KnowledgeFactService(fixture.root, fixture.database, fixture.workspaceId, { now: () => new Date(0) });
    const retriever = new FtsRetriever(fixture.root, fixture.database, fixture.workspaceId, { now: () => new Date(0) });
    const proposals = new KnowledgeProposalService(fixture.database, fixture.workspaceId, { now: () => new Date(0) });
    const source = termInput({ factId: randomUUID(), revisionId: randomUUID(), language: "fr",
      scope: { targetLanguages: ["fr"], tags: [], documentIds: [prepared.workflow.documentId] },
      content: { term: "workspace", preferredTranslations: [{ language: "fr", text: "espace de travail" }],
        forbiddenTranslations: [], variants: [], note: "Approved synthetic knowledge" } });
    const proposal = proposals.create({ investigationId: investigation.investigationId, fetchSnapshotId: fetched.fetchSnapshotId,
      operation: "create", proposedSource: source }, { type: "system", id: "proposal-drafter" });
    proposals.decide(proposal.proposalId, 0, "approved", user);
    await prepared.exports.export(prepared.workflow.workflowId, prepared.run.validationRunId, "text");
    const before = { candidates: rows(fixture.database, "translation_candidates"), reviews: rows(fixture.database, "review_events"),
      exports: rows(fixture.database, "export_records"), artifacts: rows(fixture.database, "export_artifact_metadata") };
    const iterations = new KnowledgeIterationService(fixture.root, fixture.database, fixture.workspaceId,
      { now: () => new Date(0), facts, retriever, proposals });
    await iterations.apply(proposal.proposalId, user);
    assert.deepEqual({ candidates: rows(fixture.database, "translation_candidates"), reviews: rows(fixture.database, "review_events"),
      exports: rows(fixture.database, "export_records"), artifacts: rows(fixture.database, "export_artifact_metadata") }, before);
    const evidence = new EvidenceService(fixture.database, fixture.workspaceId, retriever, { now: () => new Date(0) });
    const retranslation = new ManualRetranslationService(fixture.database, fixture.workspaceId, { evidence, now: () => new Date(0), tasks });
    const request = { workflowId: prepared.workflow.workflowId, segmentId: segment.segmentId, query: "workspace", kinds: ["term"], tags: [], topK: 5,
      providerId: "fake-primary", modelId: "fixture-model-v2", idempotencyKey: "manual-current-knowledge" };
    for (const actor of [{ type: "system", id: "automatic" }, { type: "model", id: "automatic" }])
      for (let repeat = 0; repeat < 200; repeat += 1) assert.throws(() => retranslation.trigger(request, actor), /only a user/);
    const triggered = retranslation.trigger(request, user);
    assert.equal(triggered.evidence.hits.some((hit) => hit.factId === source.factId && hit.revisionId === source.revisionId), true);
    assert.equal(retranslation.trigger(request, user).reused, true);
    const budgets = new PricingBudgetService(fixture.database, fixture.workspaceId, { now: () => new Date(0) });
    budgets.addPricing({ providerId: "fake-primary", modelId: "fixture-model-v2", pricingVersion: "manual-price-v1", currency: "USD",
      inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0, source: "offline-fixture" });
    budgets.addPolicy({ policyVersion: "manual-budget-v1", currency: "USD", softLimitMicros: 1000, hardLimitMicros: 2000, unknownPriceAction: "block" });
    budgets.assignTask(triggered.task.task.task_id, "manual-budget-v1");
    const executor = new TranslationExecutor(fixture.database, fixture.workspaceId, { orchestrator: tasks, budgets, evidenceService: evidence,
      pricingVersion: "manual-price-v1", credentialRef: "local:offline", workerId: "manual-retranslation-worker", now: () => new Date(0),
      invokeProvider: async (providerRequest) => providerResponseContract({ responseId: "manual-response", providerId: providerRequest.providerId,
        modelId: providerRequest.modelId, candidates: [{ segmentId: segment.segmentId, text: "Utilisez l’espace de travail en toute sécurité." }],
        usage: { inputTokens: 20, outputTokens: 10, cachedInputTokens: 0, totalTokens: 30 } }, providerRequest) });
    assert.equal((await executor.executeNext()).status, "completed");
    assert.equal(fixture.database.prepare("SELECT count(*) AS count FROM translation_candidates").get().count,
      JSON.parse(before.candidates).length + 1);
    assert.equal(rows(fixture.database, "review_events"), before.reviews);
    assert.equal(rows(fixture.database, "export_records"), before.exports);
    const binding = fixture.database.prepare(`SELECT hit.fact_id AS factId, hit.revision_id AS revisionId FROM attempt_evidence_bindings binding
      JOIN knowledge_evidence_hits hit ON hit.workspace_id = binding.workspace_id AND hit.evidence_id = binding.evidence_id
      WHERE binding.workspace_id = ? AND binding.attempt_id = ?`).get(fixture.workspaceId, triggered.task.attempts[0].attempt_id);
    assert.deepEqual(binding, { factId: source.factId, revisionId: source.revisionId });
  } finally { await fixture.close(); }
});
