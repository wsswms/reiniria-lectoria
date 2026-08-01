import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KnowledgeFactService } from "../../src/knowledge/fact-service.mjs";
import { FtsRetriever } from "../../src/knowledge/fts-retriever.mjs";
import { KnowledgeIterationService } from "../../src/knowledge/iteration-service.mjs";
import { QualityService } from "../../src/quality/quality-service.mjs";
import { RESEARCH_CACHE_CATALOG, ResearchCacheInventoryService } from "../../src/research/cache-inventory-service.mjs";
import { ResearchEvidenceService } from "../../src/research/evidence-service.mjs";
import { ResearchFoundationService } from "../../src/research/foundation-service.mjs";
import { ResearchRunService } from "../../src/research/run-service.mjs";
import { KnowledgeProposalService } from "../../src/search/knowledge-proposal-service.mjs";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../../src/storage/backup.mjs";
import { WorkCopyService } from "../../src/translation/work-copy-service.mjs";
import { WorkspaceManager } from "../../src/workspace/manager.mjs";
import { populatedResearchWorkspace } from "./helpers.mjs";

const RELATION_TABLES = Object.freeze(["research_requests", "research_grants", "research_runs", "research_queries", "research_sources",
  "research_citations", "research_claims", "research_reports", "knowledge_proposals", "knowledge_proposal_revisions",
  "knowledge_proposal_decisions", "knowledge_proposal_applications", "knowledge_facts", "knowledge_fact_revisions",
  "knowledge_evidence_snapshots", "quality_runs", "web_search_artifact_runs", "web_search_artifact_results",
  "provider_content_snapshots", "research_cache_inventory_entries"]);

function counts(database, workspaceId) {
  return Object.fromEntries(RELATION_TABLES.map((table) => [table,
    database.prepare(`SELECT count(*) AS count FROM ${table} WHERE workspace_id = ?`).get(workspaceId).count]));
}

test("cache inventory covers every retained and derived research artifact class with actionable policy", async () => {
  const setup = await populatedResearchWorkspace("cache");
  try {
    const inventory = await new ResearchCacheInventoryService(setup.fixture.setup.fixture.root, setup.fixture.setup.fixture.database,
      setup.fixture.setup.fixture.workspaceId, { now: setup.fixture.now }).recordCurrent();
    assert.equal(inventory.coverage, 1); assert.equal(inventory.entries.length, RESEARCH_CACHE_CATALOG.length);
    assert.equal(new Set(inventory.entries.map((item) => item.artifactType)).size, RESEARCH_CACHE_CATALOG.length);
    for (const item of inventory.entries) {
      for (const field of ["relativeLocation", "purpose", "source", "sensitivity", "backupRelation", "cleanupRecommendation"])
        assert.equal(typeof item[field] === "string" && item[field].length > 0, true, `${item.artifactType}.${field}`);
      assert.equal(Number.isSafeInteger(item.byteLength) && item.byteLength >= 0, true);
      if (item.rebuildable) assert.equal(item.backupRelation, "excluded");
    }
    const recorded = new ResearchCacheInventoryService(setup.fixture.setup.fixture.root, setup.fixture.setup.fixture.database,
      setup.fixture.setup.fixture.workspaceId).listRecorded();
    assert.equal(recorded.length, RESEARCH_CACHE_CATALOG.length);
    assert.throws(() => setup.fixture.setup.fixture.database.prepare("DELETE FROM research_cache_inventory_entries").run(), /immutable/);
  } finally { await setup.fixture.close(); }
});

test("three populated research workspaces preserve the full relationship graph across thirty backup restores", async () => {
  let restored = 0;
  for (let workspaceIndex = 0; workspaceIndex < 3; workspaceIndex += 1) {
    const setup = await populatedResearchWorkspace(`recovery-${workspaceIndex}`); const fixture = setup.fixture;
    try {
      await new ResearchCacheInventoryService(fixture.setup.fixture.root, fixture.setup.fixture.database,
        fixture.setup.fixture.workspaceId, { now: fixture.now }).recordCurrent();
      const expected = counts(fixture.setup.fixture.database, fixture.setup.fixture.workspaceId);
      for (let round = 0; round < 10; round += 1) {
        const backup = join(fixture.setup.fixture.root, `m5r-5-backup-${round}`);
        await createWorkspaceBackup({ database: fixture.setup.fixture.database, workspaceRoot: fixture.setup.fixture.root, destination: backup });
        const target = await mkdtemp(join(tmpdir(), "lectoria-m5r-5-restore-")); const manager = await WorkspaceManager.create(target);
        try {
          await restoreWorkspaceBackup({ backupRoot: backup, manager }); const handle = manager.open(fixture.setup.fixture.workspaceId);
          try {
            assert.deepEqual(counts(handle.database, fixture.setup.fixture.workspaceId), expected);
            const foundation = new ResearchFoundationService(handle.database, fixture.setup.fixture.workspaceId);
            assert.equal(foundation.getRequest(fixture.request.requestId).head.state, "approved");
            assert.equal(foundation.getGrant(fixture.grant.grantId).grant.grantId, fixture.grant.grantId);
            assert.equal(new ResearchRunService(handle.database, fixture.setup.fixture.workspaceId).get(fixture.run.runId).runId, fixture.run.runId);
            assert.equal(new ResearchEvidenceService(handle.database, fixture.setup.fixture.workspaceId).getReport(setup.report.reportId).outcome, "supported");
            const facts = new KnowledgeFactService(handle.root, handle.database, fixture.setup.fixture.workspaceId);
            const retriever = new FtsRetriever(handle.root, handle.database, fixture.setup.fixture.workspaceId);
            const proposalService = new KnowledgeProposalService(handle.database, fixture.setup.fixture.workspaceId);
            const iterations = new KnowledgeIterationService(handle.root, handle.database, fixture.setup.fixture.workspaceId,
              { facts, retriever, proposals: proposalService });
            for (const proposal of setup.proposals) {
              assert.equal(proposalService.get(proposal.proposalId).head.state, "approved");
              assert.equal(iterations.get(proposal.proposalId).factRevisionId, proposal.revision.proposedSource.revisionId);
              assert.equal(facts.get(proposal.revision.factId).revision.revisionId, proposal.revision.proposedSource.revisionId);
            }
            await retriever.rebuild();
            assert.ok(retriever.search({ query: "workspace", language: "zh-CN", kinds: ["term"], tags: [],
              documentIds: [fixture.setup.workflow.documentId], topK: 10 }).some((hit) => hit.factId === setup.proposals[0].revision.factId));
            const quality = new QualityService(handle.database, fixture.setup.fixture.workspaceId,
              { workCopies: new WorkCopyService(handle.database, fixture.setup.fixture.workspaceId) });
            assert.equal(quality.get(setup.qualityRun.qualityRunId).current, false);
            assert.equal(handle.database.pragma("foreign_key_check").length, 0); restored += 1;
          } finally { handle.database.close(); }
        } finally { manager.close(); await rm(target, { recursive: true, force: true }); }
      }
    } finally { await fixture.close(); }
  }
  assert.equal(restored, 30);
});
