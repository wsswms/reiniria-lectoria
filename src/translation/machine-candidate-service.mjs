import { randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { buildContextManifest } from "../provider/prompt-context.mjs";
import { parseModelResponse } from "../provider/model-response.mjs";
import { WorkCopyConflictError, WorkCopyService } from "./work-copy-service.mjs";

export class MachineCandidateConflictError extends Error {
  constructor(message = "machine candidate conflict") {
    super(message);
    this.name = "MachineCandidateConflictError";
    this.code = "MACHINE_CANDIDATE_CONFLICT";
  }
}

export class MachineCandidateService {
  constructor(database, trustedWorkspaceId, { now = () => new Date(), id = () => randomUUID(), workCopies } = {}) {
    this.database = database;
    this.workspaceId = trustedWorkspaceId;
    this.now = now;
    this.id = id;
    this.workCopies = workCopies ?? new WorkCopyService(database, trustedWorkspaceId, { now, id });
  }

  authorizeAdditionalCandidate(taskId, commandId, requestDigest, actor) {
    if (!actor || actor.type !== "user" || typeof actor.id !== "string" || actor.id.length === 0) {
      throw new MachineCandidateConflictError("only a user can request an additional candidate");
    }
    if (typeof commandId !== "string" || commandId.length === 0 || !/^sha256:[0-9a-f]{64}$/.test(requestDigest ?? "")) {
      throw new TypeError("additional candidate command is invalid");
    }
    const task = this.database.prepare("SELECT workflow_id FROM translation_tasks WHERE workspace_id = ? AND task_id = ?")
      .get(this.workspaceId, taskId);
    if (!task) throw new MachineCandidateConflictError("task not found");
    const result = stableJson({ actorId: actor.id, actorType: "user", authorized: true, commandId });
    try {
      this.database.prepare("INSERT INTO task_command_results VALUES (?, ?, 'machine-candidate:append', ?, ?, ?, ?)")
        .run(this.workspaceId, taskId, commandId, requestDigest, result, this.now().toISOString());
    } catch (error) {
      const existing = this.database.prepare("SELECT request_digest, result_json FROM task_command_results WHERE workspace_id = ? AND task_id = ? AND operation = 'machine-candidate:append' AND idempotency_key = ?")
        .get(this.workspaceId, taskId, commandId);
      if (!existing || existing.request_digest !== requestDigest || existing.result_json !== result) {
        throw new MachineCandidateConflictError("additional candidate command conflict");
      }
    }
    return Object.freeze(JSON.parse(result));
  }

  accept(attemptId, responseInput, { generationMode = "default", userCommandId = null, limits } = {}) {
    const attempt = this.database.prepare(`
      SELECT attempt_id AS attemptId, task_id AS taskId, workflow_id AS workflowId,
             segment_id AS segmentId, prompt_version AS promptVersion,
             context_digest AS contextDigest, state
      FROM translation_attempts WHERE workspace_id = ? AND attempt_id = ?
    `).get(this.workspaceId, attemptId);
    if (!attempt || attempt.state !== "completed") throw new MachineCandidateConflictError("attempt is not completed");
    if (generationMode === "user-requested") {
      const authorization = this.database.prepare(`
        SELECT result_json AS resultJson FROM task_command_results
        WHERE workspace_id = ? AND task_id = ? AND operation = 'machine-candidate:append' AND idempotency_key = ?
      `).get(this.workspaceId, attempt.taskId, userCommandId);
      if (!authorization || JSON.parse(authorization.resultJson).actorType !== "user") {
        throw new MachineCandidateConflictError("additional candidate lacks explicit user authorization");
      }
    }
    const context = buildContextManifest(this.database, this.workspaceId, {
      workflowId: attempt.workflowId,
      segmentIds: [attempt.segmentId],
      promptVersion: attempt.promptVersion,
    });
    if (context.contextDigest !== attempt.contextDigest) throw new MachineCandidateConflictError("stored context digest mismatch");
    const parsed = parseModelResponse(responseInput, context, limits);
    try {
      return this.workCopies.addMachineCandidate(attemptId, parsed.response.candidates[0].text, {
        outputDigest: parsed.outputDigest,
        generationMode,
        userCommandId,
      });
    } catch (error) {
      if (error instanceof WorkCopyConflictError) throw new MachineCandidateConflictError(error.message);
      throw error;
    }
  }
}
