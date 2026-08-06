import { randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { providerErrorContract } from "./contracts.mjs";

const ACTIVE_ATTEMPTS = ["queued", "leased", "running", "retry-wait"];
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function required(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function attemptContextDigests(input) {
  const segmentIds = input.segmentIds;
  if (input.contextDigests !== undefined) {
    if (!input.contextDigests || typeof input.contextDigests !== "object" || Array.isArray(input.contextDigests)
      || Object.keys(input.contextDigests).sort().join(",") !== [...segmentIds].sort().join(",")) {
      throw new TypeError("contextDigests must exactly match segmentIds");
    }
    const entries = segmentIds.map((segmentId) => {
      const value = input.contextDigests[segmentId];
      if (!SHA256.test(value ?? "")) throw new TypeError("contextDigests values must be sha256 digests");
      return [segmentId, value];
    });
    return new Map(entries);
  }
  if (segmentIds.length !== 1 || !SHA256.test(input.contextDigest ?? "")) {
    throw new TypeError("multi-segment tasks require contextDigests");
  }
  return new Map([[segmentIds[0], input.contextDigest]]);
}

export class TaskConflictError extends Error {
  constructor(message) { super(message); this.name = "TaskConflictError"; }
}

export class TranslationTaskOrchestrator {
  constructor(database, trustedWorkspaceId, { id = () => randomUUID(), now = () => new Date(), inject = () => {}, onTerminate = () => {} } = {}) {
    this.database = database;
    this.workspaceId = required(trustedWorkspaceId, "trustedWorkspaceId");
    this.id = id;
    this.now = now;
    this.inject = inject;
    this.onTerminate = onTerminate;
  }

  enqueue(input) {
    const existing = this.database.prepare(`SELECT * FROM translation_tasks WHERE workspace_id = ? AND workflow_id = ? AND idempotency_key = ?`)
      .get(this.workspaceId, input.workflowId, input.idempotencyKey);
    if (existing) {
      if (existing.request_digest !== input.requestDigest) throw new TaskConflictError("idempotency request mismatch");
      return this.getTask(existing.task_id);
    }
    if (!Array.isArray(input.segmentIds) || input.segmentIds.length === 0 || new Set(input.segmentIds).size !== input.segmentIds.length) {
      throw new TypeError("segmentIds must be a non-empty unique array");
    }
    const contextDigests = attemptContextDigests(input);
    const workflow = this.database.prepare(`
      SELECT * FROM translation_workflows WHERE workspace_id = ? AND workflow_id = ?
        AND document_id = ? AND source_revision_id = ? AND target_language = ?
        AND state NOT IN ('stale', 'rejected', 'exported')
    `).get(this.workspaceId, input.workflowId, input.documentId, input.sourceRevisionId, input.targetLanguage);
    if (!workflow) throw new TaskConflictError("workflow is unavailable");
    const found = this.database.prepare(`SELECT segment_id FROM source_segment_versions WHERE workspace_id = ? AND source_revision_id = ? AND segment_id IN (${input.segmentIds.map(() => "?").join(",")})`)
      .all(this.workspaceId, input.sourceRevisionId, ...input.segmentIds);
    if (found.length !== input.segmentIds.length) throw new TaskConflictError("segment scope mismatch");
    const taskId = this.id();
    const timestamp = this.now().toISOString();
    this.inject("before-enqueue");
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO translation_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)")
        .run(this.workspaceId, taskId, input.workflowId, input.documentId, input.sourceRevisionId, input.targetLanguage,
          input.idempotencyKey, input.requestDigest, input.policyVersion, timestamp, timestamp);
      this.database.prepare("INSERT INTO task_execution_policies VALUES (?, ?, ?, ?, NULL)")
        .run(this.workspaceId, taskId, input.maxAttempts ?? 3, input.batchSize ?? input.segmentIds.length);
      for (const segmentId of input.segmentIds) {
        const attemptId = this.id();
        this.database.prepare("INSERT INTO translation_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, NULL)")
          .run(this.workspaceId, attemptId, taskId, input.workflowId, input.documentId, input.sourceRevisionId, input.targetLanguage,
            segmentId, input.providerId, input.modelId, input.promptVersion, contextDigests.get(segmentId), input.requestDigest, timestamp);
        this.database.prepare("INSERT INTO attempt_runtime_states VALUES (?, ?, ?, ?, 1, NULL, NULL, NULL, NULL, NULL, 'not-started', NULL)")
          .run(this.workspaceId, attemptId, taskId, segmentId);
        this.#event(taskId, attemptId, "queued", { attemptNumber: 1 }, timestamp);
      }
      this.inject("after-enqueue-writes");
    })();
    this.inject("after-enqueue-commit");
    return this.getTask(taskId);
  }

  leaseNext(workerId, leaseMs = 30_000) {
    required(workerId, "workerId");
    const now = this.now();
    const timestamp = now.toISOString();
    const expiry = new Date(now.getTime() + leaseMs).toISOString();
    const result = this.database.transaction(() => {
      const candidate = this.database.prepare(`
        SELECT a.*, r.attempt_number FROM translation_attempts a
        JOIN attempt_runtime_states r ON r.workspace_id = a.workspace_id AND r.attempt_id = a.attempt_id
        JOIN translation_tasks t ON t.workspace_id = a.workspace_id AND t.task_id = a.task_id
        JOIN translation_workflows w ON w.workspace_id = a.workspace_id AND w.workflow_id = a.workflow_id
        WHERE a.workspace_id = ? AND t.state IN ('queued', 'running')
          AND w.state NOT IN ('stale', 'rejected', 'exported')
          AND (NOT EXISTS (SELECT 1 FROM translation_flow_controls flow WHERE flow.workspace_id = a.workspace_id AND flow.workflow_id = a.workflow_id)
            OR (EXISTS (SELECT 1 FROM m5c_translation_attempt_bindings binding WHERE binding.workspace_id = a.workspace_id AND binding.attempt_id = a.attempt_id)
              AND EXISTS (SELECT 1 FROM translation_flow_controls flow WHERE flow.workspace_id = a.workspace_id AND flow.workflow_id = a.workflow_id
                AND flow.flow_state IN ('translating','remediation') AND flow.outcome_state = 'none')))
          AND (a.state = 'queued' OR (a.state = 'retry-wait' AND r.next_retry_at <= ?))
          AND (
            NOT EXISTS (
              SELECT 1 FROM task_budget_assignments assignment
              WHERE assignment.workspace_id = a.workspace_id AND assignment.task_id = a.task_id
            )
            OR EXISTS (
              SELECT 1 FROM budget_reservations reservation
              WHERE reservation.workspace_id = a.workspace_id AND reservation.attempt_id = a.attempt_id
                AND reservation.state = 'reserved'
            )
          )
        ORDER BY a.created_at, a.attempt_id LIMIT 1
      `).get(this.workspaceId, timestamp);
      if (!candidate) return null;
      this.inject("before-lease");
      const updated = this.database.prepare("UPDATE translation_attempts SET state = 'leased', version = version + 1 WHERE workspace_id = ? AND attempt_id = ? AND version = ? AND state IN ('queued','retry-wait')")
        .run(this.workspaceId, candidate.attempt_id, candidate.version);
      if (updated.changes !== 1) return null;
      this.database.prepare("UPDATE attempt_runtime_states SET lease_holder = ?, lease_expires_at = ?, heartbeat_at = ?, next_retry_at = NULL WHERE workspace_id = ? AND attempt_id = ?")
        .run(workerId, expiry, timestamp, this.workspaceId, candidate.attempt_id);
      this.database.prepare("UPDATE translation_tasks SET state = 'running', version = version + 1, updated_at = ? WHERE workspace_id = ? AND task_id = ? AND state = 'queued'")
        .run(timestamp, this.workspaceId, candidate.task_id);
      this.database.prepare("UPDATE translation_workflows SET state = 'generating', version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND state = 'queued'")
        .run(timestamp, this.workspaceId, candidate.workflow_id);
      this.#event(candidate.task_id, candidate.attempt_id, "leased", { workerId, expiry }, timestamp);
      this.inject("after-lease-writes");
      return Object.freeze({ ...candidate, state: "leased", version: candidate.version + 1, leaseHolder: workerId, leaseExpiresAt: expiry });
    })();
    this.inject("after-lease-commit");
    return result;
  }

  startProvider(attemptId, expectedVersion, workerId) {
    const timestamp = this.now().toISOString();
    this.inject("before-provider-start");
    const result = this.database.transaction(() => {
      const changed = this.database.prepare("UPDATE translation_attempts SET state = 'running', version = version + 1 WHERE workspace_id = ? AND attempt_id = ? AND state = 'leased' AND version = ?")
        .run(this.workspaceId, attemptId, expectedVersion);
      const runtime = this.database.prepare("UPDATE attempt_runtime_states SET provider_call_state = 'started', heartbeat_at = ? WHERE workspace_id = ? AND attempt_id = ? AND lease_holder = ? AND provider_call_state = 'not-started'")
        .run(timestamp, this.workspaceId, attemptId, workerId);
      if (changed.changes !== 1 || runtime.changes !== 1) throw new TaskConflictError("provider start conflict");
      const row = this.database.prepare("SELECT task_id FROM translation_attempts WHERE workspace_id = ? AND attempt_id = ?").get(this.workspaceId, attemptId);
      this.#event(row.task_id, attemptId, "provider-started", {}, timestamp);
      this.inject("after-provider-start-writes");
      return Object.freeze({ attemptId, state: "running", version: expectedVersion + 1 });
    })();
    this.inject("after-provider-start-commit");
    return result;
  }

  heartbeat(attemptId, expectedVersion, workerId, leaseMs = 30_000) {
    const now = this.now();
    const timestamp = now.toISOString();
    const expiry = new Date(now.getTime() + leaseMs).toISOString();
    const changed = this.database.prepare(`
      UPDATE attempt_runtime_states SET heartbeat_at = ?, lease_expires_at = ?
      WHERE workspace_id = ? AND attempt_id = ? AND lease_holder = ?
        AND EXISTS (SELECT 1 FROM translation_attempts WHERE workspace_id = ? AND attempt_id = ? AND version = ? AND state IN ('leased','running'))
    `).run(timestamp, expiry, this.workspaceId, attemptId, workerId, this.workspaceId, attemptId, expectedVersion);
    if (changed.changes !== 1) throw new TaskConflictError("heartbeat conflict");
    return Object.freeze({ attemptId, leaseExpiresAt: expiry });
  }

  complete(attemptId, expectedVersion, workerId, outcomeDigest, { usage } = {}) {
    const timestamp = this.now().toISOString();
    this.inject("before-complete");
    const result = this.database.transaction(() => {
      const current = this.#attempt(attemptId);
      if (current.state === "completed" && current.outcome_digest === outcomeDigest) return Object.freeze({ attemptId, state: "completed", version: current.version });
      if (current.state !== "running" || current.version !== expectedVersion || current.lease_holder !== workerId) throw new TaskConflictError("completion conflict");
      const workflow = this.database.prepare("SELECT state FROM translation_workflows WHERE workspace_id = ? AND workflow_id = ?").get(this.workspaceId, current.workflow_id);
      const task = this.database.prepare("SELECT state FROM translation_tasks WHERE workspace_id = ? AND task_id = ?").get(this.workspaceId, current.task_id);
      if (!workflow || ["stale", "rejected", "exported"].includes(workflow.state) || ["canceled", "failed", "paused"].includes(task.state)) throw new TaskConflictError("late result rejected");
      this.database.prepare("UPDATE translation_attempts SET state = 'completed', version = version + 1, completed_at = ? WHERE workspace_id = ? AND attempt_id = ?")
        .run(timestamp, this.workspaceId, attemptId);
      this.database.prepare("UPDATE attempt_runtime_states SET provider_call_state = 'completed', outcome_digest = ?, lease_holder = NULL, lease_expires_at = NULL, heartbeat_at = ? WHERE workspace_id = ? AND attempt_id = ?")
        .run(outcomeDigest, timestamp, this.workspaceId, attemptId);
      if (usage) {
        if (usage.providerId !== current.provider_id || usage.modelId !== current.model_id) throw new TaskConflictError("usage identity mismatch");
        this.database.prepare("INSERT INTO usage_cost_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(this.workspaceId, this.id(), current.task_id, attemptId, current.provider_id, current.model_id,
            usage.providerResponseId, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.totalTokens,
            usage.currency ?? null, usage.amountMicros ?? null, usage.pricingVersion ?? null, timestamp);
      }
      this.#event(current.task_id, attemptId, "completed", { outcomeDigest }, timestamp);
      const remaining = this.database.prepare("SELECT count(*) AS total FROM translation_attempts WHERE workspace_id = ? AND task_id = ? AND state != 'completed' AND attempt_id IN (SELECT attempt_id FROM attempt_runtime_states WHERE workspace_id = ? AND task_id = ? AND attempt_number = (SELECT max(r2.attempt_number) FROM attempt_runtime_states r2 WHERE r2.workspace_id = attempt_runtime_states.workspace_id AND r2.task_id = attempt_runtime_states.task_id AND r2.segment_id = attempt_runtime_states.segment_id))")
        .get(this.workspaceId, current.task_id, this.workspaceId, current.task_id).total;
      if (remaining === 0) {
        this.database.prepare("UPDATE translation_tasks SET state = 'completed', version = version + 1, updated_at = ? WHERE workspace_id = ? AND task_id = ?")
          .run(timestamp, this.workspaceId, current.task_id);
        this.database.prepare("UPDATE translation_workflows SET state = 'draft-machine', version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND state = 'generating'")
          .run(timestamp, this.workspaceId, current.workflow_id);
      }
      this.inject("after-complete-writes");
      return Object.freeze({ attemptId, state: "completed", version: expectedVersion + 1 });
    })();
    this.inject("after-complete-commit");
    return result;
  }

  fail(attemptId, expectedVersion, workerId, errorInput, { retryDelayMs = 1_000 } = {}) {
    const error = providerErrorContract(errorInput);
    const now = this.now();
    const timestamp = now.toISOString();
    this.inject("before-fail");
    const result = this.database.transaction(() => {
      const current = this.#attempt(attemptId);
      if (!["leased", "running"].includes(current.state) || current.version !== expectedVersion || current.lease_holder !== workerId) throw new TaskConflictError("failure conflict");
      this.database.prepare("UPDATE translation_attempts SET state = ?, version = version + 1, completed_at = ? WHERE workspace_id = ? AND attempt_id = ?")
        .run(error.category === "unknown-outcome" ? "unknown-outcome" : "failed", timestamp, this.workspaceId, attemptId);
      this.database.prepare("UPDATE attempt_runtime_states SET provider_call_state = ?, error_category = ?, lease_holder = NULL, lease_expires_at = NULL, heartbeat_at = ? WHERE workspace_id = ? AND attempt_id = ?")
        .run(error.category === "unknown-outcome" ? "unknown" : current.provider_call_state, error.category, timestamp, this.workspaceId, attemptId);
      this.#event(current.task_id, attemptId, "failed", { category: error.category, retryable: error.retryable }, timestamp);
      const policy = this.database.prepare("SELECT max_attempts FROM task_execution_policies WHERE workspace_id = ? AND task_id = ?").get(this.workspaceId, current.task_id);
      if (error.retryable && error.category !== "unknown-outcome" && current.attempt_number < policy.max_attempts) {
        const nextId = this.id();
        const nextNumber = current.attempt_number + 1;
        const retryAt = new Date(now.getTime() + retryDelayMs).toISOString();
        this.database.prepare("INSERT INTO translation_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'retry-wait', 0, ?, NULL)")
          .run(this.workspaceId, nextId, current.task_id, current.workflow_id, current.document_id, current.source_revision_id, current.target_language,
            current.segment_id, current.provider_id, current.model_id, current.prompt_version, current.context_digest, current.request_digest, timestamp);
        this.database.prepare("INSERT INTO attempt_runtime_states VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, 'not-started', NULL)")
          .run(this.workspaceId, nextId, current.task_id, current.segment_id, nextNumber, retryAt);
        this.database.prepare(`
          INSERT INTO attempt_evidence_bindings(
            workspace_id, attempt_id, task_id, workflow_id, source_revision_id, target_language, segment_id,
            evidence_id, evidence_digest
          )
          SELECT workspace_id, ?, task_id, workflow_id, source_revision_id, target_language, segment_id,
                 evidence_id, evidence_digest
          FROM attempt_evidence_bindings WHERE workspace_id = ? AND attempt_id = ?
        `).run(nextId, this.workspaceId, attemptId);
        this.#event(current.task_id, nextId, "retry-scheduled", { attemptNumber: nextNumber, retryAt }, timestamp);
        this.inject("after-fail-writes");
        return Object.freeze({ attemptId, state: "failed", retryAttemptId: nextId, retryAt });
      }
      const taskState = error.category === "unknown-outcome" ? "paused" : "failed";
      this.database.prepare("UPDATE translation_tasks SET state = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND task_id = ?")
        .run(taskState, timestamp, this.workspaceId, current.task_id);
      this.inject("after-fail-writes");
      return Object.freeze({ attemptId, state: error.category === "unknown-outcome" ? "unknown-outcome" : "failed" });
    })();
    this.inject("after-fail-commit");
    return result;
  }

  pauseOffline(taskId, reason = "offline") {
    const timestamp = this.now().toISOString();
    this.inject("before-pause");
    this.database.transaction(() => {
      const changed = this.database.prepare("UPDATE translation_tasks SET state = 'paused', version = version + 1, updated_at = ? WHERE workspace_id = ? AND task_id = ? AND state IN ('queued','running')")
        .run(timestamp, this.workspaceId, taskId);
      if (changed.changes !== 1) throw new TaskConflictError("pause conflict");
      this.database.prepare("UPDATE task_execution_policies SET offline_reason = ? WHERE workspace_id = ? AND task_id = ?").run(reason, this.workspaceId, taskId);
      this.inject("after-pause-writes");
    })();
    this.inject("after-pause-commit");
    return this.getTask(taskId);
  }

  resume(taskId) {
    const timestamp = this.now().toISOString();
    this.inject("before-resume");
    this.database.transaction(() => {
      const changed = this.database.prepare("UPDATE translation_tasks SET state = 'queued', version = version + 1, updated_at = ? WHERE workspace_id = ? AND task_id = ? AND state = 'paused'")
        .run(timestamp, this.workspaceId, taskId);
      if (changed.changes !== 1) throw new TaskConflictError("resume conflict");
      this.database.prepare("UPDATE task_execution_policies SET offline_reason = NULL WHERE workspace_id = ? AND task_id = ?").run(this.workspaceId, taskId);
      this.inject("after-resume-writes");
    })();
    this.inject("after-resume-commit");
    return this.getTask(taskId);
  }

  cancel(taskId) {
    const timestamp = this.now().toISOString();
    this.inject("before-cancel");
    const terminated = this.database.transaction(() => {
      const changed = this.database.prepare("UPDATE translation_tasks SET state = 'canceled', version = version + 1, updated_at = ? WHERE workspace_id = ? AND task_id = ? AND state NOT IN ('completed','failed','canceled')")
        .run(timestamp, this.workspaceId, taskId);
      if (changed.changes !== 1) throw new TaskConflictError("cancel conflict");
      const attempts = this.database.prepare(`SELECT attempt_id FROM translation_attempts WHERE workspace_id = ? AND task_id = ? AND state IN (${ACTIVE_ATTEMPTS.map(() => "?").join(",")})`)
        .all(this.workspaceId, taskId, ...ACTIVE_ATTEMPTS);
      for (const row of attempts) {
        this.database.prepare("UPDATE translation_attempts SET state = 'canceled', version = version + 1, completed_at = ? WHERE workspace_id = ? AND attempt_id = ?").run(timestamp, this.workspaceId, row.attempt_id);
        this.database.prepare("UPDATE attempt_runtime_states SET lease_holder = NULL, lease_expires_at = NULL, heartbeat_at = ? WHERE workspace_id = ? AND attempt_id = ?").run(timestamp, this.workspaceId, row.attempt_id);
        this.#event(taskId, row.attempt_id, "canceled", {}, timestamp);
      }
      this.inject("after-cancel-writes");
      return attempts.map((row) => row.attempt_id);
    })();
    for (const attemptId of terminated) this.onTerminate(attemptId);
    this.inject("after-cancel-commit");
    return this.getTask(taskId);
  }

  recoverExpired() {
    const timestamp = this.now().toISOString();
    const expired = this.database.prepare(`
      SELECT a.attempt_id FROM translation_attempts a JOIN attempt_runtime_states r
        ON r.workspace_id = a.workspace_id AND r.attempt_id = a.attempt_id
      WHERE a.workspace_id = ? AND a.state IN ('leased','running') AND r.lease_expires_at <= ?
    `).all(this.workspaceId, timestamp);
    const results = [];
    for (const { attempt_id: attemptId } of expired) {
      this.inject("before-recover");
      results.push(this.database.transaction(() => {
        const current = this.#attempt(attemptId);
        if (current.provider_call_state === "not-started") {
          this.database.prepare("UPDATE translation_attempts SET state = 'queued', version = version + 1 WHERE workspace_id = ? AND attempt_id = ?").run(this.workspaceId, attemptId);
          this.database.prepare("UPDATE attempt_runtime_states SET lease_holder = NULL, lease_expires_at = NULL, heartbeat_at = NULL WHERE workspace_id = ? AND attempt_id = ?").run(this.workspaceId, attemptId);
          this.#event(current.task_id, attemptId, "lease-recovered", {}, timestamp);
          this.inject("after-recover-writes");
          return { attemptId, state: "queued" };
        }
        this.database.prepare("UPDATE translation_attempts SET state = 'unknown-outcome', version = version + 1, completed_at = ? WHERE workspace_id = ? AND attempt_id = ?").run(timestamp, this.workspaceId, attemptId);
        this.database.prepare("UPDATE attempt_runtime_states SET provider_call_state = 'unknown', error_category = 'unknown-outcome', lease_holder = NULL, lease_expires_at = NULL, heartbeat_at = ? WHERE workspace_id = ? AND attempt_id = ?").run(timestamp, this.workspaceId, attemptId);
        this.database.prepare("UPDATE translation_tasks SET state = 'paused', version = version + 1, updated_at = ? WHERE workspace_id = ? AND task_id = ?").run(timestamp, this.workspaceId, current.task_id);
        this.#event(current.task_id, attemptId, "unknown-outcome", {}, timestamp);
        this.inject("after-recover-writes");
        return { attemptId, state: "unknown-outcome" };
      })());
      this.inject("after-recover-commit");
    }
    return Object.freeze(results.map(Object.freeze));
  }

  invalidateStaleWorkflow(workflowId) {
    const taskIds = this.database.prepare("SELECT task_id FROM translation_tasks WHERE workspace_id = ? AND workflow_id = ? AND state NOT IN ('completed','failed','canceled')").all(this.workspaceId, workflowId);
    for (const { task_id: taskId } of taskIds) {
      this.inject("before-stale");
      const terminated = this.database.transaction(() => {
        const timestamp = this.now().toISOString();
        this.database.prepare("UPDATE translation_tasks SET state = 'failed', version = version + 1, updated_at = ? WHERE workspace_id = ? AND task_id = ?").run(timestamp, this.workspaceId, taskId);
        const rows = this.database.prepare(`SELECT attempt_id FROM translation_attempts WHERE workspace_id = ? AND task_id = ? AND state IN (${ACTIVE_ATTEMPTS.map(() => "?").join(",")})`).all(this.workspaceId, taskId, ...ACTIVE_ATTEMPTS);
        for (const row of rows) {
          this.database.prepare("UPDATE translation_attempts SET state = 'canceled', version = version + 1, completed_at = ? WHERE workspace_id = ? AND attempt_id = ?").run(timestamp, this.workspaceId, row.attempt_id);
          this.#event(taskId, row.attempt_id, "source-stale", {}, timestamp);
        }
        this.inject("after-stale-writes");
        return rows.map((row) => row.attempt_id);
      })();
      for (const attemptId of terminated) this.onTerminate(attemptId);
      this.inject("after-stale-commit");
    }
    return taskIds.length;
  }

  getTask(taskId) {
    const task = this.database.prepare("SELECT * FROM translation_tasks WHERE workspace_id = ? AND task_id = ?").get(this.workspaceId, taskId);
    if (!task) throw new TaskConflictError("task not found");
    const attempts = this.database.prepare(`SELECT a.*, r.* FROM translation_attempts a JOIN attempt_runtime_states r ON r.workspace_id = a.workspace_id AND r.attempt_id = a.attempt_id WHERE a.workspace_id = ? AND a.task_id = ? ORDER BY a.created_at, r.attempt_number`).all(this.workspaceId, taskId);
    return Object.freeze({ task: Object.freeze(task), attempts: Object.freeze(attempts.map(Object.freeze)) });
  }

  #attempt(attemptId) {
    const row = this.database.prepare(`SELECT a.*, r.* FROM translation_attempts a JOIN attempt_runtime_states r ON r.workspace_id = a.workspace_id AND r.attempt_id = a.attempt_id WHERE a.workspace_id = ? AND a.attempt_id = ?`).get(this.workspaceId, attemptId);
    if (!row) throw new TaskConflictError("attempt not found");
    return row;
  }

  #event(taskId, attemptId, type, details, timestamp) {
    this.database.prepare("INSERT INTO attempt_events VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(this.workspaceId, this.id(), taskId, attemptId, type, stableJson(details), timestamp);
  }
}
