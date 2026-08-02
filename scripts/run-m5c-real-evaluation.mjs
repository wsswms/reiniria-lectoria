import { createHash, randomUUID } from "node:crypto";
import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { invokeBrokerProcess } from "../src/provider/broker-process.mjs";
import { PricingBudgetService } from "../src/provider/cost-budget.mjs";
import { TranslationExecutor } from "../src/provider/translation-executor.mjs";
import { ExportService } from "../src/export/export-service.mjs";
import { FlowPlanService } from "../src/m5c/flow-plan-service.mjs";
import { M5CPlannerExecutor } from "../src/m5c/planner-executor.mjs";
import { TemporaryContextService } from "../src/m5c/temporary-context-service.mjs";
import { M5CQAService } from "../src/m5c/qa-service.mjs";
import { M5CModelQAExecutor } from "../src/m5c/model-qa-executor.mjs";
import { invokeM5CModelBroker } from "../src/m5c/model-broker-process.mjs";
import { M5CResearchBridgeService } from "../src/m5c/research-bridge-service.mjs";
import { M5CRemediationService } from "../src/m5c/remediation-service.mjs";
import { invokeResearchWebBroker } from "../src/research/web-broker-process.mjs";
import { ReviewService } from "../src/translation/review-service.mjs";
import { ValidationService } from "../src/translation/validator.mjs";
import { WorkCopyService } from "../src/translation/work-copy-service.mjs";
import { workspace as applicationWorkspace } from "../tests/m3-4/helpers.mjs";
import { m5cRealEvaluationCorpus } from "../tests/fixtures/m5c-5/real-evaluation-corpus.mjs";

const USER = Object.freeze({ type: "user", id: "m5c-real-evaluation-owner" });
const SYSTEM = Object.freeze({ type: "system", id: "m5c-real-evaluation-control-plane" });
const MODEL_ID = "deepseek-v4-flash";
const PRICING_VERSION = "deepseek-v4-flash-2026-08-03-conservative-cny-v1";
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const estimate = (calls, inputTokens, outputTokens, costMicrosCny, durationMs) => ({ calls, inputTokens, outputTokens,
  costMicrosCny, costMicrosUsd: 0, durationMs });

if (process.env.M5C_REAL_EVALUATION !== "1") throw new Error("real M5C evaluation requires M5C_REAL_EVALUATION=1");

