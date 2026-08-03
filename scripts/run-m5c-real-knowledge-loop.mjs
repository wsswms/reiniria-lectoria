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
import { DEFAULT_FLOW_BUDGET, contentDigest } from "../src/m5c/contracts.mjs";
import { CandidateKnowledgeNeedService } from "../src/m5c/candidate-knowledge-need-service.mjs";
import { M5CQAService } from "../src/m5c/qa-service.mjs";
import { M5CModelQAExecutor } from "../src/m5c/model-qa-executor.mjs";
import { invokeM5CModelBroker } from "../src/m5c/model-broker-process.mjs";
import { finalizeProductRevision } from "../src/m5c/finalization.mjs";
import { ValidationService } from "../src/translation/validator.mjs";
import { WorkCopyService } from "../src/translation/work-copy-service.mjs";
import { M5CResearchBridgeService } from "../src/m5c/research-bridge-service.mjs";
import { ResearchBudgetService } from "../src/research/budget-service.mjs";
import { ResearchEvidenceService } from "../src/research/evidence-service.mjs";
import { WebSearchArtifactService } from "../src/research/web-search-artifact-service.mjs";
import { createRealBraveGatewayAdapter } from "../src/research/real-brave-evaluation.mjs";
import { workspace as applicationWorkspace } from "../tests/m3-4/helpers.mjs";
import { REAL_ARTICLES, readPrivateArticle } from "./m5c-real-article-batch.mjs";
import { RealArticleAuditSession } from "./m5c-real-article-audit.mjs";
import { KNOWLEDGE_LOOP_ARTICLES, BRAVE_COST_MICROS_USD_PER_CALL, MAX_RESEARCH_CALLS_PER_ARTICLE,
  MAX_RETRANSLATION_SEGMENTS_PER_ARTICLE, digest, knowledgeLoopLimits, selectOfficialSearchResult,
  summarizeKnowledgeNeeds } from "./m5c-real-knowledge-loop.mjs";
import { PRODUCTION_RESPONSE_BYTES_CEILING } from "../src/m5c/role-policy.mjs";

const USER = Object.freeze({ type: "user", id: "m5c-real-knowledge-loop-owner" });
const SYSTEM = Object.freeze({ type: "system", id: "m5c-real-knowledge-loop-control-plane" });
const MODEL_ID = "deepseek-v4-flash";
const PRICING_VERSION = "deepseek-v4-flash-2026-08-03-conservative-cny-v1";
const TRANSLATION_OUTPUT_TOKENS = 16_384;
const ROLE_OUTPUT_TOKENS = 65_536;
const FIXED = Object.freeze({
  "nikon-omoshiro-part1": Object.freeze({ digest: "sha256:3a94942c23690d11c7a61527e3778c61fc557cb6a1af2596d40d57ae33d6fc5d", segmentCount: 54 }),
  "nikon-omoshiro-part2": Object.freeze({ digest: "sha256:fb274eb8b2d77f63a15bb28128353de042a196589a535992721a6789336c7945", segmentCount: 62 }),
});
const estimate = (calls, inputTokens, outputTokens, costMicrosCny, costMicrosUsd, durationMs) =>
  ({ calls, inputTokens, outputTokens, costMicrosCny, costMicrosUsd, durationMs });
const progress = (documentId, phase, completed, total) => process.stderr.write(`${JSON.stringify({ type: "progress", documentId, phase,
  ...(completed === undefined ? {} : { completed, total }) })}\n`);

