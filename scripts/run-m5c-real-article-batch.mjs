import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { invokeBrokerProcess } from "../src/provider/broker-process.mjs";
import { PricingBudgetService } from "../src/provider/cost-budget.mjs";
import { TranslationExecutor } from "../src/provider/translation-executor.mjs";
import { FlowPlanService } from "../src/m5c/flow-plan-service.mjs";
import { M5CPlannerExecutor } from "../src/m5c/planner-executor.mjs";
import { TemporaryContextService } from "../src/m5c/temporary-context-service.mjs";
import { TranslationFlowBudgetService } from "../src/m5c/flow-budget-service.mjs";
import { DEFAULT_FLOW_BUDGET } from "../src/m5c/contracts.mjs";
import { M5CQAService } from "../src/m5c/qa-service.mjs";
import { M5CModelQAExecutor } from "../src/m5c/model-qa-executor.mjs";
import { invokeM5CModelBroker } from "../src/m5c/model-broker-process.mjs";
import { ValidationService } from "../src/translation/validator.mjs";
import { WorkCopyService } from "../src/translation/work-copy-service.mjs";
import { workspace as applicationWorkspace } from "../tests/m3-4/helpers.mjs";
import { REAL_ARTICLES, batchLimits, pairedQaSummary, readPrivateArticle, validatePart2ContinuationManifest } from "./m5c-real-article-batch.mjs";
import { RealArticleAuditSession } from "./m5c-real-article-audit.mjs";
import { REAL_ARTICLE_EVALUATION_SCOPE, REAL_ARTICLE_MAX_OUTPUT_TOKENS, REAL_ARTICLE_MAX_RESPONSE_BYTES } from "../src/provider/llm-call-audit.mjs";
import { createQaEvaluationReport, finalizeProductRevision } from "../src/m5c/finalization.mjs";

const USER = Object.freeze({ type: "user", id: "m5c-real-article-batch-owner" });
const SYSTEM = Object.freeze({ type: "system", id: "m5c-real-article-batch-control-plane" });
const MODEL_ID = "deepseek-v4-flash";
const PRICING_VERSION = "deepseek-v4-flash-2026-08-03-conservative-cny-v1";
const MODES = Object.freeze(["disabled", "enabled"]);
const TRANSLATION_OUTPUT_TOKENS = 16_384;
const PART1_MANIFEST_DIGEST = "sha256:78bd16f63851ef12d94bc563e8942c9d9368db474c50a204ce9ebd5b4a221593";
const FIXED = Object.freeze({
  "nikon-omoshiro-part1": Object.freeze({ digest: "sha256:3a94942c23690d11c7a61527e3778c61fc557cb6a1af2596d40d57ae33d6fc5d", segmentCount: 54 }),
  "nikon-omoshiro-part2": Object.freeze({ digest: "sha256:fb274eb8b2d77f63a15bb28128353de042a196589a535992721a6789336c7945", segmentCount: 62 }),
});

const estimate = (calls, inputTokens, outputTokens, costMicrosCny, durationMs) =>
  ({ calls, inputTokens, outputTokens, costMicrosCny, costMicrosUsd: 0, durationMs });
const progress = (documentId, phase, completed, total) => process.stderr.write(`${JSON.stringify({ type: "progress", documentId, phase,
  ...(completed === undefined ? {} : { completed, total }) })}\n`);

