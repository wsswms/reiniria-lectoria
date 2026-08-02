import { randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { factSourceContract } from "../knowledge/contracts.mjs";
import { KnowledgeFactService } from "../knowledge/fact-service.mjs";
import { FtsRetriever } from "../knowledge/fts-retriever.mjs";
import { contentDigest } from "./contracts.mjs";

export class ContextDispositionConflictError extends Error {
  constructor(message = "context disposition conflict") {
    super(message); this.name = "ContextDispositionConflictError"; this.code = "CONTEXT_DISPOSITION_CONFLICT";
  }
}

function user(input) {
  if (!input || input.type !== "user" || typeof input.id !== "string" || input.id.length === 0) {
    throw new ContextDispositionConflictError("only a user can decide or apply persistent knowledge");
  }
  return input;
}

export class ContextDispositionService {
  constructor(root, database, trustedWorkspaceId, { id = () => randomUUID(), now = () => new Date(), facts = null, retriever = null } = {}) {
    this.database = database; this.workspaceId = trustedWorkspaceId; this.id = id; this.now = now;
    this.facts = facts ?? new KnowledgeFactService(root, database, trustedWorkspaceId, { id, now });
    this.retriever = retriever ?? new FtsRetriever(root, database, trustedWorkspaceId, { id, now });
  }

  decide(workflowId, selections, actorInput) {
    const by = user(actorInput);
    if (!Array.isArray(selections) || selections.length > 256) throw new TypeError("selections must be a bounded array");
    const context = this.database.prepare(`SELECT head.context_revision_id AS contextRevisionId
      FROM temporary_context_heads head JOIN translation_workflows workflow
        ON workflow.workspace_id = head.workspace_id AND workflow.workflow_id = head.workflow_id
      WHERE head.workspace_id = ? AND head.workflow_id = ? AND head.state = 'approved' AND workflow.state = 'exported'`)
      .get(this.workspaceId, workflowId);
    if (!context) throw new ContextDispositionConflictError("an exported M5C workflow with approved context is required");
    const normalized = selections.map((selection) => {
      if (!selection || typeof selection !== "object" || Array.isArray(selection)
        || Object.keys(selection).sort().join(",") !== "contextItemId,proposedSource") throw new TypeError("selection is invalid");
      const item = this.database.prepare("SELECT context_item_id AS contextItemId FROM temporary_context_items WHERE workspace_id = ? AND context_revision_id = ? AND context_item_id = ?")
        .get(this.workspaceId, context.contextRevisionId, selection.contextItemId);
      if (!item) throw new ContextDispositionConflictError("selected context item is not current");
      return Object.freeze({ contextItemId: item.contextItemId, proposedSource: factSourceContract(selection.proposedSource) });
    });
    if (new Set(normalized.map((item) => item.contextItemId)).size !== normalized.length) throw new TypeError("selected context items must be unique");
    const selectedIds = normalized.map((item) => item.contextItemId).sort();
    const dispositionId = this.id(); const timestamp = this.now().toISOString();
    try {
      this.database.transaction(() => {
        this.database.prepare("INSERT INTO context_disposition_decisions VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?)")
          .run(this.workspaceId, dispositionId, workflowId, context.contextRevisionId, stableJson(selectedIds), contentDigest(selectedIds), by.id, timestamp);
        for (const selection of normalized) this.database.prepare("INSERT INTO context_persistence_proposals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(this.workspaceId, this.id(), dispositionId, workflowId, context.contextRevisionId, selection.contextItemId,
            stableJson(selection.proposedSource), contentDigest(selection.proposedSource), timestamp);
        this.database.prepare("UPDATE translation_flow_controls SET flow_state = 'closed', outcome_state = 'complete', version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND flow_state = 'disposition'")
          .run(timestamp, this.workspaceId, workflowId);
      }).immediate();
    } catch (error) {
      if (error instanceof ContextDispositionConflictError) throw error;
      throw new ContextDispositionConflictError(String(error?.message ?? error));
    }
    return this.get(workflowId);
  }

  decideProposal(proposalId, decision, actorInput) {
    const by = user(actorInput);
    if (!new Set(["approved", "rejected"]).has(decision)) throw new TypeError("invalid persistence proposal decision");
    const proposal = this.#proposal(proposalId); const decisionId = this.id();
    try {
      this.database.prepare("INSERT INTO context_persistence_proposal_decisions VALUES (?, ?, ?, ?, 'user', ?, ?)")
        .run(this.workspaceId, decisionId, proposalId, decision, by.id, this.now().toISOString());
    } catch { throw new ContextDispositionConflictError("persistence proposal already decided"); }
    return Object.freeze({ ...proposal, decision: Object.freeze({ decisionId, decision, actorId: by.id }) });
  }

  async applyProposal(proposalId, actorInput) {
    const by = user(actorInput); const existing = this.#application(proposalId);
    if (existing) return Object.freeze({ application: existing, manifest: this.retriever.manifest() });
    const proposal = this.#proposal(proposalId);
    const decision = this.database.prepare("SELECT decision_id AS decisionId, decision, actor_id AS actorId FROM context_persistence_proposal_decisions WHERE workspace_id = ? AND proposal_id = ?")
      .get(this.workspaceId, proposalId);
    if (!decision || decision.decision !== "approved") throw new ContextDispositionConflictError("persistence proposal is not approved");
    let fact;
    try { fact = this.facts.get(proposal.proposedSource.factId); } catch {}
    if (!fact) fact = await this.facts.create(proposal.proposedSource, by);
    if (stableJson(fact.source) !== stableJson(proposal.proposedSource)) throw new ContextDispositionConflictError("persistent fact conflicts with proposal");
    try {
      this.database.prepare("INSERT INTO context_persistence_proposal_applications VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?)")
        .run(this.workspaceId, this.id(), proposalId, decision.decisionId, fact.source.factId, fact.source.revisionId, by.id, this.now().toISOString());
    } catch (error) { if (!error?.code?.startsWith("SQLITE_CONSTRAINT")) throw error; }
    const manifest = await this.retriever.rebuild();
    return Object.freeze({ application: this.#application(proposalId), manifest });
  }

  get(workflowId) {
    const row = this.database.prepare("SELECT disposition_id AS dispositionId, context_revision_id AS contextRevisionId, selected_item_ids_json AS selectedIdsJson, actor_id AS actorId, decided_at AS decidedAt FROM context_disposition_decisions WHERE workspace_id = ? AND workflow_id = ?")
      .get(this.workspaceId, workflowId);
    if (!row) throw new ContextDispositionConflictError("context disposition not found");
    const proposals = this.database.prepare(`SELECT proposal.proposal_id AS proposalId FROM context_persistence_proposals proposal
      WHERE proposal.workspace_id = ? AND proposal.disposition_id = ? ORDER BY proposal.proposal_id`).all(this.workspaceId, row.dispositionId)
      .map((item) => this.#proposal(item.proposalId));
    return Object.freeze({ ...row, selectedItemIds: Object.freeze(JSON.parse(row.selectedIdsJson)), proposals: Object.freeze(proposals) });
  }

  #proposal(proposalId) {
    const row = this.database.prepare(`SELECT proposal_id AS proposalId, disposition_id AS dispositionId, workflow_id AS workflowId,
      context_revision_id AS contextRevisionId, context_item_id AS contextItemId, proposed_source_json AS proposedSourceJson,
      proposed_source_digest AS proposedSourceDigest, created_at AS createdAt
      FROM context_persistence_proposals WHERE workspace_id = ? AND proposal_id = ?`).get(this.workspaceId, proposalId);
    if (!row) throw new ContextDispositionConflictError("persistence proposal not found");
    const proposedSource = factSourceContract(JSON.parse(row.proposedSourceJson));
    if (contentDigest(proposedSource) !== row.proposedSourceDigest) throw new ContextDispositionConflictError("persistence proposal integrity failed");
    const decision = this.database.prepare("SELECT decision_id AS decisionId, decision, actor_id AS actorId FROM context_persistence_proposal_decisions WHERE workspace_id = ? AND proposal_id = ?")
      .get(this.workspaceId, proposalId) ?? null;
    return Object.freeze({ ...row, proposedSource, decision: decision && Object.freeze(decision), application: this.#application(proposalId) });
  }

  #application(proposalId) {
    const row = this.database.prepare("SELECT application_id AS applicationId, proposal_id AS proposalId, fact_id AS factId, fact_revision_id AS factRevisionId, actor_id AS actorId, applied_at AS appliedAt FROM context_persistence_proposal_applications WHERE workspace_id = ? AND proposal_id = ?")
      .get(this.workspaceId, proposalId);
    return row ? Object.freeze(row) : null;
  }
}