function articleBudget(segmentCount) {
  const zero = Object.freeze({ maxCalls: 0, maxInputTokens: 0, maxOutputTokens: 0, maxCostMicrosCny: 0, maxCostMicrosUsd: 0, maxDurationMs: 0 });
  return Object.freeze({ ...DEFAULT_FLOW_BUDGET, maxCalls: segmentCount + 22, maxInputTokens: 2_500_000,
    maxOutputTokens: ROLE_OUTPUT_TOKENS * 2 + (segmentCount + MAX_RETRANSLATION_SEGMENTS_PER_ARTICLE) * TRANSLATION_OUTPUT_TOKENS,
    maxCostMicrosCny: 50_000_000, maxCostMicrosUsd: 2_000_000, maxDurationMs: 20_000_000,
    maxResearchCycles: 2, maxQaCycles: 1, maxRetranslations: 1, maxUnknownOutcomes: 1,
    categories: Object.freeze({
      planner: Object.freeze({ maxCalls: 1, maxInputTokens: 150_000, maxOutputTokens: ROLE_OUTPUT_TOKENS,
        maxCostMicrosCny: 5_000_000, maxCostMicrosUsd: 0, maxDurationMs: 600_000 }),
      search: Object.freeze({ maxCalls: MAX_RESEARCH_CALLS_PER_ARTICLE, maxInputTokens: 0, maxOutputTokens: 0,
        maxCostMicrosCny: 0, maxCostMicrosUsd: 1_000_000, maxDurationMs: 120_000 }),
      fetch: zero, research: zero,
      translation: Object.freeze({ maxCalls: segmentCount, maxInputTokens: 1_500_000, maxOutputTokens: segmentCount * TRANSLATION_OUTPUT_TOKENS,
        maxCostMicrosCny: 15_000_000, maxCostMicrosUsd: 0, maxDurationMs: segmentCount * 180_000 }),
      qa: Object.freeze({ maxCalls: 1, maxInputTokens: 400_000, maxOutputTokens: ROLE_OUTPUT_TOKENS,
        maxCostMicrosCny: 10_000_000, maxCostMicrosUsd: 0, maxDurationMs: 900_000 }),
      retranslation: Object.freeze({ maxCalls: MAX_RETRANSLATION_SEGMENTS_PER_ARTICLE, maxInputTokens: 500_000,
        maxOutputTokens: MAX_RETRANSLATION_SEGMENTS_PER_ARTICLE * TRANSLATION_OUTPUT_TOKENS,
        maxCostMicrosCny: 10_000_000, maxCostMicrosUsd: 0, maxDurationMs: MAX_RETRANSLATION_SEGMENTS_PER_ARTICLE * 180_000 }),
    }) });
}

async function privateOutputDirectory(path) {
  if (typeof path !== "string" || path.length === 0) throw new Error("M5C_REAL_KNOWLEDGE_OUTPUT_DIR is required");
  await mkdir(path, { recursive: true, mode: 0o700 }); const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("output directory must be current-user 0700");
  return path;
}

async function save(root, name, value) {
  const path = join(root, name); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await chmod(path, 0o600);
}

function selectResearchNeed(needs, originType) {
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  return needs.filter((need) => need.originType === originType && need.decision === null)
    .sort((left, right) => rank[left.impact] - rank[right.impact])[0] ?? null;
}

function decideNeedBatch(service, needs, selected) {
  for (const need of needs.filter((item) => item.decision === null)) service.decide(need.needId,
    need.needId === selected?.needId ? "research" : "proceed-with-risk",
    need.needId === selected?.needId ? { reason: "authorized real-flow evidence check" } : { reason: "bounded test stop line; retained for QA" }, USER);
}

