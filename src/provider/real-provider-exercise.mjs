import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DocumentImportService } from "../document/import-service.mjs";
import { DomainStateService } from "../domain/state-service.mjs";
import { ExportService } from "../export/export-service.mjs";
import { ReviewService } from "../translation/review-service.mjs";
import { ValidationService } from "../translation/validator.mjs";
import { WorkCopyService } from "../translation/work-copy-service.mjs";
import { CapabilityAuthority } from "../runner/capability.mjs";
import { invokeProviderThroughRunner } from "../runner/provider-runner.mjs";
import { PricingBudgetService } from "./cost-budget.mjs";
import { buildContextManifest } from "./prompt-context.mjs";
import { createRealRunDryPlan, realRunConfigContract } from "./real-run-preflight.mjs";
import { TranslationExecutor } from "./translation-executor.mjs";
import { TranslationTaskOrchestrator } from "./task-orchestrator.mjs";

const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function actor(id) { return Object.freeze({ type: "user", id }); }

function sourceSegments(database, workspaceId, sourceRevisionId) {
  return database.prepare(`
    SELECT segment_id AS segmentId, ordinal, translatable
    FROM source_segment_versions
    WHERE workspace_id = ? AND source_revision_id = ?
    ORDER BY ordinal
  `).all(workspaceId, sourceRevisionId);
}

