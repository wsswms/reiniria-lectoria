import { createHash, randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { factSourceContract } from "../knowledge/contracts.mjs";

export const PROPOSAL_POLICY_VERSION = "internet-knowledge-proposal-v1";
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export class ProposalConflictError extends Error {
  constructor(message = "knowledge proposal conflict") {
    super(message);
    this.name = "ProposalConflictError";
    this.code = "PROPOSAL_CONFLICT";
  }
}

function actor(input, allowed) {
  if (!input || !allowed.includes(input.type) || typeof input.id !== "string" || input.id.length === 0) throw new ProposalConflictError("proposal actor is not allowed");
  return input;
}

function exact(input, keys) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("proposal request must be an object");
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw new TypeError("proposal request contains an unknown field");
}

export class KnowledgeProposalService {
  constructor(database, trustedWorkspaceId, { now = () => new Date(), id = () => randomUUID(), policyVersion = PROPOSAL_POLICY_VERSION } = {}) {
    this.database = database;
    this.workspaceId = trustedWorkspaceId;
    this.now = now;
    this.id = id;
    this.policyVersion = policyVersion;
  }

  create(input, actorInput) {
    exact(input, ["investigationId", "fetchSnapshotId", "operation", "proposedSource", "baseFactRevisionId"]);
    const by = actor(actorInput, ["user", "system", "fixture"]);
    const source = factSourceContract(input.proposedSource);
    if (!new Set(["create", "revise"]).has(input.operation)) throw new TypeError("proposal operation is invalid");
    this.#validateBase(input.operation, source.factId, input.baseFactRevisionId);
    const scope = this.#scope(input.investigationId, input.fetchSnapshotId);
    const proposalId = this.id();
    const revisionId = this.id();
    const timestamp = this.now().toISOString();
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO knowledge_proposals VALUES (?, ?, 'legacy-investigation', ?, NULL, ?, ?, ?)")
        .run(this.workspaceId, proposalId, input.investigationId, scope.workflowId, scope.segmentId, timestamp);
      this.#insertRevision({ proposalId, revisionId, version: 1, evidenceKind: "legacy-fetch", investigationId: input.investigationId,
        fetchSnapshotId: input.fetchSnapshotId, operation: input.operation, source, baseFactRevisionId: input.baseFactRevisionId ?? null, by, timestamp });
      this.database.prepare("INSERT INTO knowledge_proposal_heads VALUES (?, ?, ?, 1, 0, 'draft', ?)")
        .run(this.workspaceId, proposalId, revisionId, timestamp);
      this.#event(input.investigationId, "proposal-created", { proposalId, proposalRevisionId: revisionId });
    })();
    return this.get(proposalId);
  }

  createFromResearch(input, actorInput) {
    exact(input, ["runId", "directSnapshotId", "segmentId", "operation", "proposedSource", "baseFactRevisionId"]);
    const by = actor(actorInput, ["user", "system", "fixture"]);
    const source = factSourceContract(input.proposedSource);
    if (!new Set(["create", "revise"]).has(input.operation)) throw new TypeError("proposal operation is invalid");
    this.#validateBase(input.operation, source.factId, input.baseFactRevisionId);
    const scope = this.#researchScope(input.runId, input.directSnapshotId, input.segmentId);
    const proposalId = this.id(); const revisionId = this.id(); const timestamp = this.now().toISOString();
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO knowledge_proposals VALUES (?, ?, 'research-run', NULL, ?, ?, ?, ?)")
        .run(this.workspaceId, proposalId, input.runId, scope.workflowId, input.segmentId, timestamp);
      this.#insertRevision({ proposalId, revisionId, version: 1, evidenceKind: "direct-fetch", researchRunId: input.runId,
        directSnapshotId: input.directSnapshotId, operation: input.operation, source,
        baseFactRevisionId: input.baseFactRevisionId ?? null, by, timestamp });
      this.database.prepare("INSERT INTO knowledge_proposal_heads VALUES (?, ?, ?, 1, 0, 'draft', ?)")
        .run(this.workspaceId, proposalId, revisionId, timestamp);
    })();
    return this.get(proposalId);
  }

  revise(proposalId, expectedVersion, input, actorInput) {
    exact(input, ["fetchSnapshotId", "directSnapshotId", "operation", "proposedSource", "baseFactRevisionId"]);
    const by = actor(actorInput, ["user", "system", "fixture"]);
    const current = this.get(proposalId);
    if (current.head.state !== "draft" || current.head.version !== expectedVersion) throw new ProposalConflictError("proposal version conflict");
    const source = factSourceContract(input.proposedSource);
    this.#validateBase(input.operation, source.factId, input.baseFactRevisionId);
    if (current.originKind === "legacy-investigation") this.#scope(current.investigationId, input.fetchSnapshotId);
    else this.#researchScope(current.researchRunId, input.directSnapshotId, current.segmentId);
    const revisionId = this.id();
    const timestamp = this.now().toISOString();
    this.database.transaction(() => {
      this.#insertRevision({ proposalId, revisionId, version: current.head.revisionVersion + 1,
        evidenceKind: current.originKind === "legacy-investigation" ? "legacy-fetch" : "direct-fetch",
        investigationId: current.investigationId, fetchSnapshotId: input.fetchSnapshotId,
        researchRunId: current.researchRunId, directSnapshotId: input.directSnapshotId,
        operation: input.operation, source, baseFactRevisionId: input.baseFactRevisionId ?? null, by, timestamp });
      const changed = this.database.prepare(`UPDATE knowledge_proposal_heads SET proposal_revision_id = ?,
        revision_version = revision_version + 1, version = version + 1, updated_at = ?
        WHERE workspace_id = ? AND proposal_id = ? AND state = 'draft' AND version = ?`)
        .run(revisionId, timestamp, this.workspaceId, proposalId, expectedVersion).changes;
      if (changed !== 1) throw new ProposalConflictError("proposal version conflict");
      if (current.investigationId) this.#event(current.investigationId, "proposal-revised", { proposalId, proposalRevisionId: revisionId });
    })();
    return this.get(proposalId);
  }

  decide(proposalId, expectedVersion, decision, actorInput) {
    const by = actor(actorInput, ["user"]);
    if (!new Set(["approved", "rejected"]).has(decision)) throw new TypeError("proposal decision is invalid");
    const current = this.get(proposalId);
    if (!current.current) throw new ProposalConflictError("proposal is stale");
    const timestamp = this.now().toISOString();
    try {
      this.database.transaction(() => {
        const changed = this.database.prepare(`UPDATE knowledge_proposal_heads SET state = ?, version = version + 1, updated_at = ?
          WHERE workspace_id = ? AND proposal_id = ? AND state = 'draft' AND version = ?`)
          .run(decision, timestamp, this.workspaceId, proposalId, expectedVersion).changes;
        if (changed !== 1) throw new ProposalConflictError("proposal decision conflict");
        this.database.prepare("INSERT INTO knowledge_proposal_decisions VALUES (?, ?, ?, ?, ?, 'user', ?, ?)")
          .run(this.workspaceId, this.id(), proposalId, current.head.proposalRevisionId, decision, by.id, timestamp);
        if (current.investigationId) this.#event(current.investigationId, `proposal-${decision}`, { proposalId, proposalRevisionId: current.head.proposalRevisionId });
      })();
    } catch (error) {
      if (error instanceof ProposalConflictError || error?.code?.startsWith("SQLITE_CONSTRAINT")) throw new ProposalConflictError("proposal decision conflict");
      throw error;
    }
    return this.get(proposalId);
  }

  get(proposalId) {
    const row = this.database.prepare(`SELECT proposal.proposal_id AS proposalId, proposal.origin_kind AS originKind,
      proposal.investigation_id AS investigationId, proposal.research_run_id AS researchRunId,
      proposal.workflow_id AS workflowId, proposal.segment_id AS segmentId,
      revision.proposal_revision_id AS proposalRevisionId, revision.evidence_kind AS evidenceKind,
      revision.fetch_snapshot_id AS fetchSnapshotId, revision.direct_snapshot_id AS directSnapshotId,
      revision.version AS revisionVersion, revision.operation, revision.fact_id AS factId,
      revision.base_fact_revision_id AS baseFactRevisionId, revision.proposed_source_json AS proposedSourceJson,
      revision.proposed_source_digest AS proposedSourceDigest, revision.proposal_policy_version AS proposalPolicyVersion,
      head.version AS headVersion, head.state, head.updated_at AS updatedAt
      FROM knowledge_proposals AS proposal JOIN knowledge_proposal_heads AS head
        ON head.workspace_id = proposal.workspace_id AND head.proposal_id = proposal.proposal_id
      JOIN knowledge_proposal_revisions AS revision
        ON revision.workspace_id = head.workspace_id AND revision.proposal_revision_id = head.proposal_revision_id
      WHERE proposal.workspace_id = ? AND proposal.proposal_id = ?`).get(this.workspaceId, proposalId);
    if (!row) throw new ProposalConflictError("proposal not found");
    const status = this.currentStatus(row);
    const application = this.database.prepare(`SELECT application_id AS applicationId, proposal_revision_id AS proposalRevisionId,
      fact_id AS factId, fact_revision_id AS factRevisionId, actor_id AS actorId, applied_at AS appliedAt
      FROM knowledge_proposal_applications WHERE workspace_id = ? AND proposal_id = ?`).get(this.workspaceId, row.proposalId);
    return Object.freeze({ proposalId: row.proposalId, originKind: row.originKind, investigationId: row.investigationId,
      researchRunId: row.researchRunId, workflowId: row.workflowId,
      segmentId: row.segmentId, revision: Object.freeze({ proposalRevisionId: row.proposalRevisionId,
        evidenceKind: row.evidenceKind, fetchSnapshotId: row.fetchSnapshotId, directSnapshotId: row.directSnapshotId,
        version: row.revisionVersion, operation: row.operation,
        factId: row.factId, baseFactRevisionId: row.baseFactRevisionId, proposedSource: JSON.parse(row.proposedSourceJson),
        proposedSourceDigest: row.proposedSourceDigest, proposalPolicyVersion: row.proposalPolicyVersion }),
      head: Object.freeze({ proposalRevisionId: row.proposalRevisionId, revisionVersion: row.revisionVersion,
        version: row.headVersion, state: row.state, updatedAt: row.updatedAt }), current: status.current, staleReason: status.reason,
      application: application ? Object.freeze(application) : null });
  }

  list({ state = null, limit = 100 } = {}) {
    if (state !== null && !new Set(["draft", "approved", "rejected"]).has(state)) throw new TypeError("proposal state is invalid");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError("proposal limit is invalid");
    const rows = this.database.prepare(`SELECT proposal_id AS proposalId
      FROM knowledge_proposal_heads
      WHERE workspace_id = ? ${state ? "AND state = ?" : ""}
      ORDER BY updated_at DESC, proposal_id DESC LIMIT ?`).all(...(state ? [this.workspaceId, state, limit] : [this.workspaceId, limit]));
    return Object.freeze(rows.map(({ proposalId }) => this.get(proposalId)));
  }

  currentStatus(rowOrId) {
    const row = typeof rowOrId === "string" ? this.get(rowOrId) : rowOrId;
    const revision = row.revision ?? { proposalPolicyVersion: row.proposalPolicyVersion, operation: row.operation,
      factId: row.factId, baseFactRevisionId: row.baseFactRevisionId, fetchSnapshotId: row.fetchSnapshotId,
      evidenceKind: row.evidenceKind, directSnapshotId: row.directSnapshotId,
      proposedSource: JSON.parse(row.proposedSourceJson), proposedSourceDigest: row.proposedSourceDigest };
    if (revision.proposalPolicyVersion !== this.policyVersion || sha(stableJson(revision.proposedSource)) !== revision.proposedSourceDigest) return { current: false, reason: "policy-or-content" };
    const snapshot = revision.evidenceKind === "direct-fetch"
      ? this.database.prepare("SELECT 1 FROM research_direct_fetch_snapshots WHERE workspace_id = ? AND snapshot_id = ?")
        .get(this.workspaceId, revision.directSnapshotId)
      : this.database.prepare("SELECT 1 FROM internet_fetch_snapshots WHERE workspace_id = ? AND fetch_snapshot_id = ?")
        .get(this.workspaceId, revision.fetchSnapshotId);
    if (!snapshot) return { current: false, reason: "evidence" };
    if (revision.operation === "create") {
      if (this.database.prepare("SELECT 1 FROM knowledge_facts WHERE workspace_id = ? AND fact_id = ?").get(this.workspaceId, revision.factId)) return { current: false, reason: "fact" };
    } else {
      const head = this.database.prepare("SELECT revision_id AS revisionId FROM knowledge_fact_heads WHERE workspace_id = ? AND fact_id = ?")
        .get(this.workspaceId, revision.factId);
      if (!head || head.revisionId !== revision.baseFactRevisionId) return { current: false, reason: "fact" };
    }
    return { current: true, reason: null };
  }

  #validateBase(operation, factId, baseRevisionId) {
    if (operation === "create") {
      if (baseRevisionId !== undefined && baseRevisionId !== null) throw new ProposalConflictError("create proposal cannot have a base revision");
      if (this.database.prepare("SELECT 1 FROM knowledge_facts WHERE workspace_id = ? AND fact_id = ?").get(this.workspaceId, factId)) throw new ProposalConflictError("create proposal conflicts with an existing fact");
    } else if (operation === "revise") {
      const head = this.database.prepare("SELECT revision_id AS revisionId FROM knowledge_fact_heads WHERE workspace_id = ? AND fact_id = ?")
        .get(this.workspaceId, factId);
      if (!head || head.revisionId !== baseRevisionId) throw new ProposalConflictError("revise proposal base is stale");
    } else throw new TypeError("proposal operation is invalid");
  }

  #scope(investigationId, fetchSnapshotId) {
    const row = this.database.prepare(`SELECT investigation.workflow_id AS workflowId, investigation.segment_id AS segmentId
      FROM internet_investigations AS investigation JOIN internet_fetch_snapshots AS snapshot
        ON snapshot.workspace_id = investigation.workspace_id AND snapshot.investigation_id = investigation.investigation_id
      WHERE investigation.workspace_id = ? AND investigation.investigation_id = ? AND snapshot.fetch_snapshot_id = ?`)
      .get(this.workspaceId, investigationId, fetchSnapshotId);
    if (!row) throw new ProposalConflictError("proposal evidence scope mismatch");
    return row;
  }

  #researchScope(runId, directSnapshotId, segmentId) {
    const row = this.database.prepare(`SELECT request.workflow_id AS workflowId FROM research_runs AS run
      JOIN research_grants AS grant_record ON grant_record.workspace_id = run.workspace_id AND grant_record.grant_id = run.grant_id
      JOIN research_requests AS request ON request.workspace_id = grant_record.workspace_id AND request.request_id = grant_record.request_id
      JOIN research_request_segments AS segment ON segment.workspace_id = request.workspace_id AND segment.request_id = request.request_id
      JOIN research_direct_fetch_snapshots AS snapshot ON snapshot.workspace_id = run.workspace_id AND snapshot.run_id = run.run_id
      WHERE run.workspace_id = ? AND run.run_id = ? AND snapshot.snapshot_id = ? AND segment.segment_id = ?`)
      .get(this.workspaceId, runId, directSnapshotId, segmentId);
    if (!row) throw new ProposalConflictError("proposal evidence scope mismatch");
    return row;
  }

  #insertRevision({ proposalId, revisionId, version, evidenceKind, investigationId = null, fetchSnapshotId = null,
    researchRunId = null, directSnapshotId = null, operation, source, baseFactRevisionId, by, timestamp }) {
    const sourceJson = stableJson(source);
    this.database.prepare("INSERT INTO knowledge_proposal_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.workspaceId, revisionId, proposalId, evidenceKind, investigationId, fetchSnapshotId, researchRunId, directSnapshotId, version, operation,
        source.factId, baseFactRevisionId, sourceJson, sha(sourceJson), this.policyVersion, by.type, by.id, timestamp);
  }

  #event(investigationId, action, details) {
    const canonical = { investigationId, action, details };
    this.database.prepare("INSERT OR IGNORE INTO internet_investigation_events VALUES (?, ?, ?, ?, NULL, ?, ?)")
      .run(this.workspaceId, sha(stableJson(canonical)), investigationId, action, stableJson(details), this.now().toISOString());
  }
}