async function researchNeed({ fixture, plans, needs, need, article, braveKeyPath, ordinal }) {
  let promoted = needs.promoteResearchNeed(need.needId); let plan = plans.get(need.workflowId);
  plan = plans.submitPlan(need.workflowId, plan.planHead.version, SYSTEM); plans.decidePlan(need.workflowId, plan.planHead.version, "approved", USER);
  let request = needs.createResearchRequest(need.needId); const bridge = new M5CResearchBridgeService(fixture.database, fixture.workspaceId);
  request = bridge.submit(request.request.requestId, request.head.version, SYSTEM);
  request = bridge.decide(request.request.requestId, request.head.version, "approved", USER);
  const now = new Date(); const grantInput = { schemaVersion: "1.0", grantId: randomUUID(), requestId: request.request.requestId,
    requestRevisionId: request.head.requestRevisionId, providers: [{ capability: "search", providerId: "brave-search", fallbackOrder: 0,
      budget: { maxSearchCalls: 1, maxContentUrls: 0, maxModelTokens: 0, maxCostMicrosUsd: BRAVE_COST_MICROS_USD_PER_CALL } }],
    limits: { maxRounds: 1, maxSearchCalls: 1, maxResultsPerSearch: 10, maxContentUrls: 1, maxDurationSeconds: 300,
      maxRuns: 1, maxModelTokens: 0, maxCostMicrosUsd: BRAVE_COST_MICROS_USD_PER_CALL },
    allowedDomains: [article.expectedHost], allowedLanguages: ["ja"], approvedBy: USER, approvedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 300_000).toISOString() };
  const issued = bridge.issueGrant(request.request.requestId, grantInput, USER);
  const created = bridge.createRun(request.request.requestId, contentDigest({ needId: need.needId, ordinal }), SYSTEM);
  const started = bridge.startRun(request.request.requestId, created.run.runId, SYSTEM);
  const reservationId = `search:${article.id}:${ordinal}:${need.needId}`; const details = { runId: started.run.runId,
    providerId: "brave-search", round: 1, query: article.query, language: "ja", country: "JP", idempotencyKey: reservationId };
  const usage = estimate(1, 0, 0, 0, BRAVE_COST_MICROS_USD_PER_CALL, 60_000);
  const reserved = bridge.reserveOperation(request.request.requestId, issued.grant.grantId, "search", reservationId, usage, details);
  const adapter = createRealBraveGatewayAdapter({ credentialPath: braveKeyPath, costMicrosUsdPerCall: BRAVE_COST_MICROS_USD_PER_CALL,
    brokerOptions: { timeoutMs: 30_000 } });
  const startedAt = Date.now(); const response = await adapter.search({ query: article.query, count: 10, country: "JP", searchLanguage: "ja" });
  const actual = { ...usage, durationMs: Date.now() - startedAt }; const artifacts = new WebSearchArtifactService(fixture.database, fixture.workspaceId)
    .recordResearch(reserved.research.queryId, response);
  bridge.settleOperation(request.request.requestId, reservationId, actual, { responseDigest: response.responseDigest });
  const selected = selectOfficialSearchResult(artifacts.results, article.expectedHost); const evidence = new ResearchEvidenceService(fixture.database, fixture.workspaceId);
  const source = evidence.addSource(started.run.runId, reserved.research.queryId, { canonicalUrl: selected.url, tier: "S1",
    lineage: "search-snippet", artifactType: "search-result", artifactId: selected.resultId });
  const quote = `${selected.title}\n${selected.description}`; const citation = evidence.cite(source.sourceId, { quote, locator: { start: 0, end: quote.length } });
  const claim = evidence.claim(started.run.runId, { text: quote, citationIds: [citation.citationId], inference: false,
    disputed: false, insufficient: false, narrowOfficial: true });
  const totals = new ResearchBudgetService(fixture.database, fixture.workspaceId).totals(issued.grant.grantId);
  const report = evidence.report(started.run.runId, { questionAnswers: [{ question: need.question, answer: quote, status: "supported" }],
    claimIds: [claim.claimId], usage: totals });
  bridge.runs.transition(started.run.runId, "completed", { details: { reportId: report.reportId }, actor: SYSTEM });
  return Object.freeze({ needId: need.needId, planRevisionId: promoted.planBinding.planRevisionId, requestId: request.request.requestId,
    grantId: issued.grant.grantId, runId: started.run.runId, query: article.query, responseDigest: response.responseDigest,
    selectedUrl: selected.url, selectedResultDigest: selected.resultDigest, claimId: claim.claimId, supportLevel: claim.supportLevel,
    reportId: report.reportId, outcome: report.outcome, usage: totals });
}

function addProviderBudget(pricing, articleId, suffix, hardLimitMicros) {
  const policyVersion = `${articleId}:${suffix}:provider-budget`;
  pricing.addPolicy({ policyVersion, currency: "CNY", softLimitMicros: hardLimitMicros, hardLimitMicros, unknownPriceAction: "block" });
  return policyVersion;
}