export async function runRealProviderExercise({
  database,
  root,
  workspaceId,
  config: configInput,
  corpus,
  corpusSourceBytes,
  invokeProvider,
  runnerIdentity,
  now = () => new Date(),
  id = () => randomUUID(),
}) {
  if (typeof invokeProvider !== "function") throw new TypeError("invokeProvider is required");
  if (!runnerIdentity || !Number.isSafeInteger(runnerIdentity.uid) || !Number.isSafeInteger(runnerIdentity.gid)
    || runnerIdentity.uid <= 0 || runnerIdentity.gid <= 0) {
    throw new TypeError("an unprivileged runner identity is required");
  }
  const config = realRunConfigContract(configInput, { allowLive: true });
  if (config.mode !== "live") throw new TypeError("real Provider exercise requires live mode");
  const dryPlan = createRealRunDryPlan({ ...config, mode: "dry-run" }, corpus, corpusSourceBytes);
  const imports = new DocumentImportService({ database, root, trustedWorkspaceId: workspaceId, now, id });
  const states = new DomainStateService(database, workspaceId, { now, id });
  const workCopies = new WorkCopyService(database, workspaceId, { now, id });
  const validation = new ValidationService(database, workspaceId, { now, id, workCopies });
  const reviews = new ReviewService(database, workspaceId, { now, id, validation });
  const exports = new ExportService({ database, root, trustedWorkspaceId: workspaceId, now, id, workCopies, validation });
  const tasks = new TranslationTaskOrchestrator(database, workspaceId, { now, id });
  const budgets = new PricingBudgetService(database, workspaceId, { now, id });
  budgets.addPricing({
    providerId: config.providerId,
    modelId: config.modelId,
    pricingVersion: config.pricing.version,
    currency: config.limits.currency,
    inputMicrosPerMillion: config.pricing.inputMicrosPerMillion,
    outputMicrosPerMillion: config.pricing.outputMicrosPerMillion,
    cachedInputMicrosPerMillion: config.pricing.cachedInputMicrosPerMillion,
    source: config.pricing.source,
  });
  const policyVersion = `real-exercise-${createHash("sha256").update(JSON.stringify({
    providerId: config.providerId,
    modelId: config.modelId,
    hardLimitMicros: config.limits.hardLimitMicros,
  })).digest("hex").slice(0, 16)}`;
  budgets.addPolicy({
    policyVersion,
    currency: config.limits.currency,
    softLimitMicros: config.limits.hardLimitMicros,
    hardLimitMicros: config.limits.hardLimitMicros,
    unknownPriceAction: "block",
  });

  const documents = [];
  for (const item of corpus) {
    const imported = await imports.import({ format: item.format, content: item.content, title: `M4 real exercise ${item.id}` });
    imports.confirm(imported.importId, actor("real-exercise-owner"));
    const workflowId = id();
    states.create({
      workflowId,
      documentId: imported.documentId,
      sourceRevisionId: imported.sourceRevisionId,
      targetLanguage: item.targetLanguage,
    }, {}, "editing");
    const segments = sourceSegments(database, workspaceId, imported.sourceRevisionId);
    const translatable = segments.filter((segment) => segment.translatable === 1);
    const contextDigests = Object.fromEntries(translatable.map((segment) => [
      segment.segmentId,
      buildContextManifest(database, workspaceId, {
        workflowId,
        segmentIds: [segment.segmentId],
        promptVersion: "lectoria-translation-v1",
      }).contextDigest,
    ]));
    const created = tasks.enqueue({
      workflowId,
      documentId: imported.documentId,
      sourceRevisionId: imported.sourceRevisionId,
      targetLanguage: item.targetLanguage,
      segmentIds: translatable.map((segment) => segment.segmentId),
      idempotencyKey: `real-exercise:${item.id}`,
      requestDigest: digest(JSON.stringify({ itemId: item.id, contextDigests })),
      policyVersion,
      providerId: config.providerId,
      modelId: config.modelId,
      promptVersion: "lectoria-translation-v1",
      contextDigests,
      maxAttempts: 1,
      batchSize: 1,
    });
    budgets.assignTask(created.task.task_id, policyVersion);
    documents.push({ item, imported, workflowId, segments, taskId: created.task.task_id });
  }

  let providerCalls = 0;
  const capabilityAuthority = new CapabilityAuthority(randomBytes(32));
  const guardedBrokerInvoke = async (request, options) => {
    if (providerCalls >= config.limits.maxCalls) {
      throw Object.assign(new Error("real Provider call limit reached"), { category: "budget", retryable: false });
    }
    providerCalls += 1;
    return invokeProvider(request, options);
  };
  const guardedInvoke = (request, options) => invokeProviderThroughRunner({
    request,
    invokeProvider: guardedBrokerInvoke,
    providerOptions: options,
    capabilityAuthority,
    signal: options.signal,
    runnerIdentity,
  });
  const executor = new TranslationExecutor(database, workspaceId, {
    invokeProvider: guardedInvoke,
    credentialRef: `file:provider/${config.providerId}`,
    pricingVersion: config.pricing.version,
    workerId: "real-provider-exercise",
    estimatedOutputTokens: config.limits.maxOutputTokens,
    now,
    orchestrator: tasks,
    budgets,
  });

  const generated = [];
  while (generated.length < dryPlan.calls) {
    const result = await executor.executeNext();
    if (result.status !== "completed") {
      throw Object.assign(new Error("real Provider exercise did not complete"), { result });
    }
    generated.push(result);
  }
  if ((await executor.executeNext()).status !== "idle") throw new Error("real Provider exercise left pending attempts");

  let userEdits = 0;
  let validationCorrections = 0;
  let validationReruns = 0;
  let warningsConfirmed = 0;
  let ordinaryExports = 0;
  let canonicalExports = 0;
  for (const document of documents) {
    const candidates = new Map(database.prepare(`
      SELECT segment_id AS segmentId, candidate_id AS candidateId
      FROM translation_candidates
      WHERE workspace_id = ? AND workflow_id = ? AND source_type = 'machine'
    `).all(workspaceId, document.workflowId).map((row) => [row.segmentId, row.candidateId]));
    for (const segment of document.segments) {
      let candidateId = candidates.get(segment.segmentId);
      if (!candidateId) {
        const bundleSegment = workCopies.getBundle(document.workflowId).segments.find((item) => item.segmentId === segment.segmentId);
        candidateId = workCopies.addCandidate(document.workflowId, segment.segmentId, bundleSegment.sourceText, actor("real-exercise-owner")).candidateId;
      }
      const selected = workCopies.selectCandidate(document.workflowId, segment.segmentId, candidateId, null, actor("real-exercise-editor"));
      workCopies.edit(document.workflowId, segment.segmentId, selected.version, selected.text, actor("real-exercise-editor"));
      userEdits += 1;
    }
    let run = validation.run(document.workflowId);
    const errors = run.findings.filter((finding) => finding.severity === "error");
    if (errors.length > 0) {
      const invalidSegments = new Set(errors.map((finding) => finding.segmentId).filter(Boolean));
      const bundle = workCopies.getBundle(document.workflowId);
      const corrections = invalidSegments.size === 0
        ? bundle.segments
        : bundle.segments.filter((segment) => invalidSegments.has(segment.segmentId));
      for (const segment of corrections) {
        workCopies.edit(
          document.workflowId,
          segment.segmentId,
          segment.version,
          segment.sourceText,
          actor("real-exercise-editor"),
        );
        userEdits += 1;
        validationCorrections += 1;
      }
      run = validation.run(document.workflowId);
      validationReruns += 1;
    }
    if (run.findings.some((finding) => finding.severity === "error")) {
      throw Object.assign(new Error("real Provider candidate failed validation after user correction"), { category: "validation" });
    }
    for (const warning of run.findings.filter((finding) => finding.severity === "warning")) {
      reviews.confirmWarning(document.workflowId, run.validationRunId, warning.findingId, actor("real-exercise-reviewer"));
      warningsConfirmed += 1;
    }
    reviews.humanReview(document.workflowId, run.validationRunId, 0, actor("real-exercise-reviewer"));
    reviews.approve(document.workflowId, run.validationRunId, 1, actor("real-exercise-approver"));
    await exports.export(document.workflowId, run.validationRunId, document.item.format);
    ordinaryExports += 1;
    await exports.export(document.workflowId, run.validationRunId, "canonical");
    canonicalExports += 1;
  }

  const usage = database.prepare(`
    SELECT count(*) AS records,
           coalesce(sum(input_tokens), 0) AS inputTokens,
           coalesce(sum(output_tokens), 0) AS outputTokens,
           coalesce(sum(cached_input_tokens), 0) AS cachedInputTokens,
           coalesce(sum(total_tokens), 0) AS totalTokens,
           coalesce(sum(amount_micros), 0) AS amountMicros
    FROM usage_cost_records WHERE workspace_id = ?
  `).get(workspaceId);
  if (providerCalls !== dryPlan.calls || usage.records !== dryPlan.calls || usage.amountMicros > config.limits.hardLimitMicros) {
    throw new Error("real Provider exercise usage invariant failed");
  }
  return Object.freeze({
    schemaVersion: "lectoria-real-provider-exercise-v1",
    providerId: config.providerId,
    modelId: config.modelId,
    documents: documents.length,
    calls: providerCalls,
    machineCandidates: generated.length,
    userEdits,
    validationCorrections,
    validationReruns,
    validations: documents.length,
    humanReviews: documents.length,
    approvals: documents.length,
    ordinaryExports,
    canonicalExports,
    warningsConfirmed,
    usage: Object.freeze(usage),
    hardLimitMicros: config.limits.hardLimitMicros,
  });
}