let deepseek; let brave; let stage = "credential-preflight"; let documentId = null;
try {
  deepseek = await openCredentialFile("/run/secrets/deepseek");
  brave = await openCredentialFile("/run/secrets/brave");
  const summaries = []; let totalDeepSeekCalls = 0; let totalBraveCalls = 0; let totalCostMicrosCny = 0; let totalCostMicrosUsd = 0;
  for (const [documentIndex, document] of m5cRealEvaluationCorpus.entries()) {
    documentId = document.id; stage = "workspace";
    const fixture = await applicationWorkspace(`lectoria-m5c-real-${document.id}-`);
    try {
      const imported = await fixture.imports.import({ format: "text", content: document.content, title: document.title });
      fixture.imports.confirm(imported.importId, USER); const workflowId = randomUUID();
      const plans = new FlowPlanService(fixture.database, fixture.workspaceId); let flow = plans.create({ workflowId,
        documentId: imported.documentId, sourceRevisionId: imported.sourceRevisionId, targetLanguage: document.targetLanguage }, USER);
      stage = "planner"; const plannerStarted = Date.now(); const planner = new M5CPlannerExecutor(fixture.database, fixture.workspaceId, { plans,
        invokePlanner: (request) => invokeM5CModelBroker({ credentialFd: deepseek.fd,
          request: { role: "planner", modelId: MODEL_ID, request, maxOutputTokens: 2_048 } }, { timeoutMs: 60_000 }) });
      const planned = await planner.execute(workflowId, { providerId: "deepseek", modelId: MODEL_ID,
        idempotencyKey: `${document.id}:planner`, estimatedUsage: estimate(1, 10_000, 2_048, 50_000, 60_000) });
      if (planned.status !== "model-assisted") throw Object.assign(new Error("planner did not complete"), { category: planned.category ?? "provider" });
      totalDeepSeekCalls += 1; flow = plans.submitPlan(workflowId, planned.plan.planHead.version, SYSTEM);
      flow = plans.decidePlan(workflowId, flow.planHead.version, "approved", USER);

      let research = null;
      if (documentIndex === 0) {
        stage = "research";
        const item = flow.plan.items.find((candidate) => ["uncovered", "partially-covered", "conflicted", "stale"].includes(candidate.coverage));
        if (!item) throw new Error("real research requires one researchable Plan item");
        const bridge = new M5CResearchBridgeService(fixture.database, fixture.workspaceId); let request = bridge.propose(workflowId,
          { originType: "plan-item", originId: item.itemId, questions: ["IANA example domains documentation"], gapKinds: ["background-fact"] }, SYSTEM);
        request = bridge.submit(request.request.requestId, request.head.version, SYSTEM);
        request = bridge.decide(request.request.requestId, request.head.version, "approved", USER);
        const now = new Date(); const grantInput = { schemaVersion: "1.0", grantId: randomUUID(), requestId: request.request.requestId,
          requestRevisionId: request.head.requestRevisionId, providers: [{ capability: "search", providerId: "brave-search", fallbackOrder: 0,
            budget: { maxSearchCalls: 1, maxContentUrls: 0, maxModelTokens: 0, maxCostMicrosUsd: 5_000 } }],
          limits: { maxRounds: 1, maxSearchCalls: 1, maxResultsPerSearch: 3, maxContentUrls: 1, maxDurationSeconds: 60,
            maxRuns: 1, maxModelTokens: 0, maxCostMicrosUsd: 5_000 }, allowedDomains: ["iana.org"], allowedLanguages: ["en", "ja", "zh-CN"],
          approvedBy: USER, approvedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() };
        const issued = bridge.issueGrant(request.request.requestId, grantInput, USER); const reservationId = `${document.id}:search:1`;
        bridge.reserveOperation(request.request.requestId, issued.grant.grant.grantId, "search", reservationId,
          { calls: 1, inputTokens: 0, outputTokens: 0, costMicrosCny: 0, costMicrosUsd: 5_000, durationMs: 30_000 });
        const started = Date.now();
        try {
          const response = await invokeResearchWebBroker({ providerId: "brave-search", capability: "search", credentialFd: brave.fd,
            credentialRef: "external-file:brave-search/m5r", request: { query: "IANA example domains documentation", count: 3, country: "US", searchLanguage: "en" } },
          { timeoutMs: 30_000 });
          bridge.settleOperation(request.request.requestId, reservationId,
            { calls: 1, inputTokens: 0, outputTokens: 0, costMicrosCny: 0, costMicrosUsd: 5_000, durationMs: Date.now() - started },
            { responseDigest: response.responseDigest });
          research = { resultCount: response.results.length, responseDigest: response.responseDigest, latencyMs: Date.now() - started };
          totalBraveCalls += 1; totalCostMicrosUsd += 5_000;
        } catch (error) { bridge.unknownOperation(request.request.requestId, reservationId, { category: error?.category ?? "provider" }); throw error; }
      }

      stage = "context"; const contexts = new TemporaryContextService(fixture.database, fixture.workspaceId); let context = contexts.assemble(workflowId, {}, SYSTEM);
      context = contexts.decide(workflowId, context.head.version, "approved", USER);
      const queued = contexts.enqueueTranslation(workflowId, { providerId: "deepseek", modelId: MODEL_ID,
        policyVersion: `${document.id}:provider-budget`, idempotencyKey: `${document.id}:translation`, estimatedUsage: estimate(8, 80_000, 8_192, 5_000_000, 240_000) });
      const pricing = new PricingBudgetService(fixture.database, fixture.workspaceId);
      pricing.addPricing({ providerId: "deepseek", modelId: MODEL_ID, pricingVersion: PRICING_VERSION, currency: "CNY",
        inputMicrosPerMillion: 2_800_000, outputMicrosPerMillion: 5_600_000, cachedInputMicrosPerMillion: 56_000,
        source: "official-2026-08-03-usd-pricing-at-10-cny-per-usd-and-2x-peak-ceiling" });
      pricing.addPolicy({ policyVersion: `${document.id}:provider-budget`, currency: "CNY", softLimitMicros: 25_000_000,
        hardLimitMicros: 25_000_000, unknownPriceAction: "block" }); pricing.assignTask(queued.task.task.task_id, `${document.id}:provider-budget`);
      stage = "translation"; const executor = new TranslationExecutor(fixture.database, fixture.workspaceId, { budgets: pricing, pricingVersion: PRICING_VERSION,
        credentialRef: "external-file:deepseek/m5c-translation", estimatedOutputTokens: 1_024,
        invokeProvider: (request, { credentialRef }) => invokeBrokerProcess({ request, credentialRef, credentialFd: deepseek.fd }, { timeoutMs: 60_000 }) });
      const translationResults = [];
      while (true) { const result = await executor.executeNext(); if (result.status === "idle") break;
        if (result.status !== "completed") throw Object.assign(new Error("translation failed"), { category: result.error?.category ?? result.status });
        translationResults.push(result); totalDeepSeekCalls += 1; totalCostMicrosCny += result.usage.amountMicros; }
      const copies = new WorkCopyService(fixture.database, fixture.workspaceId);
      for (const segment of copies.getBundle(workflowId).segments) {
        const candidate = copies.listCandidates(workflowId, segment.segmentId).find((entry) => entry.sourceType === "machine");
        copies.selectCandidate(workflowId, segment.segmentId, candidate.candidateId, null, USER);
      }

      const qaService = new M5CQAService(fixture.database, fixture.workspaceId, { workCopies: copies });
      const runModelQa = async (idempotencyKey) => {
        const executorQa = new M5CModelQAExecutor(fixture.database, fixture.workspaceId, { workCopies: copies, qa: qaService,
          invokeModelQa: (request) => invokeM5CModelBroker({ credentialFd: deepseek.fd,
            request: { role: "qa", modelId: MODEL_ID, request, maxOutputTokens: 2_048 } }, { timeoutMs: 60_000 }) });
        const result = await executorQa.execute(workflowId, { providerId: "deepseek", modelId: MODEL_ID, idempotencyKey,
          estimatedUsage: estimate(1, 20_000, 2_048, 100_000, 60_000) });
        totalDeepSeekCalls += 1; totalCostMicrosCny += result.settlement.usage.costMicrosCny; return result.run;
      };

      stage = "qa"; let qaRun;
      if (document.id === "software-en-zh") {
        const segment = copies.getBundle(workflowId).segments[0]; copies.edit(workflowId, segment.segmentId, segment.version, "该服务会删除缓存文件。", USER);
        qaRun = await runModelQa(`${document.id}:qa-before-remediation`);
        const finding = qaRun.findings.find((entry) => entry.code === "negation-mismatch"); if (!finding) throw new Error("remediation probe was not detected");
        qaRun = qaService.decideFinding(qaRun.qaRunId, finding.findingId, "retranslate", USER);
        stage = "remediation"; const remediation = new M5CRemediationService(fixture.database, fixture.workspaceId, { contexts });
        const retried = remediation.retranslate(qaRun.qaRunId, [finding.findingId], { providerId: "deepseek", modelId: MODEL_ID,
          policyVersion: `${document.id}:provider-budget`, idempotencyKey: `${document.id}:retranslation`, estimatedUsage: estimate(1, 10_000, 1_024, 1_000_000, 60_000) }, USER);
        pricing.assignTask(retried.task.task.task_id, `${document.id}:provider-budget`);
        const retriedResult = await executor.executeNext(); if (retriedResult.status !== "completed") throw new Error("retranslation failed");
        totalDeepSeekCalls += 1; totalCostMicrosCny += retriedResult.usage.amountMicros;
        copies.selectCandidate(workflowId, retriedResult.candidate.segmentId, retriedResult.candidate.candidateId,
          copies.getHead(workflowId, retriedResult.candidate.segmentId).version, USER);
        stage = "qa-after-remediation"; qaRun = await runModelQa(`${document.id}:qa-after-remediation`);
      } else qaRun = await runModelQa(`${document.id}:qa`);

      const blocking = qaRun.findings.filter((finding) => finding.layer === "invariant" && finding.severity === "error");
      if (blocking.length) {
        stage = "invariant-remediation";
        for (const finding of blocking) qaRun = qaService.decideFinding(qaRun.qaRunId, finding.findingId, "retranslate", USER);
        const remediation = new M5CRemediationService(fixture.database, fixture.workspaceId, { contexts });
        const retried = remediation.retranslate(qaRun.qaRunId, blocking.map((finding) => finding.findingId), { providerId: "deepseek", modelId: MODEL_ID,
          policyVersion: `${document.id}:provider-budget`, idempotencyKey: `${document.id}:invariant-retranslation`,
          estimatedUsage: estimate(blocking.length, 20_000, blocking.length * 1_024, 2_000_000, 120_000) }, USER);
        pricing.assignTask(retried.task.task.task_id, `${document.id}:provider-budget`);
        while (true) { const result = await executor.executeNext(); if (result.status === "idle") break;
          if (result.status !== "completed") throw new Error("invariant retranslation failed"); totalDeepSeekCalls += 1;
          totalCostMicrosCny += result.usage.amountMicros; copies.selectCandidate(workflowId, result.candidate.segmentId, result.candidate.candidateId,
            copies.getHead(workflowId, result.candidate.segmentId).version, USER); }
        stage = "qa-after-invariant-remediation"; qaRun = await runModelQa(`${document.id}:qa-after-invariant-remediation`);
        if (qaRun.findings.some((finding) => finding.layer === "invariant" && finding.severity === "error")) {
          throw Object.assign(new Error("blocking real QA invariant remains after remediation"), { code: "M5C_REAL_QA_BLOCKED" });
        }
      }
      for (const finding of qaRun.findings) {
        qaRun = qaService.decideFinding(qaRun.qaRunId, finding.findingId, "accept-issue", USER);
      }
      qaService.assertEligible(workflowId, qaRun.qaRunId);
      stage = "review-export"; const validationService = new ValidationService(fixture.database, fixture.workspaceId, { workCopies: copies });
      const validation = validationService.run(workflowId); if (validation.findings.some((item) => item.severity === "error")) throw new Error("real validation failed");
      const reviews = new ReviewService(fixture.database, fixture.workspaceId, { validation: validationService, quality: qaService });
      for (const warning of validation.findings.filter((item) => item.severity === "warning")) reviews.confirmWarning(workflowId, validation.validationRunId, warning.findingId, USER);
      let workflow = fixture.database.prepare("SELECT version FROM translation_workflows WHERE workspace_id = ? AND workflow_id = ?").get(fixture.workspaceId, workflowId);
      workflow = reviews.humanReview(workflowId, validation.validationRunId, workflow.version, USER, qaRun.qaRunId);
      workflow = reviews.approve(workflowId, validation.validationRunId, workflow.version, USER, qaRun.qaRunId);
      const exported = await new ExportService({ database: fixture.database, root: fixture.root, trustedWorkspaceId: fixture.workspaceId,
        workCopies: copies, validation: validationService, quality: qaService }).export(workflowId, validation.validationRunId, "text", qaRun.qaRunId);
      summaries.push({ id: document.id, direction: `${document.sourceLanguage}->${document.targetLanguage}`, domain: document.domain, length: document.length,
        plannerLatencyMs: Date.now() - plannerStarted, translationCalls: translationResults.length, qaFindings: qaRun.findings.length,
        validationWarnings: validation.findings.filter((item) => item.severity === "warning").length, exportDigest: exported.manifest.content_digest,
        ...(research ? { research } : {}) });
    } finally { await fixture.close(); }
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: "m5c-real-evaluation-result-v1", status: "completed", dataClass: "public-synthetic",
    corpusDigest: sha(JSON.stringify(m5cRealEvaluationCorpus)), documents: summaries, totals: { deepSeekCalls: totalDeepSeekCalls,
      braveCalls: totalBraveCalls, costMicrosCny: totalCostMicrosCny, costMicrosUsd: totalCostMicrosUsd }, rawResponsesRetained: false })}\n`);
} catch (error) {
  const allowed = new Set(["auth", "budget", "canceled", "malformed-response", "policy", "provider", "rate-limit", "timeout", "unknown-outcome"]);
  process.stderr.write(`${JSON.stringify({ status: "failed", stage, documentId,
    category: allowed.has(error?.category) ? error.category : "evaluation",
    code: typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(error.code) ? error.code : null,
    providerCode: typeof error?.providerCode === "string" && /^[a-z0-9_-]{1,64}$/u.test(error.providerCode) ? error.providerCode : null })}\n`); process.exitCode = 1;
} finally { await deepseek?.close(); await brave?.close(); }