async function executeTranslations({ fixture, workflowId, contexts, pricing, credential, audit, article, segmentIds, category, idempotencyKey }) {
  const policyVersion = addProviderBudget(pricing, article.id, idempotencyKey, category === "translation" ? 15_000_000 : 10_000_000);
  const queued = contexts.enqueueTranslation(workflowId, { segmentIds, providerId: "deepseek", modelId: MODEL_ID, policyVersion,
    idempotencyKey, maxAttempts: 1, batchSize: 1, budgetCategory: category,
    estimatedUsage: estimate(segmentIds.length, 500_000, segmentIds.length * TRANSLATION_OUTPUT_TOKENS, 10_000_000, 0, segmentIds.length * 180_000) });
  pricing.assignTask(queued.task.task.task_id, policyVersion);
  const executor = new TranslationExecutor(fixture.database, fixture.workspaceId, { budgets: pricing, pricingVersion: PRICING_VERSION,
    credentialRef: "external-file:deepseek/m5c-real-knowledge-loop", estimatedOutputTokens: TRANSLATION_OUTPUT_TOKENS,
    invokeProvider: (request, { credentialRef }) => audit.invoke(`${category}-${article.id}-${request.segments[0].segmentId}`,
      { articleId: article.id, role: category, thinking: "disabled", segmentId: request.segments[0].segmentId },
      (auditFd) => invokeBrokerProcess({ request, credentialRef, credentialFd: credential.fd, auditFd },
        { timeoutMs: 180_000, outputBytes: PRODUCTION_RESPONSE_BYTES_CEILING })) });
  const results = [];
  while (true) {
    const result = await executor.executeNext(); if (result.status === "idle") break;
    if (result.status !== "completed") throw Object.assign(new Error(`${category} did not complete`), { category: result.error?.category ?? result.status });
    results.push(result); progress(article.id, category, results.length, segmentIds.length);
  }
  if (results.length !== segmentIds.length) throw new Error(`${category} call count mismatch`); return results;
}

if (process.env.M5C_REAL_KNOWLEDGE_LOOP !== "execute") throw new Error("real knowledge loop requires M5C_REAL_KNOWLEDGE_LOOP=execute");

