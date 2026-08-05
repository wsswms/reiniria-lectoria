import { KnowledgeProposalService } from "../search/knowledge-proposal-service.mjs";
import { ResearchConflictError } from "./foundation-service.mjs";

function actor(input) {
  if (!input || !new Set(["user", "system", "fixture"]).has(input.type) || typeof input.id !== "string" || input.id.length === 0) throw new TypeError("proposal draft actor is invalid");
  return input;
}

export class ResearchProposalBridge {
  constructor(database, workspaceId, { proposals = new KnowledgeProposalService(database, workspaceId) } = {}) {
    this.database = database; this.workspaceId = workspaceId; this.proposals = proposals;
  }

  createFromReport({ reportId, investigationId, fetchSnapshotId, runId, directSnapshotId, segmentId, proposals }, actorInput) {
    const by = actor(actorInput);
    if (!Array.isArray(proposals) || proposals.length < 1 || proposals.length > 32) throw new TypeError("report proposals must be bounded");
    const report = this.database.prepare(`SELECT report.report_id AS reportId, report.outcome, request.workflow_id AS workflowId,
      request.source_revision_id AS sourceRevisionId, run.run_id AS runId FROM research_reports AS report
      JOIN research_runs AS run ON run.workspace_id = report.workspace_id AND run.run_id = report.run_id
      JOIN research_grants AS grant_record ON grant_record.workspace_id = run.workspace_id AND grant_record.grant_id = run.grant_id
      JOIN research_requests AS request ON request.workspace_id = grant_record.workspace_id AND request.request_id = grant_record.request_id
      WHERE report.workspace_id = ? AND report.report_id = ?`).get(this.workspaceId, reportId);
    if (!report || !["supported", "partial"].includes(report.outcome)) throw new ResearchConflictError("report cannot produce knowledge proposals");
    const direct = runId !== undefined || directSnapshotId !== undefined || segmentId !== undefined;
    let proposalSegmentId;
    if (direct) {
      if (investigationId !== undefined || fetchSnapshotId !== undefined || runId !== report.runId) throw new ResearchConflictError("report proposal scope mismatch");
      const snapshot = this.database.prepare(`SELECT 1 FROM research_direct_fetch_snapshots AS snapshot
        JOIN research_sources AS source ON source.workspace_id = snapshot.workspace_id AND source.run_id = snapshot.run_id
          AND source.artifact_type = 'fetch-snapshot' AND source.artifact_id = snapshot.snapshot_id
        JOIN research_citations AS citation ON citation.workspace_id = source.workspace_id AND citation.source_id = source.source_id
        JOIN research_claim_citations AS binding ON binding.workspace_id = citation.workspace_id AND binding.citation_id = citation.citation_id
        JOIN research_report_claims AS report_claim ON report_claim.workspace_id = binding.workspace_id
          AND report_claim.claim_id = binding.claim_id
        WHERE snapshot.workspace_id = ? AND snapshot.run_id = ? AND snapshot.snapshot_id = ? AND report_claim.report_id = ?`)
        .get(this.workspaceId, runId, directSnapshotId, reportId);
      if (!snapshot) throw new ResearchConflictError("report proposal scope mismatch");
      proposalSegmentId = segmentId;
    } else {
      const investigation = this.database.prepare(`SELECT workflow_id AS workflowId, segment_id AS segmentId FROM internet_investigations
        WHERE workspace_id = ? AND investigation_id = ?`).get(this.workspaceId, investigationId);
      const snapshot = this.database.prepare("SELECT 1 FROM internet_fetch_snapshots WHERE workspace_id = ? AND investigation_id = ? AND fetch_snapshot_id = ?")
        .get(this.workspaceId, investigationId, fetchSnapshotId);
      if (!investigation || investigation.workflowId !== report.workflowId || !snapshot) throw new ResearchConflictError("report proposal scope mismatch");
      proposalSegmentId = investigation.segmentId;
    }
    const requestSegment = this.database.prepare("SELECT 1 FROM research_request_segments WHERE workspace_id = ? AND request_id = (SELECT request_id FROM research_grants WHERE workspace_id = ? AND grant_id = (SELECT grant_id FROM research_runs WHERE workspace_id = ? AND run_id = (SELECT run_id FROM research_reports WHERE workspace_id = ? AND report_id = ?))) AND segment_id = ?")
      .get(this.workspaceId, this.workspaceId, this.workspaceId, this.workspaceId, reportId, proposalSegmentId);
    if (!requestSegment) throw new ResearchConflictError("report proposal segment scope mismatch");
    const evidence = this.database.prepare(`SELECT binding.claim_id AS claimId, binding.citation_id AS citationId
      FROM research_report_claims AS report_claim JOIN research_claim_citations AS binding
        ON binding.workspace_id = report_claim.workspace_id AND binding.claim_id = report_claim.claim_id
      WHERE report_claim.workspace_id = ? AND report_claim.report_id = ? ORDER BY binding.claim_id, binding.citation_id`)
      .all(this.workspaceId, reportId);
    const output = [];
    const seenFacts = new Set();
    this.database.transaction(() => {
      for (const input of proposals) {
        const factId = input?.proposedSource?.factId;
        if (seenFacts.has(factId)) throw new ResearchConflictError("each proposal must target one distinct fact");
        seenFacts.add(factId);
        const proposalInput = { operation: input.operation, proposedSource: input.proposedSource,
          ...(input.baseFactRevisionId ? { baseFactRevisionId: input.baseFactRevisionId } : {}) };
        const proposal = direct
          ? this.proposals.createFromResearch({ ...proposalInput, runId, directSnapshotId, segmentId: proposalSegmentId }, by)
          : this.proposals.create({ ...proposalInput, investigationId, fetchSnapshotId }, by);
        const insert = this.database.prepare("INSERT INTO knowledge_proposal_research_evidence VALUES (?, ?, ?, ?, ?, ?)");
        evidence.forEach((item, ordinal) => insert.run(this.workspaceId, proposal.revision.proposalRevisionId, reportId, item.claimId, item.citationId, ordinal));
        output.push(proposal);
      }
    })();
    return Object.freeze(output);
  }
}
