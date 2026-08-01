import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { DomainStateService } from "../domain/state-service.mjs";
import { buildContextManifest, PROMPT_VERSION } from "../provider/prompt-context.mjs";
import { TranslationTaskOrchestrator } from "../provider/task-orchestrator.mjs";
import { ResearchAuthorizationError, ResearchConflictError } from "./foundation-service.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function user(input) {
  if (!input || input.type !== "user" || typeof input.id !== "string" || input.id.length === 0) {
    throw new ResearchAuthorizationError("only a user can request retranslation");
  }
  return input;
}

export class ManualRetranslationService {
  constructor(database, workspaceId, { evidence, now = () => new Date(), states, tasks } = {}) {
    if (!evidence || typeof evidence.capture !== "function" || typeof evidence.bindAttempt !== "function") throw new TypeError("evidence service is required");
    this.database = database; this.workspaceId = workspaceId; this.evidence = evidence;
    this.states = states ?? new DomainStateService(database, workspaceId, { now });
    this.tasks = tasks ?? new TranslationTaskOrchestrator(database, workspaceId, { now });
  }

  trigger(input, actorInput) {
    const by = user(actorInput);
    const allowed = ["workflowId", "segmentId", "query", "kinds", "tags", "topK", "providerId", "modelId", "promptVersion", "idempotencyKey"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) {
      throw new TypeError("retranslation request is invalid");
    }
    for (const key of ["workflowId", "segmentId", "query", "providerId", "modelId", "idempotencyKey"])
      if (typeof input[key] !== "string" || input[key].length === 0) throw new TypeError(`retranslation ${key} is invalid`);
    const existing = this.database.prepare("SELECT task_id AS taskId FROM translation_tasks WHERE workspace_id = ? AND workflow_id = ? AND idempotency_key = ?")
      .get(this.workspaceId, input.workflowId, input.idempotencyKey);
    if (existing) return this.#result(existing.taskId);
    return this.database.transaction(() => {
      let workflow = this.states.get(input.workflowId);
      if (workflow.state === "exported") workflow = this.states.transition(input.workflowId, workflow.version, "stale", by);
      if (workflow.state === "stale") workflow = this.states.transition(input.workflowId, workflow.version, "queued", by);
      if (workflow.state !== "queued") throw new ResearchConflictError("workflow is not eligible for manual retranslation");
      const snapshot = this.evidence.capture({ workflowId: input.workflowId, segmentId: input.segmentId, query: input.query,
        kinds: input.kinds, tags: input.tags ?? [], topK: input.topK });
      const context = buildContextManifest(this.database, this.workspaceId, { workflowId: input.workflowId, segmentIds: [input.segmentId],
        promptVersion: input.promptVersion ?? PROMPT_VERSION, evidenceIds: [snapshot.evidenceId] });
      const identity = { workflowId: workflow.workflowId, segmentId: input.segmentId, evidenceDigest: snapshot.evidenceDigest,
        providerId: input.providerId, modelId: input.modelId, promptVersion: context.manifest.promptVersion };
      const created = this.tasks.enqueue({ workflowId: workflow.workflowId, documentId: workflow.documentId,
        sourceRevisionId: workflow.sourceRevisionId, targetLanguage: workflow.targetLanguage, segmentIds: [input.segmentId],
        idempotencyKey: input.idempotencyKey, requestDigest: sha(stableJson(identity)), policyVersion: "manual-retranslation-v1",
        providerId: input.providerId, modelId: input.modelId, promptVersion: context.manifest.promptVersion,
        contextDigest: context.contextDigest, maxAttempts: 3, batchSize: 1 });
      this.evidence.bindAttempt(created.attempts[0].attempt_id, [snapshot.evidenceId]);
      return Object.freeze({ task: created, evidence: snapshot, contextDigest: context.contextDigest, reused: false });
    })();
  }

  #result(taskId) {
    const task = this.tasks.getTask(taskId);
    const evidenceId = this.database.prepare("SELECT evidence_id AS evidenceId FROM attempt_evidence_bindings WHERE workspace_id = ? AND attempt_id = ?")
      .get(this.workspaceId, task.attempts[0].attempt_id)?.evidenceId;
    if (!evidenceId) throw new ResearchConflictError("retranslation evidence binding is unavailable");
    return Object.freeze({ task, evidence: this.evidence.get(evidenceId), contextDigest: task.attempts[0].context_digest, reused: true });
  }
}