function articleBudget(segmentCount) {
  const zero = Object.freeze({ maxCalls: 0, maxInputTokens: 0, maxOutputTokens: 0, maxCostMicrosCny: 0, maxCostMicrosUsd: 0, maxDurationMs: 0 });
  return Object.freeze({ ...DEFAULT_FLOW_BUDGET, maxCalls: segmentCount + 3, maxInputTokens: 2_000_000,
    maxOutputTokens: REAL_ARTICLE_MAX_OUTPUT_TOKENS * 3 + segmentCount * TRANSLATION_OUTPUT_TOKENS,
    maxCostMicrosCny: 15_000_000, maxCostMicrosUsd: 0,
    maxDurationMs: 14_000_000, maxResearchCycles: 1, maxQaCycles: 2, maxRetranslations: 1, maxUnknownOutcomes: 1,
    categories: Object.freeze({
      planner: Object.freeze({ maxCalls: 1, maxInputTokens: 100_000, maxOutputTokens: REAL_ARTICLE_MAX_OUTPUT_TOKENS,
        maxCostMicrosCny: 2_500_000, maxCostMicrosUsd: 0, maxDurationMs: 600_000 }),
      search: zero, fetch: zero, research: zero,
      translation: Object.freeze({ maxCalls: segmentCount, maxInputTokens: 1_500_000, maxOutputTokens: segmentCount * TRANSLATION_OUTPUT_TOKENS,
        maxCostMicrosCny: 7_000_000, maxCostMicrosUsd: 0, maxDurationMs: segmentCount * 180_000 }),
      qa: Object.freeze({ maxCalls: 2, maxInputTokens: 400_000, maxOutputTokens: REAL_ARTICLE_MAX_OUTPUT_TOKENS * 2,
        maxCostMicrosCny: 5_500_000, maxCostMicrosUsd: 0, maxDurationMs: 1_200_000 }),
      retranslation: zero,
    }) });
}

async function privateOutputDirectory(path) {
  if (typeof path !== "string" || path.length === 0) throw new Error("M5C_REAL_ARTICLE_OUTPUT_DIR is required");
  await mkdir(path, { recursive: true, mode: 0o700 }); const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("real article output directory must be current-user 0700");
  }
  return path;
}

async function saveArtifact(root, id, value) {
  const path = join(root, `${id}.json`); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await chmod(path, 0o600);
}

function artifactDocument({ article, source, bundle, phase, plannerMode, contextItemCount, translationCalls, validation = null, qa = [] }) {
  return Object.freeze({ schemaVersion: "m5c-real-article-result-v1", status: phase === "qa-completed" ? "completed-awaiting-user-disposition" : "checkpoint",
    phase, dataClass: "user-provided-public-article", id: article.id, direction: `${article.sourceLanguage}->${article.targetLanguage}`,
    source: Object.freeze({ bytes: source.bytes, digest: source.digest, segmentCount: bundle.segments.length }), plannerMode, contextItemCount,
    targetWorkingCopyDigest: bundle.digest, segments: Object.freeze(bundle.segments.map((segment, ordinal) => Object.freeze({ ordinal,
      segmentId: segment.segmentId, sourceText: segment.sourceText, targetText: segment.text, targetDigest: segment.textDigest }))),
    translationCalls, validation, qa: Object.freeze(qa), rawResponsesRetained: true, reasoningRetained: true,
    automaticRetries: 0, approvalPerformed: false, riskAcceptancePerformed: false, exportPerformed: false });
}

if (process.env.M5C_REAL_ARTICLE_BATCH !== "execute") throw new Error("real article batch requires M5C_REAL_ARTICLE_BATCH=execute");

