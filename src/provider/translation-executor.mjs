import { providerErrorContract, providerRequestContract, providerResponseContract } from "./contracts.mjs";
import { PricingBudgetService } from "./cost-budget.mjs";
import { buildContextManifest, RESPONSE_VERSION } from "./prompt-context.mjs";
import { parseModelResponse } from "./model-response.mjs";
import { TranslationTaskOrchestrator } from "./task-orchestrator.mjs";
import { MachineCandidateService } from "../translation/machine-candidate-service.mjs";

function required(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function normalizedFailure(error) {
  try {
    return providerErrorContract({
      category: error?.category,
      message: "provider execution failed",
      retryable: error?.retryable === true,
      ...(error?.providerCode === undefined ? {} : { providerCode: String(error.providerCode) }),
    });
  } catch {
    return providerErrorContract({ category: "provider", message: "provider execution failed", retryable: false });
  }
}

export class TranslationExecutor {
  constructor(database, trustedWorkspaceId, {
    invokeProvider,
    credentialRef,
    pricingVersion,
    workerId = "translation-executor",
    estimatedOutputTokens = 1_024,
    now = () => new Date(),
    orchestrator,
    budgets,
    candidates,
  } = {}) {
    if (typeof invokeProvider !== "function") throw new TypeError("invokeProvider is required");
    if (!Number.isSafeInteger(estimatedOutputTokens) || estimatedOutputTokens < 1) throw new TypeError("estimatedOutputTokens is invalid");
    this.database = database;
    this.workspaceId = required(trustedWorkspaceId, "trustedWorkspaceId");
    this.invokeProvider = invokeProvider;
    this.credentialRef = required(credentialRef, "credentialRef");
    this.pricingVersion = required(pricingVersion, "pricingVersion");
    this.workerId = required(workerId, "workerId");
    this.estimatedOutputTokens = estimatedOutputTokens;
    this.tasks = orchestrator ?? new TranslationTaskOrchestrator(database, trustedWorkspaceId, { now });
    this.budgets = budgets ?? new PricingBudgetService(database, trustedWorkspaceId, { now });
    this.candidates = candidates ?? new MachineCandidateService(database, trustedWorkspaceId, { now });
  }

  #nextUnreserved() {
    return this.database.prepare(`
      SELECT attempt.attempt_id AS attemptId, attempt.workflow_id AS workflowId,
             attempt.segment_id AS segmentId, attempt.prompt_version AS promptVersion
      FROM translation_attempts attempt
      JOIN translation_tasks task ON task.workspace_id = attempt.workspace_id AND task.task_id = attempt.task_id
      JOIN task_budget_assignments assignment ON assignment.workspace_id = attempt.workspace_id AND assignment.task_id = attempt.task_id
      WHERE attempt.workspace_id = ? AND attempt.state IN ('queued', 'retry-wait')
        AND task.state IN ('queued', 'running') AND assignment.state = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM budget_reservations reservation
          WHERE reservation.workspace_id = attempt.workspace_id AND reservation.attempt_id = attempt.attempt_id
        )
      ORDER BY attempt.created_at, attempt.attempt_id LIMIT 1
    `).get(this.workspaceId);
  }

  #ensureReservation() {
    const next = this.#nextUnreserved();
    if (!next) return null;
    const context = buildContextManifest(this.database, this.workspaceId, {
      workflowId: next.workflowId,
      segmentIds: [next.segmentId],
      promptVersion: next.promptVersion,
    });
    try {
      return this.budgets.reserve(next.attemptId, this.pricingVersion, {
        inputTokens: context.estimatedTokens,
        outputTokens: this.estimatedOutputTokens,
        cachedInputTokens: 0,
      });
    } catch (error) {
      if (String(error?.message).includes("UNIQUE constraint failed")) return null;
      throw error;
    }
  }

  async executeNext({ signal } = {}) {
    let lease = this.tasks.leaseNext(this.workerId);
    if (!lease) {
      const reservation = this.#ensureReservation();
      if (reservation && reservation.decision !== "reserved") return Object.freeze({ status: reservation.decision });
      lease = this.tasks.leaseNext(this.workerId);
    }
    if (!lease) return Object.freeze({ status: "idle" });
    const reservation = this.database.prepare("SELECT * FROM budget_reservations WHERE workspace_id = ? AND attempt_id = ? AND state = 'reserved'")
      .get(this.workspaceId, lease.attempt_id);
    if (!reservation) throw new Error("leased attempt has no active budget reservation");
    const context = buildContextManifest(this.database, this.workspaceId, {
      workflowId: lease.workflow_id,
      segmentIds: [lease.segment_id],
      promptVersion: lease.prompt_version,
    });
    if (context.contextDigest !== lease.context_digest) throw new Error("attempt context digest mismatch");
    const request = providerRequestContract({
      workspaceId: this.workspaceId,
      taskId: lease.task_id,
      attemptId: lease.attempt_id,
      workflowId: lease.workflow_id,
      sourceRevisionId: lease.source_revision_id,
      targetLanguage: lease.target_language,
      providerId: lease.provider_id,
      modelId: lease.model_id,
      maxOutputTokens: this.estimatedOutputTokens,
      promptVersion: lease.prompt_version,
      contextDigest: lease.context_digest,
      segments: context.manifest.segments.map((segment) => ({
        segmentId: segment.segmentId,
        sourceDigest: segment.sourceDigest,
        sourceText: segment.sourceText,
        protected: segment.protected,
      })),
    });
    const running = this.tasks.startProvider(lease.attempt_id, lease.version, this.workerId);
    let providerResponse;
    let strictResponse;
    let parsed;
    try {
      const rawProviderResponse = await this.invokeProvider(request, { credentialRef: this.credentialRef, signal });
      try {
        providerResponse = providerResponseContract(rawProviderResponse, request);
      } catch {
        throw Object.assign(new Error("provider response validation failed"), { category: "malformed-response", retryable: false });
      }
      const providerCandidate = providerResponse.candidates[0];
      const segment = context.manifest.segments[0];
      strictResponse = {
        schemaVersion: RESPONSE_VERSION,
        workflowId: context.manifest.workflowId,
        sourceRevisionId: context.manifest.sourceRevisionId,
        targetLanguage: context.manifest.targetLanguage,
        candidates: [{
          segmentId: segment.segmentId,
          structuralPath: segment.structuralPath,
          kind: segment.kind,
          text: providerCandidate.text,
        }],
      };
      try {
        parsed = parseModelResponse(strictResponse, context);
      } catch {
        throw Object.assign(new Error("model response validation failed"), { category: "malformed-response", retryable: false });
      }
    } catch (error) {
      const normalized = normalizedFailure(error);
      try {
        this.tasks.fail(lease.attempt_id, running.version, this.workerId, normalized);
        if (normalized.category === "unknown-outcome") this.budgets.finalize(reservation.reservation_id, null);
        else this.budgets.release(reservation.reservation_id);
      } catch {
        // A concurrent terminal transition or a local persistence failure is recovered by lease expiry.
      }
      return Object.freeze({ status: "failed", attemptId: lease.attempt_id, error: normalized });
    }
    const usage = this.budgets.pricedUsage(request.providerId, request.modelId, this.pricingVersion, {
      providerId: request.providerId,
      modelId: request.modelId,
      providerResponseId: providerResponse.responseId,
      ...providerResponse.usage,
    });
    let candidate;
    let budget;
    this.database.transaction(() => {
      this.tasks.complete(lease.attempt_id, running.version, this.workerId, parsed.outputDigest, { usage });
      candidate = this.candidates.accept(lease.attempt_id, strictResponse);
      const usageRecord = this.database.prepare("SELECT usage_record_id FROM usage_cost_records WHERE workspace_id = ? AND attempt_id = ?")
        .get(this.workspaceId, lease.attempt_id);
      budget = this.budgets.finalize(reservation.reservation_id, usageRecord?.usage_record_id ?? null);
    })();
    return Object.freeze({ status: "completed", taskId: lease.task_id, attemptId: lease.attempt_id, candidate, usage, budget });
  }
}
