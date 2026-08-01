import { createHash, randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { KnowledgeFactService } from "./fact-service.mjs";
import { FtsRetriever } from "./fts-retriever.mjs";
import { KnowledgeProposalService, ProposalConflictError } from "../search/knowledge-proposal-service.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const databaseLocks = new WeakMap();

function user(actor) {
  if (!actor || actor.type !== "user" || typeof actor.id !== "string" || actor.id.length === 0) {
    throw new ProposalConflictError("only a user can apply an approved proposal");
  }
  return actor;
}

export class KnowledgeIterationService {
  constructor(root, database, trustedWorkspaceId, {
    now = () => new Date(), id = () => randomUUID(), inject = () => {}, facts, retriever, proposals,
  } = {}) {
    this.database = database;
    this.workspaceId = trustedWorkspaceId;
    this.now = now;
    this.id = id;
    this.inject = inject;
    this.facts = facts ?? new KnowledgeFactService(root, database, trustedWorkspaceId, { now, id });
    this.retriever = retriever ?? new FtsRetriever(root, database, trustedWorkspaceId, { now, id });
    this.proposals = proposals ?? new KnowledgeProposalService(database, trustedWorkspaceId, { now, id });
    if (!databaseLocks.has(database)) databaseLocks.set(database, new Map());
    this.pending = databaseLocks.get(database);
  }

  apply(proposalId, actorInput) {
    const actor = user(actorInput);
    const previous = this.pending.get(proposalId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.#apply(proposalId, actor));
    this.pending.set(proposalId, operation);
    return operation.finally(() => { if (this.pending.get(proposalId) === operation) this.pending.delete(proposalId); });
  }

  get(proposalId) {
    const row = this.database.prepare(`SELECT application_id AS applicationId, proposal_id AS proposalId,
      proposal_revision_id AS proposalRevisionId, decision_id AS decisionId, operation,
      fact_id AS factId, fact_revision_id AS factRevisionId, proposed_source_digest AS proposedSourceDigest,
      actor_id AS actorId, applied_at AS appliedAt
      FROM knowledge_proposal_applications WHERE workspace_id = ? AND proposal_id = ?`)
      .get(this.workspaceId, proposalId);
    if (!row) throw new ProposalConflictError("knowledge proposal application not found");
    const proposal = this.proposals.get(proposalId);
    const decision = this.database.prepare(`SELECT proposal_id AS proposalId, proposal_revision_id AS proposalRevisionId,
      decision FROM knowledge_proposal_decisions WHERE workspace_id = ? AND decision_id = ?`)
      .get(this.workspaceId, row.decisionId);
    const fact = this.facts.get(row.factId);
    if (proposal.revision.proposalRevisionId !== row.proposalRevisionId || proposal.revision.operation !== row.operation
      || proposal.revision.factId !== row.factId || proposal.revision.proposedSource.revisionId !== row.factRevisionId
      || proposal.revision.proposedSourceDigest !== row.proposedSourceDigest
      || decision?.proposalId !== proposalId || decision.proposalRevisionId !== row.proposalRevisionId || decision.decision !== "approved"
      || fact.revision.revisionId !== row.factRevisionId || stableJson(fact.source) !== stableJson(proposal.revision.proposedSource)
      || sha(stableJson(fact.source)) !== row.proposedSourceDigest) {
      throw new ProposalConflictError("knowledge proposal application integrity failed");
    }
    return Object.freeze(row);
  }

  async #apply(proposalId, actor) {
    const proposal = this.proposals.get(proposalId);
    if (proposal.head.state !== "approved") throw new ProposalConflictError("knowledge proposal is not approved");
    const decision = this.database.prepare(`SELECT decision_id AS decisionId, proposal_revision_id AS proposalRevisionId,
      decision, actor_id AS actorId FROM knowledge_proposal_decisions
      WHERE workspace_id = ? AND proposal_id = ?`).get(this.workspaceId, proposalId);
    if (!decision || decision.decision !== "approved" || decision.proposalRevisionId !== proposal.revision.proposalRevisionId) {
      throw new ProposalConflictError("knowledge proposal approval is invalid");
    }
    let application;
    try { application = this.get(proposalId); } catch (error) {
      if (!(error instanceof ProposalConflictError)) throw error;
    }
    if (!application) {
      this.inject("before-fact", proposal);
      await this.#applyFact(proposal, actor);
      this.inject("after-fact", proposal);
      const current = this.facts.get(proposal.revision.factId);
      if (current.revision.revisionId !== proposal.revision.proposedSource.revisionId
        || stableJson(current.source) !== stableJson(proposal.revision.proposedSource)) {
        throw new ProposalConflictError("applied knowledge fact does not match proposal");
      }
      const timestamp = this.now().toISOString();
      this.inject("before-application", proposal);
      try {
        this.database.prepare("INSERT INTO knowledge_proposal_applications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?)")
          .run(this.workspaceId, this.id(), proposalId, proposal.revision.proposalRevisionId, decision.decisionId,
            proposal.revision.operation, proposal.revision.factId, proposal.revision.proposedSource.revisionId,
            proposal.revision.proposedSourceDigest, actor.id, timestamp);
      } catch (error) {
        if (!error?.code?.startsWith("SQLITE_CONSTRAINT")) throw error;
      }
      application = this.get(proposalId);
      this.inject("after-application", application);
    } else {
      try {
        const manifest = this.retriever.manifest();
        return Object.freeze({ application, manifest });
      } catch {}
    }
    this.inject("before-rebuild", application);
    const manifest = await this.retriever.rebuild();
    this.inject("after-rebuild", manifest);
    return Object.freeze({ application, manifest });
  }

  async #applyFact(proposal, actor) {
    const source = proposal.revision.proposedSource;
    let current;
    try { current = this.facts.get(source.factId); } catch {}
    if (current?.revision.revisionId === source.revisionId && stableJson(current.source) === stableJson(source)) return current;
    if (proposal.revision.operation === "create") {
      if (current) throw new ProposalConflictError("create proposal conflicts with an existing fact");
      return this.facts.create(source, actor);
    }
    if (!current || current.revision.revisionId !== proposal.revision.baseFactRevisionId) {
      throw new ProposalConflictError("revise proposal base is stale");
    }
    return this.facts.revise(source.factId, current.head.version, source, actor);
  }
}
