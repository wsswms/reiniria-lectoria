import { createHash, randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { validateProtectedText } from "../document/parser.mjs";

export class WorkCopyConflictError extends Error {
  constructor(message = "working copy conflict") {
    super(message);
    this.name = "WorkCopyConflictError";
    this.code = "WORK_COPY_CONFLICT";
  }
}

const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function actor(input, allowed = ["user", "system", "fixture", "provider", "runner"]) {
  if (!input || !allowed.includes(input.type) || typeof input.id !== "string" || input.id.length === 0) {
    throw new TypeError("invalid actor");
  }
  return input;
}

function freezeRows(rows) {
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

export function workingCopyDigest(identity, rows) {
  return digest(stableJson({
    workflowId: identity.workflowId,
    sourceRevisionId: identity.sourceRevisionId,
    targetLanguage: identity.targetLanguage,
    segments: rows.map((row) => ({
      segmentId: row.segmentId,
      headRevisionId: row.headRevisionId ?? null,
      version: row.version ?? null,
      textDigest: row.textDigest ?? null,
    })),
  }));
}

export class WorkCopyService {
  constructor(database, trustedWorkspaceId, { now = () => new Date(), id = () => randomUUID() } = {}) {
    this.database = database;
    this.workspaceId = trustedWorkspaceId;
    this.now = now;
    this.id = id;
  }

  addCandidate(workflowId, segmentId, text, actorInput) {
    const by = actor(actorInput, ["user", "fixture"]);
    if (typeof text !== "string") throw new TypeError("candidate text is required");
    const workflow = this.#workflow(workflowId);
    const candidateId = this.id();
    const timestamp = this.now().toISOString();
    try {
      this.database.transaction(() => {
        this.database.prepare("INSERT INTO translation_candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          this.workspaceId, candidateId, workflow.workflowId, workflow.documentId,
          workflow.sourceRevisionId, workflow.targetLanguage, segmentId,
          by.type === "fixture" ? "local-fixture" : "user", text, digest(text), timestamp,
        );
        this.database.prepare("INSERT INTO candidate_creation_events VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(this.workspaceId, candidateId, workflow.workflowId, segmentId, by.type, by.id, timestamp);
        this.#audit(workflowId, "candidate-created", by, true, { candidateId, segmentId });
      })();
    } catch (error) {
      if (error?.code?.startsWith("SQLITE_CONSTRAINT")) throw new WorkCopyConflictError("candidate scope conflict");
      throw error;
    }
    return this.getCandidate(candidateId);
  }

  addMachineCandidate(attemptId, text, {
    outputDigest,
    generationMode = "default",
    userCommandId = null,
  } = {}) {
    if (typeof text !== "string") throw new TypeError("candidate text is required");
    if (!/^sha256:[0-9a-f]{64}$/.test(outputDigest ?? "")) throw new TypeError("outputDigest is invalid");
    if (!["default", "user-requested"].includes(generationMode)) throw new TypeError("generationMode is invalid");
    if ((generationMode === "default" && userCommandId !== null) ||
        (generationMode === "user-requested" && (typeof userCommandId !== "string" || userCommandId.length === 0))) {
      throw new TypeError("userCommandId does not match generationMode");
    }
    const attempt = this.database.prepare(`
      SELECT attempt.*, runtime.provider_call_state, runtime.outcome_digest
      FROM translation_attempts AS attempt
      JOIN attempt_runtime_states AS runtime
        ON runtime.workspace_id = attempt.workspace_id AND runtime.attempt_id = attempt.attempt_id
      WHERE attempt.workspace_id = ? AND attempt.attempt_id = ?
        AND attempt.state = 'completed' AND runtime.provider_call_state = 'completed'
    `).get(this.workspaceId, attemptId);
    if (!attempt || attempt.outcome_digest !== outputDigest) throw new WorkCopyConflictError("completed attempt outcome mismatch");
    const workflow = this.#workflow(attempt.workflow_id);
    if (workflow.sourceRevisionId !== attempt.source_revision_id || workflow.targetLanguage !== attempt.target_language ||
        ["stale", "rejected", "exported"].includes(workflow.state)) {
      throw new WorkCopyConflictError("machine candidate workflow is unavailable");
    }
    const source = this.database.prepare("SELECT protected_json FROM source_segment_versions WHERE workspace_id = ? AND source_revision_id = ? AND segment_id = ?")
      .get(this.workspaceId, attempt.source_revision_id, attempt.segment_id);
    if (!source || text.trim().length === 0) throw new WorkCopyConflictError("machine candidate text is invalid");
    try { validateProtectedText(text, JSON.parse(source.protected_json)); }
    catch { throw new WorkCopyConflictError("machine candidate protected content mismatch"); }
    const candidateId = attemptId;
    const timestamp = this.now().toISOString();
    const by = Object.freeze({ type: "system", id: "machine-candidate-intake" });
    try {
      this.database.transaction(() => {
        this.database.prepare("INSERT INTO translation_candidates VALUES (?, ?, ?, ?, ?, ?, ?, 'machine', ?, ?, ?)").run(
          this.workspaceId, candidateId, attempt.workflow_id, attempt.document_id,
          attempt.source_revision_id, attempt.target_language, attempt.segment_id,
          text, digest(text), timestamp,
        );
        this.database.prepare("INSERT INTO candidate_creation_events VALUES (?, ?, ?, ?, 'system', ?, ?)")
          .run(this.workspaceId, candidateId, attempt.workflow_id, attempt.segment_id, by.id, timestamp);
        this.database.prepare("INSERT INTO machine_candidate_provenance VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          this.workspaceId, candidateId, attempt.task_id, attempt.attempt_id, attempt.workflow_id,
          attempt.source_revision_id, attempt.target_language, attempt.segment_id,
          attempt.provider_id, attempt.model_id, attempt.prompt_version, attempt.context_digest,
          attempt.request_digest, outputDigest, generationMode, userCommandId, timestamp,
        );
        this.#audit(attempt.workflow_id, "machine-candidate-created", by, true, {
          candidateId, attemptId, segmentId: attempt.segment_id, generationMode,
        });
      })();
    } catch (error) {
      if (error?.code?.startsWith("SQLITE_CONSTRAINT")) throw new WorkCopyConflictError("machine candidate scope or uniqueness conflict");
      throw error;
    }
    return this.getCandidate(candidateId);
  }

  getCandidate(candidateId, _untrustedWorkspaceId = undefined) {
    const row = this.database.prepare(`
      SELECT candidate.candidate_id AS candidateId, candidate.workflow_id AS workflowId,
             candidate.segment_id AS segmentId, candidate.source_type AS sourceType,
             candidate.text, candidate.text_digest AS textDigest,
             event.actor_type AS actorType, event.actor_id AS actorId
      FROM translation_candidates AS candidate
      JOIN candidate_creation_events AS event
        ON event.workspace_id = candidate.workspace_id AND event.candidate_id = candidate.candidate_id
      WHERE candidate.workspace_id = ? AND candidate.candidate_id = ?
    `).get(this.workspaceId, candidateId);
    if (!row) throw new WorkCopyConflictError("candidate not found");
    return Object.freeze(row);
  }

  getMachineProvenance(candidateId, _untrustedWorkspaceId = undefined) {
    const row = this.database.prepare(`
      SELECT candidate_id AS candidateId, task_id AS taskId, attempt_id AS attemptId,
             workflow_id AS workflowId, source_revision_id AS sourceRevisionId,
             target_language AS targetLanguage, segment_id AS segmentId,
             provider_id AS providerId, model_id AS modelId, prompt_version AS promptVersion,
             context_digest AS contextDigest, request_digest AS requestDigest,
             output_digest AS outputDigest, generation_mode AS generationMode,
             user_command_id AS userCommandId, created_at AS createdAt
      FROM machine_candidate_provenance WHERE workspace_id = ? AND candidate_id = ?
    `).get(this.workspaceId, candidateId);
    if (!row) throw new WorkCopyConflictError("machine candidate provenance not found");
    return Object.freeze(row);
  }

  listCandidates(workflowId, segmentId) {
    this.#workflow(workflowId);
    return freezeRows(this.database.prepare(`
      SELECT candidate_id AS candidateId, segment_id AS segmentId, source_type AS sourceType,
             text, text_digest AS textDigest, created_at AS createdAt
      FROM translation_candidates
      WHERE workspace_id = ? AND workflow_id = ? AND segment_id = ?
      ORDER BY created_at, candidate_id
    `).all(this.workspaceId, workflowId, segmentId));
  }

  selectCandidate(workflowId, segmentId, candidateId, expectedHeadVersion, actorInput) {
    const by = actor(actorInput);
    const workflow = this.#workflow(workflowId);
    if (by.type !== "user") {
      this.#audit(workflowId, "candidate-selection-rejected", by, false, { segmentId, reason: "actor" });
      throw new WorkCopyConflictError("only a user can select a candidate");
    }
    if (["human-reviewed", "approved-for-export", "exported", "stale", "rejected"].includes(workflow.state)) {
      this.#audit(workflowId, "candidate-selection-rejected", by, false, { segmentId, state: workflow.state });
      throw new WorkCopyConflictError("reviewed or terminal workflow cannot select a candidate");
    }
    const candidate = this.database.prepare(`
      SELECT candidate_id AS candidateId, text, text_digest AS textDigest
      FROM translation_candidates
      WHERE workspace_id = ? AND workflow_id = ? AND segment_id = ? AND candidate_id = ?
    `).get(this.workspaceId, workflowId, segmentId, candidateId);
    if (!candidate) throw new WorkCopyConflictError("candidate not found");
    return this.#appendRevision(workflow, segmentId, candidate.text, candidate.textDigest, candidateId, expectedHeadVersion, by, "candidate-selected");
  }

  edit(workflowId, segmentId, expectedHeadVersion, text, actorInput) {
    const by = actor(actorInput, ["user", "system"]);
    if (typeof text !== "string") throw new TypeError("working copy text is required");
    const workflow = this.#workflow(workflowId);
    if (["human-reviewed", "approved-for-export", "exported", "stale", "rejected"].includes(workflow.state)) {
      this.#audit(workflowId, "working-copy-edit-rejected", by, false, { segmentId, state: workflow.state });
      throw new WorkCopyConflictError("reviewed or terminal workflow cannot be edited");
    }
    return this.#appendRevision(workflow, segmentId, text, digest(text), null, expectedHeadVersion, by, "working-copy-edited");
  }

  getHead(workflowId, segmentId, _untrustedWorkspaceId = undefined) {
    this.#workflow(workflowId);
    const row = this.database.prepare(`
      SELECT head.workflow_id AS workflowId, head.segment_id AS segmentId,
             head.head_revision_id AS headRevisionId, head.version,
             revision.parent_revision_id AS parentRevisionId,
             revision.source_candidate_id AS sourceCandidateId,
             revision.text, revision.text_digest AS textDigest,
             revision.actor_type AS actorType, revision.actor_id AS actorId
      FROM working_copy_heads AS head
      JOIN working_copy_revisions AS revision
        ON revision.workspace_id = head.workspace_id
       AND revision.working_copy_revision_id = head.head_revision_id
      WHERE head.workspace_id = ? AND head.workflow_id = ? AND head.segment_id = ?
    `).get(this.workspaceId, workflowId, segmentId);
    if (!row) throw new WorkCopyConflictError("working copy not found");
    return Object.freeze(row);
  }

  getBundle(workflowId) {
    const workflow = this.#workflow(workflowId);
    const rows = this.database.prepare(`
      SELECT source.segment_id AS segmentId, source.ordinal,
             source.kind, source.structural_path AS structuralPath,
             source.source_text AS sourceText, source.protected_json AS protectedJson,
             head.head_revision_id AS headRevisionId, head.version,
             revision.text, revision.text_digest AS textDigest
      FROM source_segment_versions AS source
      LEFT JOIN working_copy_heads AS head
        ON head.workspace_id = source.workspace_id
       AND head.workflow_id = ? AND head.segment_id = source.segment_id
      LEFT JOIN working_copy_revisions AS revision
        ON revision.workspace_id = head.workspace_id
       AND revision.working_copy_revision_id = head.head_revision_id
      WHERE source.workspace_id = ? AND source.source_revision_id = ?
      ORDER BY source.ordinal
    `).all(workflowId, this.workspaceId, workflow.sourceRevisionId)
      .map((row) => ({ ...row, protected: JSON.parse(row.protectedJson) }));
    return Object.freeze({
      workflow: Object.freeze(workflow),
      segments: freezeRows(rows),
      digest: workingCopyDigest(workflow, rows),
    });
  }

  #appendRevision(workflow, segmentId, text, textDigest, candidateId, expectedHeadVersion, by, action) {
    const revisionId = this.id();
    const timestamp = this.now().toISOString();
    try {
      return this.database.transaction(() => {
        const head = this.database.prepare("SELECT head_revision_id AS headRevisionId, version FROM working_copy_heads WHERE workspace_id = ? AND workflow_id = ? AND segment_id = ?")
          .get(this.workspaceId, workflow.workflowId, segmentId);
        if ((!head && expectedHeadVersion !== null) || (head && head.version !== expectedHeadVersion)) {
          throw new WorkCopyConflictError("working copy version conflict");
        }
        this.database.prepare("INSERT INTO working_copy_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          this.workspaceId, revisionId, workflow.workflowId, workflow.documentId,
          workflow.sourceRevisionId, workflow.targetLanguage, segmentId,
          head?.headRevisionId ?? null, candidateId, text, textDigest,
          by.type, by.id, timestamp,
        );
        if (head) {
          const changed = this.database.prepare(`
            UPDATE working_copy_heads SET head_revision_id = ?, version = version + 1
            WHERE workspace_id = ? AND workflow_id = ? AND segment_id = ? AND version = ?
          `).run(revisionId, this.workspaceId, workflow.workflowId, segmentId, expectedHeadVersion).changes;
          if (changed !== 1) throw new WorkCopyConflictError("working copy version conflict");
        } else {
          this.database.prepare("INSERT INTO working_copy_heads VALUES (?, ?, ?, ?, 0)")
            .run(this.workspaceId, workflow.workflowId, segmentId, revisionId);
        }
        const m5c = this.database.prepare("SELECT 1 FROM translation_flow_controls WHERE workspace_id = ? AND workflow_id = ?").get(this.workspaceId, workflow.workflowId);
        if (m5c) {
          const coverage = this.database.prepare(`SELECT
            (SELECT count(*) FROM source_segment_versions WHERE workspace_id = ? AND source_revision_id = ? AND translatable = 1) AS expected,
            (SELECT count(*) FROM working_copy_heads WHERE workspace_id = ? AND workflow_id = ?) AS actual`)
            .get(this.workspaceId, workflow.sourceRevisionId, this.workspaceId, workflow.workflowId);
          if (coverage.expected === coverage.actual) this.database.prepare("UPDATE translation_workflows SET state = 'editing', version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND state = 'candidate-valid'")
            .run(timestamp, this.workspaceId, workflow.workflowId);
        }
        this.#audit(workflow.workflowId, action, by, true, { segmentId, revisionId, expectedHeadVersion });
        return this.getHead(workflow.workflowId, segmentId);
      })();
    } catch (error) {
      if (error instanceof WorkCopyConflictError) {
        this.#audit(workflow.workflowId, `${action}-conflict`, by, false, { segmentId, expectedHeadVersion });
        throw error;
      }
      if (error?.code?.startsWith("SQLITE_CONSTRAINT")) throw new WorkCopyConflictError("working copy scope conflict");
      throw error;
    }
  }

  #workflow(workflowId) {
    const row = this.database.prepare(`
      SELECT workflow_id AS workflowId, document_id AS documentId,
             source_revision_id AS sourceRevisionId, target_language AS targetLanguage,
             state, version
      FROM translation_workflows WHERE workspace_id = ? AND workflow_id = ?
    `).get(this.workspaceId, workflowId);
    if (!row) throw new WorkCopyConflictError("workflow not found");
    return row;
  }

  #audit(workflowId, action, by, succeeded, details) {
    this.database.prepare("INSERT INTO domain_audit_events(workspace_id,event_id,entity_type,entity_id,action,actor_type,actor_id,succeeded,details_json,occurred_at) VALUES (?, ?, 'translation-workflow', ?, ?, ?, ?, ?, ?, ?)")
      .run(this.workspaceId, this.id(), workflowId, action, by.type, by.id, succeeded ? 1 : 0, stableJson(details), this.now().toISOString());
  }
}
