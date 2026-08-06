import { providerErrorContract, providerRequestContract, providerResponseContract } from "./contracts.mjs";
import { PricingBudgetService } from "./cost-budget.mjs";
import { buildContextManifest, RESPONSE_VERSION } from "./prompt-context.mjs";
import { parseModelResponse } from "./model-response.mjs";
import { TranslationTaskOrchestrator } from "./task-orchestrator.mjs";
import { MachineCandidateService } from "../translation/machine-candidate-service.mjs";
import { TranslationFlowBudgetService } from "../m5c/flow-budget-service.mjs";
import { isUncertainProviderOutcome } from "../m5c/provider-outcome.mjs";
import { CandidateKnowledgeNeedService } from "../m5c/candidate-knowledge-need-service.mjs";

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
    evidenceService,
    flowBudgets,
    knowledgeNeeds,
  } = {}) {
    if (typeof invokeProvider !== "function") throw new TypeError("invokeProvider is required");
    if (!Number.isSafeInteger(estimatedOutputTokens) || estimatedOutputTokens < 1) throw new TypeError("estimatedOutputTokens is invalid");
    this.database = database;
    this.workspaceId = required(trustedWorkspaceId, "trustedWorkspaceId");
    this.invokeProvider = invokeProvider;
    this.managesFlowBudget = invokeProvider.managesFlowBudget === true;
    this.credentialRef = required(credentialRef, "credentialRef");
    this.pricingVersion = required(pricingVersion, "pricingVersion");
    this.workerId = required(workerId, "workerId");
    this.now = now;
    this.estimatedOutputTokens = estimatedOutputTokens;
    this.tasks = orchestrator ?? new TranslationTaskOrchestrator(database, trustedWorkspaceId, { now });
    this.budgets = budgets ?? new PricingBudgetService(database, trustedWorkspaceId, { now });
    this.candidates = candidates ?? new MachineCandidateService(database, trustedWorkspaceId, { now });
    this.flowBudgets = flowBudgets ?? new TranslationFlowBudgetService(database, trustedWorkspaceId, { now });
    this.knowledgeNeeds = knowledgeNeeds ?? new CandidateKnowledgeNeedService(database, trustedWorkspaceId, { now });
    if (evidenceService !== undefined && (!evidenceService || typeof evidenceService.evidenceIdsForAttempt !== "function"
      || typeof evidenceService.assertCurrent !== "function")) throw new TypeError("evidenceService is invalid");
    this.evidenceService = evidenceService;
  }

  #evidenceIds(attemptId) {
    const rows = this.database.prepare(`
      SELECT evidence_id AS evidenceId FROM attempt_evidence_bindings
      WHERE workspace_id = ? AND attempt_id = ? ORDER BY evidence_digest, evidence_id
    `).all(this.workspaceId, attemptId);
    if (rows.length > 0 && !this.evidenceService) throw new Error("evidence service is required for evidence-bound attempts");
    return rows.map((row) => row.evidenceId);
  }

  #temporaryContextRevisionId(attemptId) {
    return this.database.prepare("SELECT context_revision_id AS contextRevisionId FROM m5c_translation_attempt_bindings WHERE workspace_id = ? AND attempt_id = ?")
      .get(this.workspaceId, attemptId)?.contextRevisionId;
  }

  #flowBinding(attemptId) {
    return this.database.prepare("SELECT workflow_id AS workflowId, flow_budget_reservation_id AS reservationId FROM m5c_translation_attempt_bindings WHERE workspace_id = ? AND attempt_id = ?")
      .get(this.workspaceId, attemptId) ?? null;
  }

  #finalizeFlowBudget(attemptId, outcome, providerCategory = null) {
    if (this.managesFlowBudget) return null;
    const binding = this.#flowBinding(attemptId); if (!binding) return null;
    if (outcome === "unknown") {
      return this.flowBudgets.unknown(binding.workflowId, binding.reservationId,
        { attemptId, category: providerCategory ?? "translation-provider", pauseReason: "translation-unknown-outcome" });
    }
    const states = this.database.prepare(`SELECT attempt.state FROM m5c_translation_attempt_bindings binding
      JOIN translation_attempts attempt ON attempt.workspace_id = binding.workspace_id AND attempt.attempt_id = binding.attempt_id
      WHERE binding.workspace_id = ? AND binding.workflow_id = ? AND binding.flow_budget_reservation_id = ?`)
      .all(this.workspaceId, binding.workflowId, binding.reservationId);
    if (outcome === "failed" && states.every((item) => ["failed", "canceled", "unknown-outcome", "completed"].includes(item.state))) {
      const result = this.flowBudgets.release(binding.workflowId, binding.reservationId, { attemptId, reason: "translation-terminal-failure" });
      this.database.prepare("UPDATE translation_flow_controls SET flow_state = 'paused', outcome_state = 'failed', pause_reason = 'translation-failed', version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ?")
        .run(this.now().toISOString(), this.workspaceId, binding.workflowId);
      return result;
    }
    if (!states.length || states.some((item) => item.state !== "completed")) return null;
    const usage = this.database.prepare(`SELECT count(record.usage_record_id) AS calls,
      coalesce(sum(record.input_tokens), 0) AS inputTokens, coalesce(sum(record.output_tokens), 0) AS outputTokens,
      coalesce(sum(CASE WHEN record.currency = 'CNY' THEN record.amount_micros ELSE 0 END), 0) AS costMicrosCny,
      coalesce(sum(CASE WHEN record.currency = 'USD' THEN record.amount_micros ELSE 0 END), 0) AS costMicrosUsd
      FROM m5c_translation_attempt_bindings binding JOIN usage_cost_records record
        ON record.workspace_id = binding.workspace_id AND record.attempt_id = binding.attempt_id
      WHERE binding.workspace_id = ? AND binding.workflow_id = ? AND binding.flow_budget_reservation_id = ?`)
      .get(this.workspaceId, binding.workflowId, binding.reservationId);
    return this.flowBudgets.settle(binding.workflowId, binding.reservationId, { ...usage, durationMs: 0 }, { attemptId, completedAttempts: states.length });
  }

  #assertEvidence(evidenceIds) {
    for (const evidenceId of evidenceIds) this.evidenceService.assertCurrent(evidenceId);
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
        AND (NOT EXISTS (SELECT 1 FROM translation_flow_controls flow WHERE flow.workspace_id = attempt.workspace_id AND flow.workflow_id = attempt.workflow_id)
          OR EXISTS (SELECT 1 FROM translation_flow_controls flow WHERE flow.workspace_id = attempt.workspace_id AND flow.workflow_id = attempt.workflow_id
            AND flow.flow_state IN ('translating','remediation') AND flow.outcome_state = 'none'))
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
    const evidenceIds = this.#evidenceIds(next.attemptId);
    this.#assertEvidence(evidenceIds);
    const context = buildContextManifest(this.database, this.workspaceId, {
      workflowId: next.workflowId,
      segmentIds: [next.segmentId],
      promptVersion: next.promptVersion,
      ...(evidenceIds.length === 0 ? {} : { evidenceIds }),
      ...((this.#temporaryContextRevisionId(next.attemptId)) ? { temporaryContextRevisionId: this.#temporaryContextRevisionId(next.attemptId) } : {}),
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
    let evidenceIds;
    let context;
    let request;
    try {
      evidenceIds = this.#evidenceIds(lease.attempt_id);
      this.#assertEvidence(evidenceIds);
      context = buildContextManifest(this.database, this.workspaceId, {
        workflowId: lease.workflow_id,
        segmentIds: [lease.segment_id],
        promptVersion: lease.prompt_version,
        ...(evidenceIds.length === 0 ? {} : { evidenceIds }),
        ...((this.#temporaryContextRevisionId(lease.attempt_id)) ? { temporaryContextRevisionId: this.#temporaryContextRevisionId(lease.attempt_id) } : {}),
      });
      if (context.contextDigest !== lease.context_digest) throw Object.assign(new Error("attempt context digest mismatch"), { category: "policy", retryable: false });
      request = providerRequestContract({
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
      ...(context.manifest.evidence ? { evidence: context.manifest.evidence } : {}),
      ...(context.manifest.translationContext ? { translationContext: context.manifest.translationContext } : {}),
      });
    } catch (error) {
      const normalized = normalizedFailure(error);
      try {
        this.tasks.fail(lease.attempt_id, lease.version, this.workerId, normalized); this.budgets.release(reservation.reservation_id);
        this.#finalizeFlowBudget(lease.attempt_id, "failed");
      } catch {}
      return Object.freeze({ status: "failed", attemptId: lease.attempt_id, error: normalized });
    }
    const running = this.tasks.startProvider(lease.attempt_id, lease.version, this.workerId);
    let providerResponse;
    let providerCandidate;
    let strictResponse;
    let parsed;
    try {
      const rawProviderResponse = await this.invokeProvider(request, { credentialRef: this.credentialRef, signal });
      try {
        providerResponse = providerResponseContract(rawProviderResponse, request);
      } catch {
        throw Object.assign(new Error("provider response validation failed"), { category: "malformed-response", retryable: false });
      }
      providerCandidate = providerResponse.candidates[0];
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
      for (const evidenceId of evidenceIds) this.evidenceService.assertCurrent(evidenceId);
    } catch (error) {
      const normalized = normalizedFailure(error);
      try {
        const uncertain = isUncertainProviderOutcome(normalized.category);
        this.database.transaction(() => {
          this.tasks.fail(lease.attempt_id, running.version, this.workerId,
            uncertain ? { ...normalized, category: "unknown-outcome", retryable: false } : normalized);
          if (uncertain) this.budgets.finalize(reservation.reservation_id, null);
          else this.budgets.release(reservation.reservation_id);
          this.#finalizeFlowBudget(lease.attempt_id, uncertain ? "unknown" : "failed", normalized.category);
        }).immediate();
      } catch {
        // A concurrent terminal transition or a local persistence failure is recovered by lease expiry.
      }
      return Object.freeze({ status: "failed", attemptId: lease.attempt_id, error: normalized });
    }
    try {
      const usage = this.budgets.pricedUsage(request.providerId, request.modelId, this.pricingVersion, {
        providerId: request.providerId,
        modelId: request.modelId,
        providerResponseId: providerResponse.responseId,
        ...providerResponse.usage,
      });
      let candidate; let capturedNeeds; let budget; let flowBudget;
      this.database.transaction(() => {
        this.tasks.complete(lease.attempt_id, running.version, this.workerId, parsed.outputDigest, { usage });
        candidate = this.candidates.accept(lease.attempt_id, strictResponse);
        capturedNeeds = this.#flowBinding(lease.attempt_id) && providerCandidate.knowledgeNeeds.length > 0
          ? this.knowledgeNeeds.captureTranslation(lease.attempt_id, providerCandidate.knowledgeNeeds) : Object.freeze([]);
        const coverage = this.database.prepare(`SELECT
          (SELECT count(*) FROM source_segment_versions source JOIN translation_workflows workflow
            ON workflow.workspace_id = source.workspace_id AND workflow.source_revision_id = source.source_revision_id
            WHERE workflow.workspace_id = ? AND workflow.workflow_id = ? AND source.translatable = 1) AS expected,
          (SELECT count(DISTINCT provenance.segment_id) FROM machine_candidate_provenance provenance
            WHERE provenance.workspace_id = ? AND provenance.workflow_id = ?) AS actual`).get(this.workspaceId, lease.workflow_id, this.workspaceId, lease.workflow_id);
        if (coverage.expected === coverage.actual) this.database.prepare("UPDATE translation_workflows SET state = 'candidate-valid', version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND state = 'draft-machine'")
          .run(this.now().toISOString(), this.workspaceId, lease.workflow_id);
        const usageRecord = this.database.prepare("SELECT usage_record_id FROM usage_cost_records WHERE workspace_id = ? AND attempt_id = ?")
          .get(this.workspaceId, lease.attempt_id);
        budget = this.budgets.finalize(reservation.reservation_id, usageRecord?.usage_record_id ?? null);
        flowBudget = this.#finalizeFlowBudget(lease.attempt_id, "completed");
      }).immediate();
      return Object.freeze({ status: "completed", taskId: lease.task_id, attemptId: lease.attempt_id, candidate,
        knowledgeNeeds: capturedNeeds, usage, budget, ...(flowBudget ? { flowBudget } : {}) });
    } catch (error) {
      const safeCode = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(error.code) ? error.code
        : String(error?.message).includes("budget") ? "BUDGET_PERSISTENCE"
          : String(error?.message).includes("candidate") ? "CANDIDATE_PERSISTENCE"
            : String(error?.message).includes("knowledge") ? "KNOWLEDGE_NEED_PERSISTENCE"
              : typeof error?.name === "string" ? error.name.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase().slice(0, 64) : undefined;
      const unknown = normalizedFailure({ category: "unknown-outcome", retryable: false, ...(safeCode ? { providerCode: safeCode } : {}) });
      try {
        this.database.transaction(() => {
          this.tasks.fail(lease.attempt_id, running.version, this.workerId, unknown);
          this.budgets.finalize(reservation.reservation_id, null);
          this.#finalizeFlowBudget(lease.attempt_id, "unknown", "unknown-outcome");
        }).immediate();
      } catch {
        // Lease expiry provides a final conservative recovery path if persistence itself is unavailable.
      }
      return Object.freeze({ status: "failed", attemptId: lease.attempt_id, error: unknown });
    }
  }
}
