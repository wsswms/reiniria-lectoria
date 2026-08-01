import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EvidenceService } from "../../src/knowledge/evidence-service.mjs";
import { KnowledgeFactService } from "../../src/knowledge/fact-service.mjs";
import { FtsRetriever } from "../../src/knowledge/fts-retriever.mjs";
import { KnowledgeIterationService } from "../../src/knowledge/iteration-service.mjs";
import { QualityService } from "../../src/quality/quality-service.mjs";
import { InvestigationService } from "../../src/search/investigation-service.mjs";
import { KnowledgeProposalService } from "../../src/search/knowledge-proposal-service.mjs";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../../src/storage/backup.mjs";
import { WorkCopyService } from "../../src/translation/work-copy-service.mjs";
import { WorkspaceManager } from "../../src/workspace/manager.mjs";
import { internetWorkspace, proposedTerm, searchAndFetch, user } from "../m5-5/helpers.mjs";

test("three workspaces preserve investigation proposal application fact evidence quality and rebuilt FTS across thirty restores", async () => {
  let restored = 0;
  for (let workspaceIndex = 0; workspaceIndex < 3; workspaceIndex += 1) {
    const setup = await internetWorkspace();
    try {
      const workCopies = new WorkCopyService(setup.fixture.database, setup.fixture.workspaceId, { now: setup.fixture.clock.now });
      const candidate = workCopies.addCandidate(setup.workflow.workflowId, setup.workflow.segmentId,
        "请使用工作区备份。", { type: "fixture", id: "backup-candidate" });
      const quality = new QualityService(setup.fixture.database, setup.fixture.workspaceId,
        { now: setup.fixture.clock.now, workCopies });
      const oldQuality = quality.runCandidate(setup.workflow.workflowId, setup.workflow.segmentId, candidate.candidateId,
        { evidenceIds: [setup.bound.snapshot.evidenceId] });
      const flow = await searchAndFetch(setup);
      const proposal = setup.proposals.create({ investigationId: setup.investigation.investigationId,
        fetchSnapshotId: flow.snapshot.fetchSnapshotId, operation: "create",
        proposedSource: proposedTerm(setup, { language: "zh-CN" }) }, user);
      setup.proposals.decide(proposal.proposalId, 0, "approved", user);
      const iterations = new KnowledgeIterationService(setup.fixture.root, setup.fixture.database, setup.fixture.workspaceId,
        { now: setup.fixture.clock.now, facts: setup.facts, retriever: setup.retriever, proposals: setup.proposals });
      const applied = await iterations.apply(proposal.proposalId, user);

      for (let round = 0; round < 10; round += 1) {
        const backup = join(setup.fixture.root, `m5-6-backup-${round}`);
        await createWorkspaceBackup({ database: setup.fixture.database, workspaceRoot: setup.fixture.root, destination: backup });
        const target = await mkdtemp(join(tmpdir(), "lectoria-m5-6-restore-"));
        const manager = await WorkspaceManager.create(target);
        try {
          await restoreWorkspaceBackup({ backupRoot: backup, manager });
          const handle = manager.open(setup.fixture.workspaceId);
          try {
            const facts = new KnowledgeFactService(handle.root, handle.database, setup.fixture.workspaceId);
            const retriever = new FtsRetriever(handle.root, handle.database, setup.fixture.workspaceId);
            const proposals = new KnowledgeProposalService(handle.database, setup.fixture.workspaceId);
            const recoveredIterations = new KnowledgeIterationService(handle.root, handle.database, setup.fixture.workspaceId,
              { facts, retriever, proposals });
            const investigations = new InvestigationService(handle.database, setup.fixture.workspaceId, {
              searchInvoker: async () => { throw new Error("offline"); }, fetchProxy: { fetchSelected: async () => { throw new Error("offline"); } },
              handleKey: Buffer.alloc(32, 5),
            });
            const evidence = new EvidenceService(handle.database, setup.fixture.workspaceId, retriever);
            const restoredQuality = new QualityService(handle.database, setup.fixture.workspaceId,
              { workCopies: new WorkCopyService(handle.database, setup.fixture.workspaceId) });
            assert.equal(facts.get(proposal.revision.factId).revision.revisionId, proposal.revision.proposedSource.revisionId);
            assert.equal(proposals.get(proposal.proposalId).head.state, "approved");
            assert.equal(recoveredIterations.get(proposal.proposalId).applicationId, applied.application.applicationId);
            assert.equal(investigations.getFetch(flow.snapshot.fetchSnapshotId).snapshotDigest, flow.snapshot.snapshotDigest);
            assert.equal(evidence.currentStatus(setup.bound.snapshot.evidenceId).current, false);
            assert.equal(restoredQuality.get(oldQuality.qualityRunId).current, false);
            assert.ok(retriever.search({ query: "workspace", language: "zh-CN", kinds: ["term"], tags: [],
              documentIds: [setup.workflow.documentId], topK: 10 }).some((hit) => hit.factId === proposal.revision.factId));
            assert.equal(handle.database.pragma("foreign_key_check").length, 0);
            restored += 1;
          } finally { handle.database.close(); }
        } finally { manager.close(); await rm(target, { recursive: true, force: true }); }
      }
    } finally { await setup.fixture.close(); }
  }
  assert.equal(restored, 30);
});
