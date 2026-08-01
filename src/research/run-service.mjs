import { randomUUID } from "node:crypto";
import { ResearchAuthorizationError, ResearchConflictError, ResearchFoundationService } from "./foundation-service.mjs";

const ALLOWED = Object.freeze({
  queued: new Set(["running", "canceled"]),
  running: new Set(["paused", "completed", "failed", "canceled"]),
  paused: new Set(["running", "failed", "canceled"]),
  completed: new Set(), failed: new Set(), canceled: new Set(),
});
const PAUSE_REASONS = new Set(["unknown-outcome", "offline", "budget-exhausted", "capability-unavailable", "user-request", "lease-expired"]);

function actor(input, allowed) {
  if (!input || !allowed.includes(input.type) || typeof input.id !== "string" || input.id.length === 0) throw new ResearchAuthorizationError("run actor is not authorized");
  return input;
}

export class ResearchRunService {
  constructor(database, workspaceId, { now = () => new Date(), id = randomUUID } = {}) {
    this.database = database; this.workspaceId = workspaceId; this.now = now; this.id = id;
    this.foundation = new ResearchFoundationService(database, workspaceId, { now, id });
  }

  create(grantId, requestDigest, actorInput = { type: "system", id: "research-control-plane" }) {
    actor(actorInput, ["user", "system", "fixture"]);
    const { grant, status } = this.foundation.getGrant(grantId);
    if (status !== "active") throw new ResearchConflictError("grant is not active");
    if (!/^sha256:[0-9a-f]{64}$/.test(requestDigest)) throw new TypeError("run request digest is invalid");
    const count = this.database.prepare("SELECT count(*) AS count FROM research_runs WHERE workspace_id = ? AND grant_id = ?").get(this.workspaceId, grantId).count;
    if (count >= grant.limits.maxRuns) throw new ResearchConflictError("grant run budget is exhausted");
    const created = this.now();
    const deadline = new Date(Math.min(created.getTime() + grant.limits.maxDurationSeconds * 1_000, new Date(grant.expiresAt).getTime()));
    const runId = this.id();
    const eventId = this.id();
    try {
      this.database.transaction(() => {
        this.database.prepare("INSERT INTO research_runs VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(this.workspaceId, runId, grantId, count + 1, requestDigest, created.toISOString(), deadline.toISOString());
        this.database.prepare("INSERT INTO research_run_events VALUES (?, ?, ?, 0, 'queued', NULL, '{}', ?)")
          .run(this.workspaceId, eventId, runId, created.toISOString());
      })();
    } catch { throw new ResearchConflictError("run creation conflict"); }
    return this.get(runId);
  }

  transition(runId, state, { reason = null, details = {}, actor: actorInput = { type: "system", id: "research-control-plane" } } = {}) {
    const by = actor(actorInput, state === "canceled" ? ["user", "system", "fixture"] : ["system", "fixture"]);
    const current = this.get(runId);
    if (!ALLOWED[current.state]?.has(state)) throw new ResearchConflictError("invalid research run transition");
    if ((state === "paused") !== (reason !== null)) throw new ResearchConflictError("paused runs require one reason");
    if (state === "paused" && !PAUSE_REASONS.has(reason)) throw new ResearchConflictError("pause reason is invalid");
    if (!details || typeof details !== "object" || Array.isArray(details)) throw new TypeError("run details must be an object");
    const ordinal = current.ordinal + 1;
    try {
      this.database.prepare("INSERT INTO research_run_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, this.id(), runId, ordinal, state, reason, JSON.stringify({ ...details, actorType: by.type, actorId: by.id }), this.now().toISOString());
    } catch { throw new ResearchConflictError("research run transition conflict"); }
    return this.get(runId);
  }

  retryUnknown(runId, actorInput) {
    actor(actorInput, ["user"]);
    const current = this.get(runId);
    if (current.state !== "paused" || current.reason !== "unknown-outcome") throw new ResearchConflictError("only an unknown outcome can be retried by a user");
    return this.create(current.grantId, current.requestDigest, actorInput);
  }

  get(runId) {
    const row = this.database.prepare(`SELECT run.run_id AS runId, run.grant_id AS grantId, run.attempt,
      run.request_digest AS requestDigest, run.created_at AS createdAt, run.deadline_at AS deadlineAt,
      event.ordinal, event.state, event.reason, event.details_json AS detailsJson, event.occurred_at AS occurredAt
      FROM research_runs AS run JOIN research_run_events AS event ON event.workspace_id = run.workspace_id AND event.run_id = run.run_id
      WHERE run.workspace_id = ? AND run.run_id = ? ORDER BY event.ordinal DESC LIMIT 1`).get(this.workspaceId, runId);
    if (!row) throw new ResearchConflictError("research run not found");
    return Object.freeze({ ...row, details: Object.freeze(JSON.parse(row.detailsJson)) });
  }
}

export const RESEARCH_RUN_STATES = Object.freeze(Object.keys(ALLOWED));
export const RESEARCH_PAUSE_REASONS = Object.freeze([...PAUSE_REASONS]);
