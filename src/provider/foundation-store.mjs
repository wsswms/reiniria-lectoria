import { randomUUID } from "node:crypto";

function required(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

export class M4FoundationStore {
  constructor(database, trustedWorkspaceId, { id = () => randomUUID(), now = () => new Date() } = {}) {
    this.database = database;
    this.workspaceId = required(trustedWorkspaceId, "trustedWorkspaceId");
    this.id = id;
    this.now = now;
  }

  createTask(input) {
    const scope = this.database.prepare(`
      SELECT document_id, source_revision_id, target_language
      FROM translation_workflows
      WHERE workspace_id = ? AND workflow_id = ?
        AND document_id = ? AND source_revision_id = ? AND target_language = ?
    `).get(this.workspaceId, input.workflowId, input.documentId, input.sourceRevisionId, input.targetLanguage);
    if (!scope) throw new Error("translation task scope mismatch");
    const taskId = this.id();
    const timestamp = this.now().toISOString();
    this.database.prepare("INSERT INTO translation_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)")
      .run(this.workspaceId, taskId, input.workflowId, scope.document_id, scope.source_revision_id, scope.target_language,
        required(input.idempotencyKey, "idempotencyKey"), required(input.requestDigest, "requestDigest"), required(input.policyVersion, "policyVersion"), timestamp, timestamp);
    return Object.freeze({ workspaceId: this.workspaceId, taskId, state: "queued", version: 0 });
  }

  createAttempt(input) {
    const task = this.database.prepare(`
      SELECT workflow_id, document_id, source_revision_id, target_language
      FROM translation_tasks
      WHERE workspace_id = ? AND task_id = ?
        AND workflow_id = ? AND document_id = ? AND source_revision_id = ? AND target_language = ?
    `).get(this.workspaceId, input.taskId, input.workflowId, input.documentId, input.sourceRevisionId, input.targetLanguage);
    const segment = this.database.prepare(`
      SELECT 1 FROM source_segment_versions
      WHERE workspace_id = ? AND source_revision_id = ? AND segment_id = ?
    `).get(this.workspaceId, input.sourceRevisionId, input.segmentId);
    if (!task || !segment) throw new Error("translation attempt scope mismatch");
    const attemptId = this.id();
    this.database.prepare("INSERT INTO translation_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, NULL)")
      .run(this.workspaceId, attemptId, input.taskId, task.workflow_id, task.document_id, task.source_revision_id, task.target_language,
        input.segmentId, required(input.providerId, "providerId"), required(input.modelId, "modelId"), required(input.promptVersion, "promptVersion"),
        required(input.contextDigest, "contextDigest"), required(input.requestDigest, "requestDigest"), this.now().toISOString());
    return Object.freeze({ workspaceId: this.workspaceId, taskId: input.taskId, attemptId, state: "queued", version: 0 });
  }

  recordUsage(input) {
    const attempt = this.database.prepare(`
      SELECT 1 FROM translation_attempts
      WHERE workspace_id = ? AND attempt_id = ? AND task_id = ? AND provider_id = ? AND model_id = ?
    `).get(this.workspaceId, input.attemptId, input.taskId, input.providerId, input.modelId);
    if (!attempt) throw new Error("usage record scope mismatch");
    const usageRecordId = this.id();
    this.database.prepare("INSERT INTO usage_cost_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.workspaceId, usageRecordId, input.taskId, input.attemptId, input.providerId, input.modelId,
        required(input.providerResponseId, "providerResponseId"), integer(input.inputTokens, "inputTokens"),
        integer(input.outputTokens, "outputTokens"), integer(input.cachedInputTokens, "cachedInputTokens"),
        integer(input.totalTokens, "totalTokens"), input.currency ?? null, input.amountMicros ?? null, input.pricingVersion ?? null, this.now().toISOString());
    return Object.freeze({ workspaceId: this.workspaceId, usageRecordId, taskId: input.taskId, attemptId: input.attemptId });
  }
}
