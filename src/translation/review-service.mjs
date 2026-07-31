import { randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { ValidationConflictError, ValidationService } from "./validator.mjs";

export class ReviewConflictError extends Error {
  constructor(message = "review conflict") {
    super(message);
    this.name = "ReviewConflictError";
    this.code = "REVIEW_CONFLICT";
  }
}

function actor(input) {
  if (!input || !["user", "system", "fixture"].includes(input.type) || typeof input.id !== "string" || input.id.length === 0) {
    throw new TypeError("invalid actor");
  }
  return input;
}

export class ReviewService {
  constructor(database, trustedWorkspaceId, { now = () => new Date(), id = () => randomUUID(), validation } = {}) {
    this.database = database;
    this.workspaceId = trustedWorkspaceId;
    this.now = now;
    this.id = id;
    this.validation = validation ?? new ValidationService(database, trustedWorkspaceId, { now, id });
  }

  confirmWarning(workflowId, validationRunId, findingId, actorInput) {
    const by = actor(actorInput);
    if (by.type !== "user") return this.#reject(workflowId, "warning-confirmation-rejected", by, { validationRunId, findingId });
    const run = this.#gate(workflowId, validationRunId, { allowWarnings: true });
    const warning = run.findings.find((item) => item.findingId === findingId && item.severity === "warning");
    if (!warning) throw new ReviewConflictError("warning finding not found");
    const existing = this.database.prepare(`
      SELECT 1 FROM review_events
      WHERE workspace_id = ? AND workflow_id = ? AND validation_run_id = ?
        AND action = 'warning-confirmed' AND json_extract(details_json, '$.findingId') = ?
    `).get(this.workspaceId, workflowId, validationRunId, findingId);
    if (existing) throw new ReviewConflictError("warning already confirmed");
    this.#event(workflowId, validationRunId, "warning-confirmed", by, { findingId, code: warning.code });
    return this.getEvents(workflowId);
  }

  humanReview(workflowId, validationRunId, expectedWorkflowVersion, actorInput) {
    return this.#transition(workflowId, validationRunId, expectedWorkflowVersion, "editing", "human-reviewed", actorInput);
  }

  approve(workflowId, validationRunId, expectedWorkflowVersion, actorInput) {
    return this.#transition(workflowId, validationRunId, expectedWorkflowVersion, "human-reviewed", "approved-for-export", actorInput);
  }

  getEvents(workflowId, _untrustedWorkspaceId = undefined) {
    this.#workflow(workflowId);
    return Object.freeze(this.database.prepare(`
      SELECT review_event_id AS reviewEventId, validation_run_id AS validationRunId,
             action, actor_type AS actorType, actor_id AS actorId, details_json AS detailsJson
      FROM review_events WHERE workspace_id = ? AND workflow_id = ?
      ORDER BY occurred_at, review_event_id
    `).all(this.workspaceId, workflowId).map((row) => Object.freeze({ ...row, details: JSON.parse(row.detailsJson) })));
  }

  #transition(workflowId, validationRunId, expectedVersion, requiredState, nextState, actorInput) {
    const by = actor(actorInput);
    if (by.type !== "user") return this.#reject(workflowId, `${nextState}-rejected`, by, { validationRunId });
    this.#gate(workflowId, validationRunId);
    try {
      return this.database.transaction(() => {
        const changed = this.database.prepare(`
          UPDATE translation_workflows SET state = ?, version = version + 1, updated_at = ?
          WHERE workspace_id = ? AND workflow_id = ? AND state = ? AND version = ?
        `).run(nextState, this.now().toISOString(), this.workspaceId, workflowId, requiredState, expectedVersion).changes;
        if (changed !== 1) throw new ReviewConflictError("workflow review version or state conflict");
        this.#event(workflowId, validationRunId, nextState, by, {});
        this.#audit(workflowId, nextState, by, true, { validationRunId, expectedVersion });
        return Object.freeze(this.#workflow(workflowId));
      })();
    } catch (error) {
      if (error instanceof ReviewConflictError) this.#audit(workflowId, `${nextState}-conflict`, by, false, { validationRunId, expectedVersion });
      throw error;
    }
  }

  #gate(workflowId, validationRunId, { allowWarnings = false } = {}) {
    let run;
    try { run = this.validation.get(validationRunId); }
    catch (error) {
      if (error instanceof ValidationConflictError) throw new ReviewConflictError("validation run not found");
      throw error;
    }
    if (run.workflowId !== workflowId) throw new ReviewConflictError("validation run not found");
    if (!run.current) throw new ReviewConflictError("validation run is stale");
    if (run.findings.some((item) => item.severity === "error")) throw new ReviewConflictError("validation errors block review");
    if (!allowWarnings) {
      const confirmed = new Set(this.database.prepare(`
        SELECT json_extract(details_json, '$.findingId') AS findingId
        FROM review_events
        WHERE workspace_id = ? AND workflow_id = ? AND validation_run_id = ? AND action = 'warning-confirmed'
      `).all(this.workspaceId, workflowId, validationRunId).map((row) => row.findingId));
      if (run.findings.some((item) => item.severity === "warning" && !confirmed.has(item.findingId))) {
        throw new ReviewConflictError("unconfirmed warnings block review");
      }
    }
    return run;
  }

  #reject(workflowId, action, by, details) {
    this.#workflow(workflowId);
    this.#audit(workflowId, action, by, false, details);
    throw new ReviewConflictError("only a user can review or approve");
  }

  #workflow(workflowId) {
    const row = this.database.prepare("SELECT workflow_id AS workflowId, state, version FROM translation_workflows WHERE workspace_id = ? AND workflow_id = ?")
      .get(this.workspaceId, workflowId);
    if (!row) throw new ReviewConflictError("workflow not found");
    return row;
  }

  #event(workflowId, validationRunId, action, by, details) {
    this.database.prepare("INSERT INTO review_events VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?)")
      .run(this.workspaceId, this.id(), workflowId, validationRunId, action, by.id, stableJson(details), this.now().toISOString());
  }

  #audit(workflowId, action, by, succeeded, details) {
    this.database.prepare("INSERT INTO domain_audit_events(workspace_id,event_id,entity_type,entity_id,action,actor_type,actor_id,succeeded,details_json,occurred_at) VALUES (?, ?, 'translation-workflow', ?, ?, ?, ?, ?, ?, ?)")
      .run(this.workspaceId, this.id(), workflowId, action, by.type, by.id, succeeded ? 1 : 0, stableJson(details), this.now().toISOString());
  }
}