let credential; let braveCredential; let audit; let stage = "preflight"; let currentDocumentId = null; const documents = [];
try {
  const outputRoot = await privateOutputDirectory(process.env.M5C_REAL_KNOWLEDGE_OUTPUT_DIR); audit = await RealArticleAuditSession.create(outputRoot);
  credential = await openCredentialFile(process.env.DEEPSEEK_KEY_FILE); braveCredential = await openCredentialFile(process.env.BRAVE_KEY_FILE);
  await braveCredential.close(); braveCredential = null;
  for (const sourceArticle of REAL_ARTICLES) {
    const article = Object.freeze({ ...sourceArticle, ...KNOWLEDGE_LOOP_ARTICLES[sourceArticle.id] }); const fixed = FIXED[article.id];
    const source = await readPrivateArticle(process.env[article.env]); if (source.digest !== fixed.digest) throw new Error("real article digest changed");
    currentDocumentId = article.id; stage = "workspace"; const fixture = await applicationWorkspace(`lectoria-${article.id}-knowledge-real-`);
    try {
      const imported = await fixture.imports.import({ format: "text", content: source.content, title: article.id }); fixture.imports.confirm(imported.importId, USER);
      const segmentIds = fixture.database.prepare("SELECT segment_id AS segmentId FROM source_segment_versions WHERE workspace_id = ? AND source_revision_id = ? AND translatable = 1 ORDER BY ordinal")
        .all(fixture.workspaceId, imported.sourceRevisionId).map((row) => row.segmentId);
      if (segmentIds.length !== fixed.segmentCount) throw new Error("real article segmentation changed");
      const workflowId = randomUUID(); const plans = new FlowPlanService(fixture.database, fixture.workspaceId);
      plans.create({ workflowId, documentId: imported.documentId, sourceRevisionId: imported.sourceRevisionId,
        targetLanguage: article.targetLanguage, budget: articleBudget(segmentIds.length) }, USER);
      stage = "planner"; const planner = new M5CPlannerExecutor(fixture.database, fixture.workspaceId, { plans,
        invokePlanner: (request) => audit.invoke(`planner-${article.id}`, { articleId: article.id, role: "planner", thinking: "disabled" },
          (auditFd) => invokeM5CModelBroker({ credentialFd: credential.fd, auditFd,
            request: { role: "planner", modelId: MODEL_ID, request, maxOutputTokens: ROLE_OUTPUT_TOKENS, thinking: "disabled" } },
          { timeoutMs: 600_000, outputBytes: PRODUCTION_RESPONSE_BYTES_CEILING })) });
      const planned = await planner.execute(workflowId, { providerId: "deepseek", modelId: MODEL_ID, idempotencyKey: `${article.id}:planner`,
        estimatedUsage: estimate(1, 150_000, ROLE_OUTPUT_TOKENS, 5_000_000, 0, 600_000) });
      if (planned.status !== "model-assisted") throw Object.assign(new Error("Planner did not complete"), { category: planned.category ?? "provider" });
      let plan = plans.submitPlan(workflowId, planned.plan.planHead.version, SYSTEM); plans.decidePlan(workflowId, plan.planHead.version, "approved", USER);
      const needs = new CandidateKnowledgeNeedService(fixture.database, fixture.workspaceId); const plannerNeeds = needs.capturePlan(workflowId);
      const selectedPlannerNeed = selectResearchNeed(plannerNeeds, "plan-item"); if (!selectedPlannerNeed) throw new Error("Planner produced no actionable high-risk knowledge need");
      decideNeedBatch(needs, plannerNeeds, selectedPlannerNeed); stage = "planner-research";
      const plannerResearch = await researchNeed({ fixture, plans, needs, need: needs.get(selectedPlannerNeed.needId), article,
        braveKeyPath: process.env.BRAVE_KEY_FILE, ordinal: 1 });

      stage = "context"; const contexts = new TemporaryContextService(fixture.database, fixture.workspaceId); let context = contexts.assemble(workflowId,
        { researchClaimIds: [plannerResearch.claimId] }, SYSTEM); context = contexts.decide(workflowId, context.head.version, "approved", USER);
      const pricing = new PricingBudgetService(fixture.database, fixture.workspaceId); pricing.addPricing({ providerId: "deepseek", modelId: MODEL_ID,
        pricingVersion: PRICING_VERSION, currency: "CNY", inputMicrosPerMillion: 2_800_000, outputMicrosPerMillion: 5_600_000,
        cachedInputMicrosPerMillion: 56_000, source: "official-2026-08-03-usd-pricing-at-10-cny-per-usd-and-2x-peak-ceiling" });
      stage = "translation"; const translation = await executeTranslations({ fixture, workflowId, contexts, pricing, credential, audit, article,
        segmentIds, category: "translation", idempotencyKey: `${article.id}:translation` });
      const copies = new WorkCopyService(fixture.database, fixture.workspaceId);
      for (const segmentId of segmentIds) {
        const candidate = copies.listCandidates(workflowId, segmentId).filter((item) => item.sourceType === "machine").at(-1);
        copies.selectCandidate(workflowId, segmentId, candidate.candidateId, null, USER);
      }

      const allAfterTranslation = needs.list(workflowId); const selectedTranslationNeed = selectResearchNeed(allAfterTranslation, "translation-attempt");
      if (!selectedTranslationNeed) throw new Error("translation produced no knowledge need for the authorized loop");
      decideNeedBatch(needs, allAfterTranslation, selectedTranslationNeed); stage = "translation-research";
      const translationResearch = await researchNeed({ fixture, plans, needs, need: needs.get(selectedTranslationNeed.needId), article,
        braveKeyPath: process.env.BRAVE_KEY_FILE, ordinal: 2 });
      context = contexts.assemble(workflowId, { researchClaimIds: [plannerResearch.claimId, translationResearch.claimId] }, SYSTEM);
      context = contexts.decide(workflowId, context.head.version, "approved", USER);
      const affected = [...new Set(selectedTranslationNeed.relatedSegmentIds)].slice(0, MAX_RETRANSLATION_SEGMENTS_PER_ARTICLE);
      stage = "retranslation"; const retranslation = await executeTranslations({ fixture, workflowId, contexts, pricing, credential, audit, article,
        segmentIds: affected, category: "retranslation", idempotencyKey: `${article.id}:retranslation` });
      for (const segmentId of affected) {
        const candidate = copies.listCandidates(workflowId, segmentId).filter((item) => item.sourceType === "machine").at(-1);
        copies.selectCandidate(workflowId, segmentId, candidate.candidateId, copies.getHead(workflowId, segmentId).version, USER);
      }
      const finalNeeds = needs.list(workflowId); decideNeedBatch(needs, finalNeeds, null);

      stage = "validation"; const validationRun = new ValidationService(fixture.database, fixture.workspaceId, { workCopies: copies }).run(workflowId);
      const validation = Object.freeze({ validationRunId: validationRun.validationRunId, findings: Object.freeze(validationRun.findings.map(
        ({ severity, code, segmentId, details }) => Object.freeze({ severity, code, segmentId, details }))) });
      stage = "qa-enabled"; const qaService = new M5CQAService(fixture.database, fixture.workspaceId, { workCopies: copies });
      const qaExecutor = new M5CModelQAExecutor(fixture.database, fixture.workspaceId, { workCopies: copies, qa: qaService,
        invokeModelQa: (request) => audit.invoke(`qa-enabled-${article.id}`, { articleId: article.id, role: "qa", thinking: "enabled" },
          (auditFd) => invokeM5CModelBroker({ credentialFd: credential.fd, auditFd,
            request: { role: "qa", modelId: MODEL_ID, request, maxOutputTokens: ROLE_OUTPUT_TOKENS, thinking: "enabled" } },
          { timeoutMs: 900_000, outputBytes: PRODUCTION_RESPONSE_BYTES_CEILING })) });
      const qaResult = await qaExecutor.execute(workflowId, { providerId: "deepseek", modelId: MODEL_ID, qaMode: "enabled",
        idempotencyKey: `${article.id}:qa:enabled`, estimatedUsage: estimate(1, 400_000, ROLE_OUTPUT_TOKENS, 10_000_000, 0, 900_000) });
      const bundle = copies.getBundle(workflowId); const budget = new TranslationFlowBudgetService(fixture.database, fixture.workspaceId).get(workflowId);
      const finalization = finalizeProductRevision({ workflowId, qaMode: "enabled", qaRun: qaResult.run, workingCopyDigest: bundle.digest,
        validation, flowBudgetUsage: budget.totals, qaUsage: qaResult.settlement.usage });
      const knowledgeNeedSummary = summarizeKnowledgeNeeds(needs.list(workflowId)); if (knowledgeNeedSummary.unresolved !== 0) throw new Error("knowledge needs remain unresolved");
      const result = Object.freeze({ schemaVersion: "m5c-real-knowledge-loop-result-v1", status: finalization.status, articleId: article.id,
        source: { digest: source.digest, bytes: source.bytes, segmentCount: segmentIds.length }, workflowId, planner: { status: planned.status,
          itemCount: planned.plan.plan.items.length }, knowledgeNeeds: knowledgeNeedSummary, research: [plannerResearch, translationResearch],
        context: { revision: context.context.revision, itemCount: context.context.items.length, digest: context.context.contextDigest },
        translation: { initialCalls: translation.length, retranslationCalls: retranslation.length, affectedSegmentIds: affected },
        target: { workingCopyDigest: bundle.digest, segmentCount: bundle.segments.length }, validation,
        qa: { mode: "enabled", thinking: "enabled", qaRunId: qaResult.run.qaRunId, targetRevisionId: qaResult.run.targetRevisionId,
          findings: qaResult.run.findings, usage: qaResult.settlement.usage }, finalization, flowBudgetUsage: budget.totals,
        automaticRetries: 0, approvalPerformed: false, exportPerformed: false });
      await save(outputRoot, `${article.id}-knowledge-loop.json`, result); documents.push(result); progress(article.id, "completed");
    } finally { await fixture.close(); }
  }
  const auditSummary = await audit.summary(); const summary = { schemaVersion: "m5c-real-knowledge-loop-batch-v1",
    status: "completed-awaiting-user-disposition", documents: documents.map((item) => ({ articleId: item.articleId, status: item.status,
      knowledgeNeeds: item.knowledgeNeeds, research: item.research.map(({ outcome, supportLevel, usage }) => ({ outcome, supportLevel, usage })),
      translation: item.translation, validationFindings: item.validation.findings.length, qaFindings: item.qa.findings.length, qaUsage: item.qa.usage })),
    limits: knowledgeLoopLimits(), audit: { calls: auditSummary.calls, manifestDigest: auditSummary.manifestDigest },
    auditSummaryDigest: digest(auditSummary.entries), rawLlmInputsOutputsRetained: true, qaModesExecuted: ["enabled"], automaticRetries: 0 };
  await save(outputRoot, "knowledge-loop-summary.json", summary); process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch (error) {
  const allowed = new Set(["auth", "budget", "canceled", "malformed-response", "policy", "provider", "rate-limit", "timeout", "unknown-outcome"]);
  const auditSummary = await audit?.summary().catch(() => null); process.stderr.write(`${JSON.stringify({ status: "failed", stage,
    documentId: currentDocumentId, completedDocumentIds: documents.map((item) => item.articleId), category: allowed.has(error?.category) ? error.category : "evaluation",
    audit: auditSummary ? { calls: auditSummary.calls, manifestDigest: auditSummary.manifestDigest } : null,
    code: typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(error.code) ? error.code : null })}\n`); process.exitCode = 1;
} finally { await braveCredential?.close(); await credential?.close(); }
