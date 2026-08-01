import { createHash, randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { researchGrantContract, researchRequestContract } from "./contracts.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export class ResearchConflictError extends Error {}
export class ResearchAuthorizationError extends Error {}

function exact(input, keys, name) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw new TypeError(`${name} contains an unknown field`);
}

function actor(input, allowed) {
  exact(input, ["type", "id"], "actor");
  if (!allowed.includes(input.type) || typeof input.id !== "string" || input.id.length < 1 || input.id.length > 255) throw new ResearchAuthorizationError("actor is not authorized");
  return input;
}

export class ResearchFoundationService {
  constructor(database, workspaceId, { now = () => new Date(), id = randomUUID } = {}) {
    this.database = database;
    this.workspaceId = workspaceId;
    this.now = now;
    this.id = id;
  }

  createRequest(input, actorInput) {
    const request = researchRequestContract(input);
    const by = actor(actorInput, ["user", "system", "model", "fixture"]);
    if (request.origin.type !== by.type || request.origin.id !== by.id) throw new ResearchAuthorizationError("request origin does not match actor");
    const task = this.database.prepare(`SELECT task_id AS taskId, workflow_id AS workflowId, document_id AS documentId,
      source_revision_id AS sourceRevisionId, target_language AS targetLanguage
      FROM translation_tasks WHERE workspace_id = ? AND task_id = ?`).get(this.workspaceId, request.taskId);
    if (!task || task.workflowId !== request.workflowId || task.documentId !== request.documentId ||
      task.sourceRevisionId !== request.sourceRevisionId || task.targetLanguage !== request.targetLanguage) throw new ResearchConflictError("request task scope mismatch");
    const segment = this.database.prepare("SELECT segment_id FROM source_segment_versions WHERE workspace_id = ? AND source_revision_id = ? AND segment_id = ?");
    for (const segmentId of request.segmentIds) if (!segment.get(this.workspaceId, request.sourceRevisionId, segmentId)) throw new ResearchConflictError("request segment scope mismatch");
    const timestamp = this.now().toISOString();
    const requestJson = stableJson(request);
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO research_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, request.requestId, request.taskId, request.workflowId, request.documentId, request.sourceRevisionId, request.targetLanguage, timestamp);
      const insertSegment = this.database.prepare("INSERT INTO research_request_segments VALUES (?, ?, ?, ?)");
      for (const segmentId of request.segmentIds) insertSegment.run(this.workspaceId, request.requestId, request.sourceRevisionId, segmentId);
      this.database.prepare("INSERT INTO research_request_revisions VALUES (?, ?, ?, 1, '1.0', ?, ?, ?, ?, ?)")
        .run(this.workspaceId, request.revisionId, request.requestId, requestJson, sha(requestJson), by.type, by.id, timestamp);
      this.database.prepare("INSERT INTO research_request_heads VALUES (?, ?, ?, 1, 0, 'draft', ?)")
        .run(this.workspaceId, request.requestId, request.revisionId, timestamp);
    })();
    return this.getRequest(request.requestId);
  }

  reviseRequest(requestId, expectedVersion, input, actorInput) {
    const request = researchRequestContract(input);
    const by = actor(actorInput, ["user", "system", "model", "fixture"]);
    if (request.requestId !== requestId || request.origin.type !== by.type || request.origin.id !== by.id) throw new ResearchAuthorizationError("request revision actor mismatch");
    const current = this.getRequest(requestId);
    if (!["draft", "pending-user"].includes(current.head.state) || current.head.version !== expectedVersion) throw new ResearchConflictError("request version conflict");
    for (const field of ["taskId", "workflowId", "documentId", "sourceRevisionId", "targetLanguage"])
      if (request[field] !== current.request[field]) throw new ResearchConflictError("request binding is immutable");
    if (stableJson(request.segmentIds) !== stableJson(current.request.segmentIds)) throw new ResearchConflictError("request segment binding is immutable");
    const timestamp = this.now().toISOString();
    const requestJson = stableJson(request);
    try {
      this.database.transaction(() => {
        this.database.prepare("INSERT INTO research_request_revisions VALUES (?, ?, ?, ?, '1.0', ?, ?, ?, ?, ?)")
          .run(this.workspaceId, request.revisionId, requestId, current.head.revision + 1, requestJson, sha(requestJson), by.type, by.id, timestamp);
        const changed = this.database.prepare(`UPDATE research_request_heads SET request_revision_id = ?, revision = revision + 1,
          version = version + 1, state = 'draft', updated_at = ? WHERE workspace_id = ? AND request_id = ? AND version = ?`)
          .run(request.revisionId, timestamp, this.workspaceId, requestId, expectedVersion).changes;
        if (changed !== 1) throw new ResearchConflictError("request version conflict");
      })();
    } catch (error) { if (error instanceof ResearchConflictError) throw error; throw new ResearchConflictError("request revision conflict"); }
    return this.getRequest(requestId);
  }

  submitRequest(requestId, expectedVersion, actorInput) {
    actor(actorInput, ["user", "system", "model", "fixture"]);
    return this.#transitionRequest(requestId, expectedVersion, "draft", "pending-user");
  }

  decideRequest(requestId, expectedVersion, decision, actorInput) {
    const by = actor(actorInput, ["user"]);
    if (!["approved", "rejected", "canceled"].includes(decision)) throw new TypeError("request decision is invalid");
    const current = this.getRequest(requestId);
    if (current.head.state !== "pending-user" || current.head.version !== expectedVersion) throw new ResearchConflictError("request decision conflict");
    const timestamp = this.now().toISOString();
    const decisionId = this.id();
    try {
      this.database.transaction(() => {
        this.database.prepare("INSERT INTO research_request_decisions VALUES (?, ?, ?, ?, ?, 'user', ?, ?)")
          .run(this.workspaceId, decisionId, requestId, current.head.requestRevisionId, decision, by.id, timestamp);
        const changed = this.database.prepare(`UPDATE research_request_heads SET state = ?, version = version + 1, updated_at = ?
          WHERE workspace_id = ? AND request_id = ? AND state = 'pending-user' AND version = ?`)
          .run(decision, timestamp, this.workspaceId, requestId, expectedVersion).changes;
        if (changed !== 1) throw new ResearchConflictError("request decision conflict");
      })();
    } catch (error) { if (error instanceof ResearchConflictError) throw error; throw new ResearchConflictError("request decision conflict"); }
    return Object.freeze({ ...this.getRequest(requestId), decisionId });
  }

  issueGrant(requestId, input, actorInput) {
    const grant = researchGrantContract(input);
    const by = actor(actorInput, ["user"]);
    const current = this.getRequest(requestId);
    if (current.head.state !== "approved" || grant.requestId !== requestId || grant.requestRevisionId !== current.head.requestRevisionId) throw new ResearchConflictError("grant request is not approved and current");
    if (grant.approvedBy.id !== by.id) throw new ResearchAuthorizationError("grant approver does not match actor");
    const decision = this.database.prepare(`SELECT decision_id AS decisionId, actor_id AS actorId FROM research_request_decisions
      WHERE workspace_id = ? AND request_id = ? AND request_revision_id = ? AND decision = 'approved'`)
      .get(this.workspaceId, requestId, grant.requestRevisionId);
    if (!decision || decision.actorId !== by.id) throw new ResearchAuthorizationError("grant must be issued by the approving user");
    const grantJson = stableJson(grant);
    try {
      this.database.prepare(`INSERT INTO research_grants VALUES (?, ?, ?, ?, ?, 'approved', '1.0', ?, ?, 'user', ?, ?, ?)`)
        .run(this.workspaceId, grant.grantId, requestId, grant.requestRevisionId, decision.decisionId,
          grantJson, sha(grantJson), by.id, grant.approvedAt, grant.expiresAt);
    } catch { throw new ResearchConflictError("grant is immutable or already exists"); }
    return this.getGrant(grant.grantId);
  }

  revokeGrant(grantId, reason, actorInput) {
    const by = actor(actorInput, ["user"]);
    if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 2_048) throw new TypeError("revocation reason is invalid");
    this.getGrant(grantId);
    try {
      this.database.prepare("INSERT INTO research_grant_revocations VALUES (?, ?, ?, ?, 'user', ?, ?)")
        .run(this.workspaceId, this.id(), grantId, reason, by.id, this.now().toISOString());
    } catch { throw new ResearchConflictError("grant is already revoked"); }
    return this.getGrant(grantId);
  }

  getRequest(requestId) {
    const row = this.database.prepare(`SELECT request.request_id AS requestId, revision.request_json AS requestJson,
      head.request_revision_id AS requestRevisionId, head.revision, head.version, head.state, head.updated_at AS updatedAt
      FROM research_requests AS request JOIN research_request_heads AS head
        ON head.workspace_id = request.workspace_id AND head.request_id = request.request_id
      JOIN research_request_revisions AS revision
        ON revision.workspace_id = head.workspace_id AND revision.request_revision_id = head.request_revision_id
      WHERE request.workspace_id = ? AND request.request_id = ?`).get(this.workspaceId, requestId);
    if (!row) throw new ResearchConflictError("request not found");
    return Object.freeze({ request: researchRequestContract(JSON.parse(row.requestJson)), head: Object.freeze({
      requestRevisionId: row.requestRevisionId, revision: row.revision, version: row.version, state: row.state, updatedAt: row.updatedAt }) });
  }

  getGrant(grantId) {
    const row = this.database.prepare(`SELECT grant_json AS grantJson, expires_at AS expiresAt,
      EXISTS(SELECT 1 FROM research_grant_revocations AS revocation WHERE revocation.workspace_id = research_grants.workspace_id AND revocation.grant_id = research_grants.grant_id) AS revoked
      FROM research_grants WHERE workspace_id = ? AND grant_id = ?`).get(this.workspaceId, grantId);
    if (!row) throw new ResearchConflictError("grant not found");
    const now = this.now().toISOString();
    const status = row.revoked ? "revoked" : now >= row.expiresAt ? "expired" : "active";
    return Object.freeze({ grant: researchGrantContract(JSON.parse(row.grantJson)), status });
  }

  #transitionRequest(requestId, expectedVersion, from, to) {
    const changed = this.database.prepare(`UPDATE research_request_heads SET state = ?, version = version + 1, updated_at = ?
      WHERE workspace_id = ? AND request_id = ? AND state = ? AND version = ?`)
      .run(to, this.now().toISOString(), this.workspaceId, requestId, from, expectedVersion).changes;
    if (changed !== 1) throw new ResearchConflictError("request transition conflict");
    return this.getRequest(requestId);
  }
}