let credential; let audit; let stage = "preflight"; let currentDocumentId = null; const completed = [];
try {
  const outputRoot = await privateOutputDirectory(process.env.M5C_REAL_ARTICLE_OUTPUT_DIR);
  audit = await RealArticleAuditSession.create(outputRoot);
  credential = await openCredentialFile(process.env.DEEPSEEK_KEY_FILE);
  const continuationMode = process.env.M5C_REAL_ARTICLE_CONTINUATION;
  if (continuationMode !== undefined && continuationMode !== "part2-after-audited-part1-v1") throw new Error("real article continuation mode is invalid");
  const prior = continuationMode ? validatePart2ContinuationManifest(
    (await readPrivateArticle(process.env.M5C_REAL_ARTICLE_PRIOR_MANIFEST)).content, PART1_MANIFEST_DIGEST) : null;
  const sources = [];
  for (const article of REAL_ARTICLES) {
    const source = await readPrivateArticle(process.env[article.env]); const fixed = FIXED[article.id];
    if (source.digest !== fixed.digest) throw new Error("real article digest changed after preflight"); sources.push({ article, source, fixed });
  }
  const maximums = batchLimits(sources.map(({ fixed }) => fixed));
  const selectedSources = continuationMode ? sources.filter(({ article }) => article.id === "nikon-omoshiro-part2") : sources;
  for (const { article, source, fixed } of selectedSources) {
    currentDocumentId = article.id; stage = "workspace"; const fixture = await applicationWorkspace(`lectoria-${article.id}-real-`);
    try {
      progress(article.id, "started");
      const imported = await fixture.imports.import({ format: "text", content: source.content, title: article.id }); fixture.imports.confirm(imported.importId, USER);
      const actualSegments = fixture.database.prepare("SELECT count(*) AS count FROM source_segment_versions WHERE workspace_id = ? AND source_revision_id = ? AND translatable = 1")
        .get(fixture.workspaceId, imported.sourceRevisionId).count;
      if (actualSegments !== fixed.segmentCount) throw new Error("real article segmentation changed after preflight");
      const workflowId = randomUUID(); const plans = new FlowPlanService(fixture.database, fixture.workspaceId);
      let flow = plans.create({ workflowId, documentId: imported.documentId, sourceRevisionId: imported.sourceRevisionId,
        targetLanguage: article.targetLanguage, budget: articleBudget(fixed.segmentCount) }, USER);

      stage = "planner"; const planner = new M5CPlannerExecutor(fixture.database, fixture.workspaceId, { plans,
        invokePlanner: (request) => audit.invoke(`planner-${article.id}`, { articleId: article.id, role: "planner", thinking: "disabled" },
          (auditFd) => invokeM5CModelBroker({ credentialFd: credential.fd, auditFd,
            request: { role: "planner", modelId: MODEL_ID, request, maxOutputTokens: REAL_ARTICLE_MAX_OUTPUT_TOKENS,
              thinking: "disabled", evaluationScope: REAL_ARTICLE_EVALUATION_SCOPE } },
          { timeoutMs: 600_000, outputBytes: REAL_ARTICLE_MAX_RESPONSE_BYTES })) });
      const planned = await planner.execute(workflowId, { providerId: "deepseek", modelId: MODEL_ID, idempotencyKey: `${article.id}:planner`,
        estimatedUsage: estimate(1, 100_000, REAL_ARTICLE_MAX_OUTPUT_TOKENS, 2_500_000, 600_000) });
      if (planned.status !== "model-assisted") throw Object.assign(new Error("real article Planner did not complete"), { category: planned.category ?? "provider" });
      progress(article.id, "planner-completed", 1, 1);
      flow = plans.submitPlan(workflowId, planned.plan.planHead.version, SYSTEM); flow = plans.decidePlan(workflowId, flow.planHead.version, "approved", USER);

      stage = "context"; const contexts = new TemporaryContextService(fixture.database, fixture.workspaceId); let context = contexts.assemble(workflowId, {}, SYSTEM);
      context = contexts.decide(workflowId, context.head.version, "approved", USER);
      const queued = contexts.enqueueTranslation(workflowId, { providerId: "deepseek", modelId: MODEL_ID,
        policyVersion: `${article.id}:provider-budget`, idempotencyKey: `${article.id}:translation`, maxAttempts: 1, batchSize: 1,
        estimatedUsage: estimate(fixed.segmentCount, 1_500_000, fixed.segmentCount * TRANSLATION_OUTPUT_TOKENS,
          7_000_000, fixed.segmentCount * 180_000) });
      const pricing = new PricingBudgetService(fixture.database, fixture.workspaceId);
      pricing.addPricing({ providerId: "deepseek", modelId: MODEL_ID, pricingVersion: PRICING_VERSION, currency: "CNY",
        inputMicrosPerMillion: 2_800_000, outputMicrosPerMillion: 5_600_000, cachedInputMicrosPerMillion: 56_000,
        source: "official-2026-08-03-usd-pricing-at-10-cny-per-usd-and-2x-peak-ceiling" });
      pricing.addPolicy({ policyVersion: `${article.id}:provider-budget`, currency: "CNY", softLimitMicros: 7_000_000,
        hardLimitMicros: 7_000_000, unknownPriceAction: "block" }); pricing.assignTask(queued.task.task.task_id, `${article.id}:provider-budget`);

      stage = "translation"; const executor = new TranslationExecutor(fixture.database, fixture.workspaceId, { budgets: pricing,
        pricingVersion: PRICING_VERSION, credentialRef: "external-file:deepseek/m5c-real-articles", estimatedOutputTokens: TRANSLATION_OUTPUT_TOKENS,
        invokeProvider: (request, { credentialRef }) => audit.invoke(`translation-${article.id}-${request.segments[0].segmentId}`,
          { articleId: article.id, role: "translation", thinking: "disabled", segmentId: request.segments[0].segmentId },
          (auditFd) => invokeBrokerProcess({ request, credentialRef, credentialFd: credential.fd, auditFd,
            evaluationScope: REAL_ARTICLE_EVALUATION_SCOPE }, { timeoutMs: 180_000, outputBytes: REAL_ARTICLE_MAX_RESPONSE_BYTES })) });
      const results = [];
      while (true) {
        const result = await executor.executeNext(); if (result.status === "idle") break;
        if (result.status !== "completed") throw Object.assign(new Error("real article translation did not complete"), { category: result.error?.category ?? result.status });
        results.push(result); if (results.length === 1 || results.length % 10 === 0 || results.length === fixed.segmentCount) {
          progress(article.id, "translation", results.length, fixed.segmentCount);
        }
      }
      if (results.length !== fixed.segmentCount) throw new Error("real article translation call count mismatch");
      const copies = new WorkCopyService(fixture.database, fixture.workspaceId);
      for (const segment of copies.getBundle(workflowId).segments) {
        const candidate = copies.listCandidates(workflowId, segment.segmentId).find((item) => item.sourceType === "machine");
        copies.selectCandidate(workflowId, segment.segmentId, candidate.candidateId, null, USER);
      }
      let bundle = copies.getBundle(workflowId); const contextItemCount = context.context.items.length;
      await saveArtifact(outputRoot, article.id, artifactDocument({ article, source, bundle, phase: "translated", plannerMode: planned.status,
        contextItemCount, translationCalls: results.length }));

      stage = "validation"; const validationService = new ValidationService(fixture.database, fixture.workspaceId, { workCopies: copies });
      const validationRun = validationService.run(workflowId); const validation = Object.freeze({ validationRunId: validationRun.validationRunId,
        findings: Object.freeze(validationRun.findings.map(({ severity, code, segmentId, details }) => Object.freeze({ severity, code, segmentId, details }))) });
      progress(article.id, "validation-completed", validation.findings.length, validation.findings.length);

      stage = "paired-qa"; const qaService = new M5CQAService(fixture.database, fixture.workspaceId, { workCopies: copies }); const qa = [];
      for (const mode of MODES) {
        const qaExecutor = new M5CModelQAExecutor(fixture.database, fixture.workspaceId, { workCopies: copies, qa: qaService,
          invokeModelQa: (request) => audit.invoke(`qa-${mode}-${article.id}`, { articleId: article.id, role: "qa", thinking: mode },
            (auditFd) => invokeM5CModelBroker({ credentialFd: credential.fd, auditFd,
              request: { role: "qa", modelId: MODEL_ID, request, maxOutputTokens: REAL_ARTICLE_MAX_OUTPUT_TOKENS,
                thinking: mode, evaluationScope: REAL_ARTICLE_EVALUATION_SCOPE } },
            { timeoutMs: 600_000, outputBytes: REAL_ARTICLE_MAX_RESPONSE_BYTES })) });
        const result = await qaExecutor.execute(workflowId, { providerId: "deepseek", modelId: MODEL_ID, qaMode: mode,
          idempotencyKey: `${article.id}:qa:${mode}`, estimatedUsage: estimate(1, 200_000, REAL_ARTICLE_MAX_OUTPUT_TOKENS, 2_750_000, 600_000) });
        qa.push(pairedQaSummary(mode, result.run, result.settlement)); bundle = copies.getBundle(workflowId);
        progress(article.id, `qa-${mode}-completed`, qa.at(-1).findings.length, qa.at(-1).findings.length);
        await saveArtifact(outputRoot, article.id, artifactDocument({ article, source, bundle, phase: `qa-${mode}`, plannerMode: planned.status,
          contextItemCount, translationCalls: results.length, validation, qa }));
      }
      if (qa[0].targetRevisionId !== qa[1].targetRevisionId) throw new Error("paired QA did not bind the same target revision");
      const budget = new TranslationFlowBudgetService(fixture.database, fixture.workspaceId).get(workflowId);
      const evaluationReport = createQaEvaluationReport(qa); const enabled = qa.find((item) => item.mode === "enabled");
      const finalization = finalizeProductRevision({ workflowId, qaMode: "enabled", qaRun: qaService.get(enabled.qaRunId),
        workingCopyDigest: bundle.digest, validation, flowBudgetUsage: budget.totals, qaUsage: enabled.usage });
      const finalArtifact = artifactDocument({ article, source, bundle, phase: "qa-completed", plannerMode: planned.status,
        contextItemCount, translationCalls: results.length, validation, qa: [enabled] });
      await saveArtifact(outputRoot, article.id, Object.freeze({ ...finalArtifact, productFinalization: finalization, evaluationReport }));
      completed.push(Object.freeze({ id: article.id, sourceDigest: source.digest, segmentCount: fixed.segmentCount, targetWorkingCopyDigest: bundle.digest,
        targetRevisionId: qa[0].targetRevisionId, validationFindings: validation.findings.length,
        qa: qa.map((item) => ({ mode: item.mode, findings: item.findings.length, usage: item.usage })), flowBudgetUsage: budget.totals }));
      progress(article.id, "completed");
    } finally { await fixture.close(); }
  }
  const auditSummary = await audit.summary();
  process.stdout.write(`${JSON.stringify({ schemaVersion: "m5c-real-article-batch-result-v1", status: "completed-awaiting-user-disposition",
    documents: completed, maximums, audit: { calls: auditSummary.calls, manifestDigest: auditSummary.manifestDigest },
    continuation: prior ? { mode: continuationMode, prior, repeatedProviderCalls: 0,
      cumulativeNewCalls: prior.calls + auditSummary.calls } : null,
    rawResponsesRetained: true, reasoningRetained: true, approvalPerformed: false,
    riskAcceptancePerformed: false, exportPerformed: false })}\n`);
} catch (error) {
  const allowed = new Set(["auth", "budget", "canceled", "malformed-response", "policy", "provider", "rate-limit", "timeout", "unknown-outcome"]);
  const auditSummary = await audit?.summary().catch(() => null);
  process.stderr.write(`${JSON.stringify({ status: "failed", stage, documentId: currentDocumentId,
    completedDocumentIds: completed.map((item) => item.id), category: allowed.has(error?.category) ? error.category : "evaluation",
    audit: auditSummary ? { calls: auditSummary.calls, manifestDigest: auditSummary.manifestDigest } : null,
    code: typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(error.code) ? error.code : null,
    providerCode: typeof error?.providerCode === "string" && /^[a-z0-9_-]{1,64}$/u.test(error.providerCode) ? error.providerCode : null })}\n`);
  process.exitCode = 1;
} finally { await credential?.close(); }
