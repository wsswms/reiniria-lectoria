import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspaceDatabase } from "../db/connection.mjs";
import { DocumentImportService } from "../document/import-service.mjs";
import { DomainStateService } from "../domain/state-service.mjs";
import { ResearchBudgetService } from "../research/budget-service.mjs";
import { ResearchCapabilityService } from "../research/capability.mjs";
import { ResearchEvidenceService } from "../research/evidence-service.mjs";
import { ResearchFoundationService } from "../research/foundation-service.mjs";
import { ResearchProposalBridge } from "../research/proposal-bridge.mjs";
import { ResearchRunService } from "../research/run-service.mjs";
import { ResearchToolGateway } from "../research/tool-gateway.mjs";
import { CapabilityAuthority } from "../runner/capability.mjs";
import { invokeProviderThroughRunner } from "../runner/provider-runner.mjs";
import { createRealBraveGatewayAdapter } from "../research/real-brave-evaluation.mjs";
import { RestrictedFetchProxy } from "../search/fetch-proxy.mjs";
import { InvestigationService } from "../search/investigation-service.mjs";
import { PricingBudgetService } from "../provider/cost-budget.mjs";
import { openCredentialFile } from "../provider/credential-file.mjs";
import { invokeBrokerProcess } from "../provider/broker-process.mjs";
import { buildContextManifest } from "../provider/prompt-context.mjs";
import { TranslationExecutor } from "../provider/translation-executor.mjs";
import { TranslationTaskOrchestrator } from "../provider/task-orchestrator.mjs";
import { ValidationService } from "../translation/validator.mjs";
import { WorkCopyService } from "../translation/work-copy-service.mjs";
import { KnowledgeFactService } from "../knowledge/fact-service.mjs";
import { FtsRetriever } from "../knowledge/fts-retriever.mjs";
import { EvidenceService } from "../knowledge/evidence-service.mjs";
import { BrokeredDeepSeekResearchAdapter } from "./brokered-research-adapter.mjs";
import { createPinnedHttpsTransport, createRobotsPolicy } from "./restricted-https-transport.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const USER = Object.freeze({ type: "user", id: "real-article-pilot-owner" });
const SYSTEM = Object.freeze({ type: "system", id: "real-article-pilot-control-plane" });
const MODEL = Object.freeze({ type: "model", id: "real-article-pilot-gap-detector" });
const zero = Object.freeze({ maxSearchCalls: 0, maxContentUrls: 0, maxModelTokens: 0, maxCostMicrosUsd: 0 });

function comparisonProfile(input, segmentCount) {
  if (input === undefined) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !["label", "facts", "segmentQueries", "topK"].includes(key))) {
    throw new TypeError("knowledge profile is invalid");
  }
  if (typeof input.label !== "string" || input.label.length < 1 || input.label.length > 128
    || !Array.isArray(input.facts) || input.facts.length < 1 || input.facts.length > 64
    || !Array.isArray(input.segmentQueries) || input.segmentQueries.length !== segmentCount
    || !Number.isInteger(input.topK) || input.topK < 1 || input.topK > 20) {
    throw new TypeError("knowledge profile is invalid");
  }
  for (const fact of input.facts) {
    if (!fact || typeof fact !== "object" || Array.isArray(fact)
      || Object.keys(fact).some((key) => !["kind", "language", "tags", "content"].includes(key))
      || !["term", "knowledge", "style"].includes(fact.kind) || typeof fact.language !== "string"
      || !Array.isArray(fact.tags) || !fact.content || typeof fact.content !== "object") {
      throw new TypeError("knowledge profile fact is invalid");
    }
  }
  for (const queries of input.segmentQueries) {
    if (!Array.isArray(queries) || queries.length > 8 || queries.some((query) => typeof query !== "string"
      || [...query].length < 1 || [...query].length > 512) || new Set(queries).size !== queries.length) {
      throw new TypeError("knowledge profile queries are invalid");
    }
  }
  return input;
}

