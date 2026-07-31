import { createHash, randomUUID } from "node:crypto";
import { stableJson } from "./contracts.mjs";

export const STATES = Object.freeze([
  "imported", "extraction-pending", "source-confirmed", "queued", "generating",
  "draft-machine", "candidate-invalid", "candidate-valid", "editing", "human-reviewed",
  "approved-for-export", "exported", "stale", "rejected",
]);

export const ALLOWED_TRANSITIONS = Object.freeze(new Map([
  ["imported", new Set(["extraction-pending", "source-confirmed", "rejected"])],
  ["extraction-pending", new Set(["source-confirmed", "rejected"])],
  ["source-confirmed", new Set(["queued", "stale", "rejected"])],
  ["queued", new Set(["generating", "rejected"])],
  ["generating", new Set(["draft-machine", "candidate-invalid", "candidate-valid", "rejected"])],
  ["draft-machine", new Set(["candidate-invalid", "candidate-valid", "rejected"])],
  ["candidate-invalid", new Set(["queued", "rejected"])],
  ["candidate-valid", new Set(["editing", "stale", "rejected"])],
  ["editing", new Set(["human-reviewed", "stale", "rejected"])],
  ["human-reviewed", new Set(["approved-for-export", "stale", "rejected"])],
  ["approved-for-export", new Set(["exported", "stale"] )],
  ["exported", new Set(["stale"])],
  ["stale", new Set(["queued", "human-reviewed", "rejected"])],
  ["rejected", new Set(["queued"])],
]));

export class StateConflictError extends Error {
  constructor(message = "state version conflict") { super(message); this.name = "StateConflictError"; this.code = "STATE_CONFLICT"; }
}

function actor(input) {
  if (!input || !["user", "system"].includes(input.type) || typeof input.id !== "string" || input.id.length === 0) throw new TypeError("invalid actor");
  return input;
}

export class DomainStateService {
  constructor(database, trustedWorkspaceId, { now = () => new Date(), id = () => randomUUID() } = {}) {
    this.database = database;
    this.workspaceId = trustedWorkspaceId;
    this.now = now;
    this.id = id;
  }

  create(documentId, content = {}, initialState = "imported") {
    if (!STATES.includes(initialState)) throw new TypeError("invalid state");
    this.database.prepare("INSERT INTO working_translations VALUES (?, ?, 0, ?, ?, ?)")
      .run(this.workspaceId, documentId, initialState, stableJson(content), this.now().toISOString());
    return this.get(documentId);
  }

  get(documentId) {
    const row = this.database.prepare("SELECT document_id AS documentId, version, state, content_json AS contentJson FROM working_translations WHERE workspace_id = ? AND document_id = ?")
      .get(this.workspaceId, documentId);
    if (!row) throw new StateConflictError("working translation not found");
    return Object.freeze({ ...row, content: JSON.parse(row.contentJson) });
  }

  transition(documentId, expectedVersion, nextState, actorInput) {
    const by = actor(actorInput);
    const current = this.get(documentId);
    const permitted = ALLOWED_TRANSITIONS.get(current.state)?.has(nextState) === true;
    const userOnly = ["human-reviewed", "approved-for-export"].includes(nextState);
    if (!permitted || (userOnly && by.type !== "user")) {
      this.#audit(documentId, "state-transition-rejected", by, false, { from: current.state, to: nextState });
      throw new StateConflictError("state transition rejected");
    }
    try {
      return this.database.transaction(() => {
        const changed = this.database.prepare(`
          UPDATE working_translations SET state = ?, version = version + 1, updated_at = ?
          WHERE workspace_id = ? AND document_id = ? AND version = ? AND state = ?
        `).run(nextState, this.now().toISOString(), this.workspaceId, documentId, expectedVersion, current.state).changes;
        if (changed !== 1) throw new StateConflictError();
        this.#audit(documentId, "state-transition", by, true, { from: current.state, to: nextState });
        return this.get(documentId);
      })();
    } catch (error) {
      if (error instanceof StateConflictError) this.#audit(documentId, "state-transition-conflict", by, false, { expectedVersion, from: current.state, to: nextState });
      throw error;
    }
  }

  updateContent(documentId, expectedVersion, content, actorInput) {
    const by = actor(actorInput);
    try {
      return this.database.transaction(() => {
        const changed = this.database.prepare(`
          UPDATE working_translations SET content_json = ?, version = version + 1, updated_at = ?
          WHERE workspace_id = ? AND document_id = ? AND version = ?
        `).run(stableJson(content), this.now().toISOString(), this.workspaceId, documentId, expectedVersion).changes;
        if (changed !== 1) throw new StateConflictError();
        this.#audit(documentId, "content-updated", by, true, { expectedVersion });
        return this.get(documentId);
      })();
    } catch (error) {
      if (error instanceof StateConflictError) this.#audit(documentId, "content-update-conflict", by, false, { expectedVersion });
      throw error;
    }
  }

  executeIdempotent(operation, key, payload, execute) {
    if (typeof operation !== "string" || typeof key !== "string" || !operation || !key) throw new TypeError("invalid idempotency scope");
    const requestDigest = `sha256:${createHash("sha256").update(stableJson(payload)).digest("hex")}`;
    return this.database.transaction(() => {
      const existing = this.database.prepare("SELECT request_digest AS requestDigest, result_json AS resultJson FROM command_idempotency WHERE workspace_id = ? AND operation = ? AND idempotency_key = ?")
        .get(this.workspaceId, operation, key);
      if (existing) {
        if (existing.requestDigest !== requestDigest) throw new StateConflictError("idempotency key payload conflict");
        return Object.freeze({ result: JSON.parse(existing.resultJson), reused: true });
      }
      const result = execute();
      const resultJson = stableJson(result);
      this.database.prepare("INSERT INTO command_idempotency VALUES (?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, operation, key, requestDigest, resultJson, this.now().toISOString());
      return Object.freeze({ result: JSON.parse(resultJson), reused: false });
    })();
  }

  #audit(entityId, action, by, succeeded, details) {
    this.database.prepare("INSERT INTO domain_audit_events(workspace_id, event_id, entity_type, entity_id, action, actor_type, actor_id, succeeded, details_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.workspaceId, this.id(), "working-translation", entityId, action, by.type, by.id, succeeded ? 1 : 0, stableJson(details), this.now().toISOString());
  }
}
