import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stableJson } from "../../src/domain/contracts.mjs";
import { EvidenceService } from "../../src/knowledge/evidence-service.mjs";
import { KnowledgeFactService } from "../../src/knowledge/fact-service.mjs";
import { FtsRetriever } from "../../src/knowledge/fts-retriever.mjs";
import { providerResponseContract } from "../../src/provider/contracts.mjs";
import { PricingBudgetService } from "../../src/provider/cost-budget.mjs";
import { TranslationTaskOrchestrator } from "../../src/provider/task-orchestrator.mjs";
import { TranslationExecutor } from "../../src/provider/translation-executor.mjs";
import { ManualRetranslationService } from "../../src/research/manual-retranslation-service.mjs";
import { termInput } from "../m5-1/helpers.mjs";
import { workspace } from "../m3-4/helpers.mjs";
import { createExportable } from "../m3-5/helpers.mjs";
import { user } from "../m5r-2/helpers.mjs";

function rows(database, table, workspaceId, workflowId) {
  const column = table === "translation_candidates" ? "workflow_id" : table === "review_events" ? "workflow_id" : "workflow_id";
  return stableJson(database.prepare(`SELECT * FROM ${table} WHERE workspace_id = ? AND ${column} = ? ORDER BY rowid`).all(workspaceId, workflowId));
}

test("six confirmed and exported translations remain immutable until a user triggers evidence-bound retranslation", async () => {
  const fixture = await workspace("lectoria-m5r-5-history-"); const now = () => new Date(0);
  try {
    const facts = new KnowledgeFactService(fixture.root, fixture.database, fixture.workspaceId, { now });
    const retriever = new FtsRetriever(fixture.root, fixture.database, fixture.workspaceId, { now }); await retriever.rebuild();
    const evidence = new EvidenceService(fixture.database, fixture.workspaceId, retriever, { now });
    const tasks = new TranslationTaskOrchestrator(fixture.database, fixture.workspaceId, { now });
    const budgets = new PricingBudgetService(fixture.database, fixture.workspaceId, { now });
    budgets.addPricing({ providerId: "fake-primary", modelId: "m5r-5-model", pricingVersion: "m5r-5-price", currency: "USD",
      inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, cachedInputMicrosPerMillion: 0, source: "offline-fixture" });
    budgets.addPolicy({ policyVersion: "m5r-5-budget", currency: "USD", softLimitMicros: 10_000, hardLimitMicros: 20_000, unknownPriceAction: "block" });
    const manual = new ManualRetranslationService(fixture.database, fixture.workspaceId, { evidence, now, tasks });
    const executor = new TranslationExecutor(fixture.database, fixture.workspaceId, { orchestrator: tasks, budgets, evidenceService: evidence,
      pricingVersion: "m5r-5-price", credentialRef: "local:offline", workerId: "m5r-5-worker", now,
      invokeProvider: async (request) => providerResponseContract({ responseId: randomUUID(), providerId: request.providerId, modelId: request.modelId,
        candidates: [{ segmentId: request.segments[0].segmentId, text: `Translated ${request.segments[0].sourceText}` }],
        usage: { inputTokens: 20, outputTokens: 10, cachedInputTokens: 0, totalTokens: 30 } }, request) });
    let completed = 0;
    for (let index = 0; index < 6; index += 1) {
      const term = `workspace${index}`; const targetLanguage = ["fr", "zh-CN", "ja"][index % 3];
      const prepared = await createExportable(fixture, { id: `history-${index}`, format: ["markdown", "html", "text"][index % 3],
        targetLanguage, content: ["markdown", "html", "text"][index % 3] === "markdown" ? `# Guide\n\nUse ${term} safely.`
          : ["markdown", "html", "text"][index % 3] === "html" ? `<article><p>Use ${term} safely.</p></article>` : `Use ${term} safely.` },
      (segment) => `Confirmed ${segment.sourceText}`);
      await prepared.exports.export(prepared.workflow.workflowId, prepared.run.validationRunId, prepared.workflow.format);
      await prepared.exports.export(prepared.workflow.workflowId, prepared.run.validationRunId, "canonical");
      const segment = prepared.workflow.segments.find((item) => item.sourceText.includes(term)); assert.ok(segment);
      const before = { candidates: rows(fixture.database, "translation_candidates", fixture.workspaceId, prepared.workflow.workflowId),
        reviews: rows(fixture.database, "review_events", fixture.workspaceId, prepared.workflow.workflowId),
        exports: rows(fixture.database, "export_records", fixture.workspaceId, prepared.workflow.workflowId) };
      const source = termInput({ factId: randomUUID(), revisionId: randomUUID(), language: targetLanguage,
        scope: { targetLanguages: [targetLanguage], tags: [], documentIds: [prepared.workflow.documentId] },
        content: { term, preferredTranslations: [{ language: targetLanguage, text: `approved-${index}` }], forbiddenTranslations: [], variants: [], note: "M5R.5 approved knowledge" } });
      await facts.create(source, { type: "fixture", id: "m5r-5-fact" }); await retriever.rebuild();
      assert.deepEqual({ candidates: rows(fixture.database, "translation_candidates", fixture.workspaceId, prepared.workflow.workflowId),
        reviews: rows(fixture.database, "review_events", fixture.workspaceId, prepared.workflow.workflowId),
        exports: rows(fixture.database, "export_records", fixture.workspaceId, prepared.workflow.workflowId) }, before);
      const request = { workflowId: prepared.workflow.workflowId, segmentId: segment.segmentId, query: term, kinds: ["term"], tags: [], topK: 5,
        providerId: "fake-primary", modelId: "m5r-5-model", idempotencyKey: `m5r-5-history-${index}` };
      assert.throws(() => manual.trigger(request, { type: "system", id: "automatic" }), /only a user/);
      const triggered = manual.trigger(request, user); assert.equal(manual.trigger(request, user).reused, true);
      budgets.assignTask(triggered.task.task.task_id, "m5r-5-budget");
      const result = await executor.executeNext(); assert.equal(result.status, "completed");
      const oldCandidates = JSON.parse(before.candidates);
      const retained = fixture.database.prepare("SELECT * FROM translation_candidates WHERE workspace_id = ? AND workflow_id = ? AND candidate_id <> ? ORDER BY rowid")
        .all(fixture.workspaceId, prepared.workflow.workflowId, result.candidate.candidateId);
      assert.deepEqual(retained, oldCandidates);
      assert.equal(rows(fixture.database, "review_events", fixture.workspaceId, prepared.workflow.workflowId), before.reviews);
      assert.equal(rows(fixture.database, "export_records", fixture.workspaceId, prepared.workflow.workflowId), before.exports);
      completed += 1;
    }
    assert.equal(completed, 6);
  } finally { await fixture.close(); }
});