function proposalSource(item, documentId, targetLanguage) {
  const common = { schemaVersion: "1.0", factId: randomUUID(), revisionId: randomUUID(), language: item.sourceLanguage,
    scope: { targetLanguages: [targetLanguage], tags: ["real-article-pilot"], documentIds: [documentId] } };
  if (item.kind === "term") return { ...common, kind: "term", content: { term: item.sourceText,
    preferredTranslations: [{ language: targetLanguage, text: item.targetText }], forbiddenTranslations: [], variants: [], note: item.note } };
  return { ...common, kind: "knowledge", language: targetLanguage, content: { title: item.sourceText, body: item.targetText,
    tags: ["camera", "lens", "real-article-pilot"], source: "internet-research-draft" } };
}

export async function createLivePilotOperations(config, {
  runnerIdentity = { uid: 65532, gid: 65532 },
  now = () => new Date(),
  knowledgeProfile,
  invokeTranslationProvider,
  onTranslationRequest,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "lectoria-real-article-pilot-"));
  for (const directory of ["private/objects", "private/ledger", "derived", "staging", "dictionary", "style", "knowledge"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  const workspaceId = randomUUID();
  const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId, now });
  const state = {};

  async function translate({ sourceParagraphs, targetLanguage }) {
    const content = sourceParagraphs.join("\n\n");
    const imports = new DocumentImportService({ database, root, trustedWorkspaceId: workspaceId, now });
    const imported = await imports.import({ format: "text", content, title: config.article.title });
    imports.confirm(imported.importId, USER);
    const workflowId = randomUUID();
    new DomainStateService(database, workspaceId, { now }).create({ workflowId, documentId: imported.documentId,
      sourceRevisionId: imported.sourceRevisionId, targetLanguage }, {}, "editing");
    const segments = database.prepare(`SELECT segment_id AS segmentId, source_text AS sourceText, translatable, ordinal
      FROM source_segment_versions WHERE workspace_id = ? AND source_revision_id = ? ORDER BY ordinal`).all(workspaceId, imported.sourceRevisionId);
    const translatable = segments.filter((item) => item.translatable === 1);
    if (translatable.length !== sourceParagraphs.length) throw new Error("import segmentation differs from the approved article manifest");
    const profile = comparisonProfile(knowledgeProfile, translatable.length);
    let evidenceService;
    const evidenceIdsBySegment = new Map();
    if (profile) {
      const facts = new KnowledgeFactService(root, database, workspaceId, { now });
      for (const item of profile.facts) {
        await facts.create({ schemaVersion: "1.0", factId: randomUUID(), revisionId: randomUUID(), kind: item.kind,
          language: item.language, scope: { targetLanguages: [targetLanguage], tags: item.tags,
            documentIds: [imported.documentId] }, content: item.content }, USER);
      }
      const retriever = new FtsRetriever(root, database, workspaceId, { now });
      await retriever.rebuild();
      evidenceService = new EvidenceService(database, workspaceId, retriever, { now,
        policyVersion: `real-article-comparison-${profile.label}` });
      for (const [index, segment] of translatable.entries()) {
        const snapshots = profile.segmentQueries[index].map((query) => evidenceService.capture({ workflowId,
          segmentId: segment.segmentId, query, kinds: ["term", "knowledge", "style"], tags: [], topK: profile.topK }));
        if (snapshots.some((snapshot) => snapshot.hits.length === 0)) throw new Error("knowledge profile query returned no evidence");
        if (snapshots.length > 0) evidenceIdsBySegment.set(segment.segmentId, snapshots.map((snapshot) => snapshot.evidenceId));
      }
    }
    const tasks = new TranslationTaskOrchestrator(database, workspaceId, { now });
    const budgets = new PricingBudgetService(database, workspaceId, { now });
    budgets.addPricing({ providerId: "deepseek", modelId: config.deepseek.modelId, pricingVersion: config.deepseek.pricing.version, currency: "USD",
      ...config.deepseek.pricing, source: "user-authorized-real-article-pilot" });
    const policyVersion = `real-article-pilot-${config.article.digest.slice(-16)}`;
    budgets.addPolicy({ policyVersion, currency: "USD", softLimitMicros: config.deepseek.translation.hardLimitMicros,
      hardLimitMicros: config.deepseek.translation.hardLimitMicros, unknownPriceAction: "block" });
    const promptVersion = profile ? "lectoria-translation-v2" : "lectoria-translation-v1";
    const contextDigests = Object.fromEntries(translatable.map((segment) => {
      const evidenceIds = evidenceIdsBySegment.get(segment.segmentId);
      return [segment.segmentId, buildContextManifest(database, workspaceId,
        { workflowId, segmentIds: [segment.segmentId], promptVersion,
          ...(evidenceIds?.length ? { evidenceIds } : {}) }).contextDigest];
    }));
    const queued = tasks.enqueue({ workflowId, documentId: imported.documentId, sourceRevisionId: imported.sourceRevisionId, targetLanguage,
      segmentIds: translatable.map((item) => item.segmentId), idempotencyKey: `real-article:${config.article.digest}`,
      requestDigest: sha(JSON.stringify(contextDigests)), policyVersion, providerId: "deepseek", modelId: config.deepseek.modelId,
      promptVersion, contextDigests, maxAttempts: 1, batchSize: 1 });
    if (evidenceService) {
      for (const attempt of queued.attempts) {
        const evidenceIds = evidenceIdsBySegment.get(attempt.segment_id);
        if (evidenceIds?.length) evidenceService.bindAttempt(attempt.attempt_id, evidenceIds);
      }
    }
    budgets.assignTask(queued.task.task_id, policyVersion);
    let calls = 0;
    const capabilityAuthority = new CapabilityAuthority(randomBytes(32));
    const invokeProvider = async (request, options) => {
      if (calls >= config.deepseek.translation.maxCalls) throw Object.assign(new Error("translation call limit reached"), { category: "budget" });
      calls += 1;
      if (onTranslationRequest !== undefined) {
        if (typeof onTranslationRequest !== "function") throw new TypeError("onTranslationRequest is invalid");
        await onTranslationRequest(request);
      }
      if (invokeTranslationProvider !== undefined) {
        if (typeof invokeTranslationProvider !== "function") throw new TypeError("invokeTranslationProvider is invalid");
        return invokeTranslationProvider(request, options);
      }
      const credential = await openCredentialFile(config.deepseek.credentialPath);
      try { return await invokeProviderThroughRunner({ request, capabilityAuthority, runnerIdentity, signal: options.signal,
        invokeProvider: (brokerRequest, { credentialRef }) => invokeBrokerProcess({ request: brokerRequest, credentialRef, credentialFd: credential.fd }, { timeoutMs: 60_000 }),
        providerOptions: options }); } finally { await credential.close(); }
    };
    const executor = new TranslationExecutor(database, workspaceId, { invokeProvider, credentialRef: "external-file:deepseek/translation-pilot",
      pricingVersion: config.deepseek.pricing.version, estimatedOutputTokens: config.deepseek.translation.maxOutputTokens,
      orchestrator: tasks, budgets, evidenceService, now, workerId: "real-article-pilot" });
    for (let index = 0; index < translatable.length; index += 1) {
      const result = await executor.executeNext();
      if (result.status !== "completed") throw Object.assign(new Error("translation attempt failed"), { category: result.error?.category ?? result.status });
    }
    if ((await executor.executeNext()).status !== "idle") throw new Error("translation attempts did not settle");
    const workCopies = new WorkCopyService(database, workspaceId, { now });
    const candidates = database.prepare(`SELECT segment_id AS segmentId, candidate_id AS candidateId FROM translation_candidates
      WHERE workspace_id = ? AND workflow_id = ? AND source_type = 'machine'`).all(workspaceId, workflowId);
    for (const item of candidates) workCopies.selectCandidate(workflowId, item.segmentId, item.candidateId, null, USER);
    const validation = new ValidationService(database, workspaceId, { now, workCopies }).run(workflowId);
    const errors = validation.findings.filter((item) => item.severity === "error");
    if (errors.length) throw Object.assign(new Error("machine draft failed validation"), { category: "validation" });
    const bundle = workCopies.getBundle(workflowId);
    const usage = database.prepare(`SELECT count(*) AS calls, coalesce(sum(input_tokens),0) AS inputTokens,
      coalesce(sum(output_tokens),0) AS outputTokens, coalesce(sum(amount_micros),0) AS costMicrosUsd
      FROM usage_cost_records WHERE workspace_id = ?`).get(workspaceId);
    state.scope = { imported, workflowId, taskId: queued.task.task_id, segments: translatable, bundle };
    state.translationDiagnostics = Object.freeze({ profile: profile?.label ?? null,
      facts: profile?.facts.length ?? 0,
      evidenceSnapshots: [...evidenceIdsBySegment.values()].reduce((total, ids) => total + ids.length, 0),
      evidenceBoundSegments: evidenceIdsBySegment.size });
    return { segments: bundle.segments.map((item) => ({ segmentId: item.segmentId, sourceText: item.sourceText, targetText: item.text })),
      usage, validation: { errors: 0, warnings: validation.findings.filter((item) => item.severity === "warning").length } };
  }

  async function investigate({ questions, allowedDomains }) {
    if (!state.scope) throw new Error("translation must complete before research");
    const { imported, workflowId, taskId, segments } = state.scope;
    const foundation = new ResearchFoundationService(database, workspaceId, { now });
    const request = { schemaVersion: "1.0", requestId: randomUUID(), revisionId: randomUUID(), taskId, workflowId,
      documentId: imported.documentId, sourceRevisionId: imported.sourceRevisionId, targetLanguage: config.article.targetLanguage,
      segmentIds: segments.map((item) => item.segmentId), gapKinds: ["term", "proper-name", "background-fact"], questions,
      localEvidenceDigest: sha(config.article.digest), origin: MODEL, createdAt: now().toISOString() };
    foundation.createRequest(request, MODEL); foundation.submitRequest(request.requestId, 0, MODEL); foundation.decideRequest(request.requestId, 1, "approved", USER);
    const approvedAt = now();
    const providers = [
      { capability: "search", providerId: "brave-search", fallbackOrder: 0, budget: { ...zero, maxSearchCalls: Math.min(questions.length, config.brave.maxCalls), maxCostMicrosUsd: config.brave.hardLimitMicros } },
      { capability: "fetch", providerId: "restricted-fetch", fallbackOrder: 0, budget: { ...zero, maxContentUrls: Math.min(questions.length, config.fetch.maxUrls) } },
      { capability: "research-model", providerId: "deepseek-research", fallbackOrder: 0, budget: { ...zero,
        maxModelTokens: 1_000_000, maxCostMicrosUsd: config.deepseek.research.hardLimitMicros } },
    ];
    const grantInput = { schemaVersion: "1.0", grantId: randomUUID(), requestId: request.requestId, requestRevisionId: request.revisionId,
      providers, limits: { maxRounds: 1, maxSearchCalls: Math.min(questions.length, config.brave.maxCalls), maxResultsPerSearch: config.brave.maxResultsPerSearch,
        maxContentUrls: Math.min(questions.length, config.fetch.maxUrls), maxDurationSeconds: 1800, maxRuns: 1,
        maxModelTokens: 1_000_000,
        maxCostMicrosUsd: config.brave.hardLimitMicros + config.deepseek.research.hardLimitMicros }, allowedDomains,
      allowedLanguages: [...new Set([config.article.sourceLanguage, config.article.targetLanguage, config.brave.searchLanguage])], approvedBy: USER,
      approvedAt: approvedAt.toISOString(), expiresAt: new Date(approvedAt.getTime() + 1_800_000).toISOString() };
    const grant = foundation.issueGrant(request.requestId, grantInput, USER).grant;
    const runs = new ResearchRunService(database, workspaceId, { now });
    const run = runs.create(grant.grantId, sha(JSON.stringify({ requestId: request.requestId, questions })), SYSTEM); runs.transition(run.runId, "running", { actor: SYSTEM });
    const budgets = new ResearchBudgetService(database, workspaceId, { now });
    const resolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((item) => item.address);
    const transport = createPinnedHttpsTransport();
    const fetchProxy = new RestrictedFetchProxy({ resolver, transport, robotsAllowed: createRobotsPolicy({ resolver, transport }),
      timeoutMs: config.fetch.timeoutMs, maxConcurrency: config.fetch.maxConcurrency, now });
    const brave = createRealBraveGatewayAdapter({ credentialPath: config.brave.credentialPath, costMicrosUsdPerCall: config.brave.costMicrosPerCall,
      brokerOptions: { timeoutMs: 30_000 } });
    const investigations = new InvestigationService(database, workspaceId, { now, searchInvoker: async (input) => {
      const response = await brave.search(input);
      return { adapterId: response.adapterId, adapterVersion: response.adapterVersion, results: response.results };
    }, fetchProxy,
      handleKey: randomBytes(32) });
    const observations = [];
    for (const [index, question] of questions.entries()) {
      const searchReservation = budgets.reserve(run.runId, { round: 1, capability: "search", providerId: "brave-search", query: question,
        language: config.brave.searchLanguage, country: config.brave.country, idempotencyKey: `pilot:search:${index}`,
        estimate: { searchCalls: 1, contentUrls: 0, modelTokens: 0, costMicrosUsd: config.brave.costMicrosPerCall } });
      const investigation = investigations.create({ taskId, workflowId, segmentId: segments[0].segmentId, query: question,
        maxResults: config.brave.maxResultsPerSearch, country: config.brave.country, searchLanguage: config.brave.searchLanguage }, USER);
      let search;
      try { search = await investigations.search(investigation.investigationId); budgets.settle(searchReservation.queryId,
        { searchCalls: 1, contentUrls: 0, modelTokens: 0, costMicrosUsd: config.brave.costMicrosPerCall }); }
      catch (error) { budgets.unknown(searchReservation.queryId,
        { searchCalls: 1, contentUrls: 0, modelTokens: 0, costMicrosUsd: config.brave.costMicrosPerCall },
        { category: error?.category ?? "unknown" }); throw error; }
      const selected = search.results.find((item) => allowedDomains.length === 0 || allowedDomains.some((domain) => {
        const host = new URL(item.url).hostname; return host === domain || host.endsWith(`.${domain}`); }));
      if (!selected) continue;
      const fetchReservation = budgets.reserve(run.runId, { round: 1, capability: "fetch", providerId: "restricted-fetch", query: selected.url,
        language: config.brave.searchLanguage, country: config.brave.country, idempotencyKey: `pilot:fetch:${index}`,
        estimate: { searchCalls: 0, contentUrls: 1, modelTokens: 0, costMicrosUsd: 0 } });
      let fetched;
      try { fetched = await investigations.fetch(investigation.investigationId, selected.resultId, selected.handle, USER);
        budgets.settle(fetchReservation.queryId, { searchCalls: 0, contentUrls: 1, modelTokens: 0, costMicrosUsd: 0 }); }
      catch (error) { budgets.unknown(fetchReservation.queryId,
        { searchCalls: 0, contentUrls: 1, modelTokens: 0, costMicrosUsd: 0 },
        { category: error?.category ?? "unknown" }); throw error; }
      observations.push({ observationId: fetchReservation.queryId, queryId: fetchReservation.queryId, investigationId: investigation.investigationId,
        fetchSnapshotId: fetched.fetchSnapshotId, url: fetched.finalUrl, title: fetched.title || selected.title, content: fetched.extractedText.slice(0, 262_144) });
    }
    if (observations.length === 0) throw new Error("no selected public page passed restricted Fetch");
    const evidence = new ResearchEvidenceService(database, workspaceId, { now });
    const sourceByObservation = new Map(observations.map((item) => [item.observationId, evidence.addSource(run.runId, item.queryId,
      { canonicalUrl: item.url, tier: "S2", lineage: "direct", artifactType: "fetch-snapshot", artifactId: item.fetchSnapshotId })]));
    const model = new BrokeredDeepSeekResearchAdapter({ credentialPath: config.deepseek.credentialPath, modelId: config.deepseek.modelId,
      maxOutputTokens: config.deepseek.research.maxOutputTokens, thinkingMode: config.deepseek.research.thinkingMode,
      pricing: config.deepseek.pricing, brokerOptions: { timeoutMs: config.deepseek.research.thinkingMode === "enabled" ? 600_000 : 60_000 } });
    const capabilities = new ResearchCapabilityService(database, workspaceId, { key: randomBytes(32), now });
    const gateway = new ResearchToolGateway(database, workspaceId, { capabilities, budgets, evidence, adapters: new Map([["deepseek-research", model]]), now });
    const reasoned = await gateway.reason(capabilities.issue(run.runId), run.runId, { providerId: "deepseek-research", round: 1,
      prompt: "Synthesize only the supplied evidence into cited answers and draft proposals.", language: config.article.targetLanguage,
      country: config.brave.country, idempotencyKey: "pilot:research:0", fixture: { questions, evidence: observations.map(({ observationId, url, title, content }) => ({ observationId, url, title, content })) } });
    const claims = [];
    for (const answer of reasoned.answers) for (const item of answer.claims) {
      const citationIds = item.evidence.map((citation) => { const source = sourceByObservation.get(citation.observationId);
        const content = observations.find((entry) => entry.observationId === citation.observationId).content; const start = content.indexOf(citation.quote);
        return evidence.cite(source.sourceId, { quote: citation.quote, locator: { start, end: start + citation.quote.length } }).citationId; });
      claims.push(evidence.claim(run.runId, { text: item.text, citationIds, inference: item.inference, disputed: item.disputed,
        insufficient: item.insufficient, narrowOfficial: item.narrowOfficial }));
    }
    const report = evidence.report(run.runId, { questionAnswers: reasoned.answers.map(({ question, answer, status }) => ({ question, answer, status })),
      claimIds: claims.map((item) => item.claimId), usage: budgets.totals(grant.grantId) });
    let proposals = [];
    if (["supported", "partial"].includes(report.outcome) && reasoned.proposals.length) {
      const anchor = observations[0];
      proposals = new ResearchProposalBridge(database, workspaceId).createFromReport({ reportId: report.reportId,
        investigationId: anchor.investigationId, fetchSnapshotId: anchor.fetchSnapshotId,
        proposals: reasoned.proposals.map((item) => ({ operation: "create", proposedSource: proposalSource(item, imported.documentId, config.article.targetLanguage) })) }, SYSTEM)
        .map((item) => ({ proposalId: item.proposalId, state: item.head.state, decision: null, appliedAt: null, proposedSource: item.revision.proposedSource }));
    }
    runs.transition(run.runId, "completed", { actor: SYSTEM, details: { reportId: report.reportId } });
    return { questions: report.questionAnswers, claims: claims.map((item) => ({ text: item.text, supportLevel: item.supportLevel,
      citations: item.citationIds.map((id) => { const citation = evidence.getCitation(id); const source = evidence.getSource(citation.sourceId);
        return { url: source.canonicalUrl, quote: citation.quote }; }) })), proposals,
      usage: { ...budgets.totals(grant.grantId), modelCalls: 1 } };
  }

  return Object.freeze({ translate, investigate,
    diagnostics() { return state.translationDiagnostics ?? null; },
    async close() { database.close(); await rm(root, { recursive: true, force: true }); } });
}
