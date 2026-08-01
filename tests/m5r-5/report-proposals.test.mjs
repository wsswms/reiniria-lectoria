import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ResearchConflictError } from "../../src/research/foundation-service.mjs";
import { termInput } from "../m5-1/helpers.mjs";
import { system } from "../m5r-2/helpers.mjs";
import { populatedResearchWorkspace, supportedResearchReport, legacyResearchEvidence } from "./helpers.mjs";
import { researchWorkspace } from "../m5r-2/helpers.mjs";
import { ResearchProposalBridge } from "../../src/research/proposal-bridge.mjs";

test("six supported Reports each create and independently apply two existing single-fact Proposal revisions", async () => {
  let reports = 0; let proposals = 0;
  for (let index = 0; index < 6; index += 1) {
    const setup = await populatedResearchWorkspace(`report-${index}`);
    try {
      assert.equal(setup.report.outcome, "supported"); assert.equal(setup.proposals.length, 2);
      assert.equal(new Set(setup.proposals.map((item) => item.proposalId)).size, 2);
      assert.equal(new Set(setup.proposals.map((item) => item.revision.factId)).size, 2);
      assert.equal(new Set(setup.applications.map((item) => item.application.applicationId)).size, 2);
      for (const proposal of setup.proposals) {
        const evidence = setup.fixture.setup.fixture.database.prepare(`SELECT count(*) AS count,
          count(DISTINCT claim_id) AS claims, count(DISTINCT citation_id) AS citations
          FROM knowledge_proposal_research_evidence WHERE workspace_id = ? AND proposal_revision_id = ?`)
          .get(setup.fixture.setup.fixture.workspaceId, proposal.revision.proposalRevisionId);
        assert.deepEqual(evidence, { count: 2, claims: 1, citations: 2 });
        assert.equal(setup.fixture.setup.facts.get(proposal.revision.factId).revision.revisionId, proposal.revision.proposedSource.revisionId);
      }
      reports += 1; proposals += setup.proposals.length;
    } finally { await setup.fixture.close(); }
  }
  assert.equal(reports, 6); assert.equal(proposals, 12);
});

test("a multi-Proposal transaction rolls back completely when two drafts target the same fact", async () => {
  const fixture = await researchWorkspace();
  try {
    const report = await supportedResearchReport(fixture, "rollback"); const legacy = await legacyResearchEvidence(fixture);
    const bridge = new ResearchProposalBridge(fixture.setup.fixture.database, fixture.setup.fixture.workspaceId);
    const factId = randomUUID();
    const source = () => termInput({ factId, revisionId: randomUUID(), language: "en",
      scope: { targetLanguages: ["zh-CN"], tags: [], documentIds: [fixture.setup.workflow.documentId] },
      content: { term: "rollback", preferredTranslations: [{ language: "zh-CN", text: "回滚" }], forbiddenTranslations: [], variants: [], note: "transaction fixture" } });
    const before = fixture.setup.fixture.database.prepare("SELECT count(*) AS count FROM knowledge_proposals WHERE workspace_id = ?")
      .get(fixture.setup.fixture.workspaceId).count;
    assert.throws(() => bridge.createFromReport({ reportId: report.reportId, investigationId: legacy.investigation.investigationId,
      fetchSnapshotId: legacy.fetched.fetchSnapshotId, proposals: [{ operation: "create", proposedSource: source() },
        { operation: "create", proposedSource: source() }] }, system), ResearchConflictError);
    assert.equal(fixture.setup.fixture.database.prepare("SELECT count(*) AS count FROM knowledge_proposals WHERE workspace_id = ?")
      .get(fixture.setup.fixture.workspaceId).count, before);
    assert.equal(fixture.setup.fixture.database.prepare("SELECT count(*) AS count FROM knowledge_proposal_research_evidence WHERE workspace_id = ?")
      .get(fixture.setup.fixture.workspaceId).count, 0);
  } finally { await fixture.close(); }
});

test("a Report claim-binding cut point rolls back the Report and retries to one complete immutable outcome", async () => {
  const fixture = await researchWorkspace(); let claimId;
  try {
    fixture.setup.fixture.database.exec(`CREATE TRIGGER m5r5_report_cut BEFORE INSERT ON research_report_claims
      BEGIN SELECT RAISE(ABORT, 'm5r5 report cut'); END`);
    await assert.rejects(() => supportedResearchReport(fixture, "report-cut", { beforeReport(claim) { claimId = claim.claimId; } }), /report cut/);
    assert.equal(fixture.setup.fixture.database.prepare("SELECT count(*) AS count FROM research_reports WHERE workspace_id = ?")
      .get(fixture.setup.fixture.workspaceId).count, 0);
    fixture.setup.fixture.database.exec("DROP TRIGGER m5r5_report_cut");
    const report = fixture.evidence.report(fixture.run.runId, { questionAnswers: [{ question: "term", answer: "supported", status: "supported" }],
      claimIds: [claimId], usage: fixture.budgets.totals(fixture.grant.grantId) });
    assert.equal(report.outcome, "supported");
    assert.equal(fixture.setup.fixture.database.prepare("SELECT count(*) AS count FROM research_reports WHERE workspace_id = ?")
      .get(fixture.setup.fixture.workspaceId).count, 1);
  } finally { await fixture.close(); }
});
