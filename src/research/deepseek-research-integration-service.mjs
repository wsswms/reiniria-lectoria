import { researchCaseContract, providerResearchResultContract } from "./deepseek-server-research-contracts.mjs";
import { DirectResearchFetchSnapshotService } from "./direct-fetch-snapshot-service.mjs";
import { ResearchConflictError, ResearchFoundationService } from "./foundation-service.mjs";
import { DEEPSEEK_RESEARCH_CREDENTIAL_REF } from "./deepseek-research-broker-process.mjs";

const PROVIDER_ID = "deepseek-server-research";
const ZERO = Object.freeze({ searchCalls: 0, contentUrls: 0, modelTokens: 0, costMicrosUsd: 0 });

export class DeepSeekResearchIntegrationError extends Error {
  constructor(category, retryable = false) {
    super("DeepSeek research integration failed");
    this.name = "DeepSeekResearchIntegrationError";
    this.category = category;
    this.retryable = retryable;
  }
}

function pricing(input) {
  const keys = ["version", "inputMicrosUsdPerMillion", "cachedInputMicrosUsdPerMillion", "outputMicrosUsdPerMillion"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key))
    || keys.some((key) => !(key in input)) || typeof input.version !== "string" || input.version.length < 1 || input.version.length > 128) {
    throw new TypeError("DeepSeek research pricing is invalid");
  }
  for (const key of keys.slice(1)) if (!Number.isSafeInteger(input[key]) || input[key] < 0) throw new TypeError("DeepSeek research pricing is invalid");
  return Object.freeze({ ...input });
}

function pricedUsage(result, snapshot) {
  const uncached = result.usage.inputTokens - result.usage.cachedInputTokens;
  const numerator = BigInt(uncached) * BigInt(snapshot.inputMicrosUsdPerMillion)
    + BigInt(result.usage.cachedInputTokens) * BigInt(snapshot.cachedInputMicrosUsdPerMillion)
    + BigInt(result.usage.outputTokens) * BigInt(snapshot.outputMicrosUsdPerMillion);
  const costMicrosUsd = Number((numerator + 999_999n) / 1_000_000n);
  const searchCalls = result.actions.filter((item) => item.type === "search").length;
  const contentUrls = new Set(result.actions.filter((item) => item.type === "open_page" && item.url).map((item) => item.url)).size;
  return Object.freeze({ searchCalls, contentUrls, modelTokens: result.usage.totalTokens, costMicrosUsd });
}

function locator(quote, content) {
  let start = content.indexOf(quote);
  if (start >= 0) return { quote, start, end: start + quote.length };
  const lower = content.toLocaleLowerCase();
  start = lower.indexOf(quote.toLocaleLowerCase());
  if (start >= 0) return { quote: content.slice(start, start + quote.length), start, end: start + quote.length };
  const compactTarget = quote.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  let compactContent = ""; const positions = [];
  for (let index = 0; index < content.length;) {
    const codePoint = String.fromCodePoint(content.codePointAt(index)); const end = index + codePoint.length;
    const normalized = codePoint.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
    compactContent += normalized;
    for (let offset = 0; offset < normalized.length; offset += 1) positions.push({ start: index, end });
    index = end;
  }
  const compactStart = compactContent.indexOf(compactTarget);
  if (compactTarget.length >= 4 && compactStart >= 0) {
    start = positions[compactStart].start;
    const end = positions[compactStart + compactTarget.length - 1].end;
    return { quote: content.slice(start, end), start, end };
  }
  const phrases = quote.split(/[|：:,，。；;\n]+/).map((item) => item.trim()).filter((item) => item.length >= 4).sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    start = lower.indexOf(phrase.toLocaleLowerCase());
    if (start >= 0) return { quote: content.slice(start, start + phrase.length), start, end: start + phrase.length };
  }
  throw new ResearchConflictError("verified quote cannot be located in the direct snapshot");
}

function terminalEntry(reservation) { return reservation.entries.find((item) => item.entryType !== "reserved"); }

export class DeepSeekResearchIntegrationService {
  constructor(database, workspaceId, { capabilities, budgets, runs, evidence, verifier, invokeProvider, pricingSnapshot,
    snapshots = new DirectResearchFetchSnapshotService(database, workspaceId), foundation = capabilities?.foundation } = {}) {
    if (!capabilities || !budgets || !runs || !evidence || !verifier || typeof verifier.verify !== "function"
      || typeof invokeProvider !== "function") throw new TypeError("DeepSeek research integration dependencies are required");
    this.database = database; this.workspaceId = workspaceId; this.capabilities = capabilities; this.budgets = budgets;
    this.runs = runs; this.evidence = evidence; this.verifier = verifier; this.invokeProvider = invokeProvider;
    this.pricing = pricing(pricingSnapshot); this.snapshots = snapshots;
    this.foundation = foundation ?? new ResearchFoundationService(database, workspaceId);
  }

  async execute(input) {
    const allowed = ["runId", "capabilityToken", "researchCase", "round", "language", "country", "idempotencyKey",
      "estimate", "credentialRef", "credentialFd", "signal"];
    if (!input || typeof input !== "object" || Object.keys(input).some((key) => !allowed.includes(key))) throw new TypeError("DeepSeek integration input is invalid");
    const researchCase = researchCaseContract(input.researchCase);
    if (input.credentialRef !== DEEPSEEK_RESEARCH_CREDENTIAL_REF || !Number.isSafeInteger(input.credentialFd) || input.credentialFd < 0) {
      throw new TypeError("DeepSeek credential scope is invalid");
    }
    const runScope = this.runs.get(input.runId);
    const { grant } = this.foundation.getGrant(runScope.grantId);
    const request = this.foundation.getRequest(grant.requestId).request;
    if (!request.questions.includes(researchCase.question) || !grant.allowedLanguages.includes(researchCase.responseLanguage)
      || !grant.allowedLanguages.includes(input.language)) throw new ResearchConflictError("DeepSeek research case is outside the approved request");
    this.capabilities.verify(input.capabilityToken, { runId: input.runId, tool: "submit-report", capability: "research-model", providerId: PROVIDER_ID });
    const existing = this.database.prepare("SELECT query_id AS queryId FROM research_queries WHERE workspace_id = ? AND run_id = ? AND idempotency_key = ?")
      .get(this.workspaceId, input.runId, input.idempotencyKey);
    if (existing) throw new ResearchConflictError("DeepSeek research execution already exists");
    const reservation = this.budgets.reserve(input.runId, { round: input.round, capability: "research-model", providerId: PROVIDER_ID,
      query: researchCase.question, language: input.language, country: input.country, idempotencyKey: input.idempotencyKey, estimate: input.estimate });
    const terminal = terminalEntry(reservation);
    if (terminal) {
      const report = this.database.prepare("SELECT report_json AS reportJson FROM research_reports WHERE workspace_id = ? AND run_id = ?")
        .get(this.workspaceId, input.runId);
      if (terminal.entryType === "settled" && report) return Object.freeze({ queryId: reservation.queryId,
        report: JSON.parse(report.reportJson), run: this.runs.get(input.runId), replayed: true });
      throw new ResearchConflictError("DeepSeek research reservation is already finalized");
    }
    let provider;
    try {
      provider = providerResearchResultContract(await this.invokeProvider({ researchCase, credentialRef: input.credentialRef,
        credentialFd: input.credentialFd, signal: input.signal }));
    } catch (error) {
      const category = typeof error?.category === "string" && /^[a-z-]{1,64}$/.test(error.category) ? error.category : "unknown-outcome";
      const knownNoCall = new Set(["auth", "policy"]).has(category);
      if (knownNoCall) {
        this.budgets.release(reservation.queryId, { category });
        this.runs.transition(input.runId, "failed", { details: { category } });
      } else {
        this.budgets.unknown(reservation.queryId, input.estimate, { category: "unknown-outcome" });
        this.runs.transition(input.runId, category === "canceled" ? "canceled" : "paused",
          category === "canceled" ? { details: { category: "canceled" } }
            : { reason: "unknown-outcome", details: { category: "unknown-outcome" } });
      }
      throw new DeepSeekResearchIntegrationError(category, error?.retryable === true);
    }
    const actual = pricedUsage(provider, this.pricing);
    try {
      this.budgets.settle(reservation.queryId, actual, { pricingVersion: this.pricing.version, responseId: provider.responseId,
        inputTokens: provider.usage.inputTokens, cachedInputTokens: provider.usage.cachedInputTokens,
        outputTokens: provider.usage.outputTokens, reasoningTokens: provider.usage.reasoningTokens });
    } catch (error) {
      if (!(error instanceof ResearchConflictError)) throw error;
      this.budgets.unknown(reservation.queryId, input.estimate, { category: "budget-overrun", actualUsage: actual,
        pricingVersion: this.pricing.version, responseId: provider.responseId });
      this.runs.transition(input.runId, "paused", { reason: "budget-exhausted", details: { category: "budget-overrun" } });
      throw new DeepSeekResearchIntegrationError("budget-exhausted");
    }
    const artifacts = [];
    let result;
    try {
      result = await this.verifier.verify(provider, { signal: input.signal, onVerifiedSource: async (item) => artifacts.push(item) });
      const citationIds = [];
      for (const artifact of artifacts) {
        const stored = this.snapshots.persist(input.runId, reservation.queryId, artifact.snapshot);
        const source = this.evidence.addSource(input.runId, reservation.queryId, { canonicalUrl: artifact.snapshot.finalUrl,
          tier: artifact.assessment.tier, lineage: "direct", artifactType: "fetch-snapshot", artifactId: stored.snapshotId });
        const found = locator(artifact.source.quote, artifact.snapshot.extractedText);
        citationIds.push(this.evidence.cite(source.sourceId, { quote: found.quote, locator: { start: found.start, end: found.end } }).citationId);
      }
      const claimIds = [];
      if (result.outcome === "resolved") {
        const narrowOfficial = artifacts.length === 1 && artifacts[0].assessment.tier === "S1"
          && new Set(["dictionary", "government", "primary"]).has(artifacts[0].source.sourceClass);
        claimIds.push(this.evidence.claim(input.runId, { text: result.answer, citationIds, inference: false,
          disputed: false, insufficient: citationIds.length === 0, narrowOfficial }).claimId);
      }
      const report = this.evidence.report(input.runId, { questionAnswers: [{ question: researchCase.question,
        answer: result.outcome === "resolved" ? result.answer : "", status: result.outcome }], claimIds, usage: actual });
      const run = this.runs.transition(input.runId, "completed", { details: { reportId: report.reportId, outcome: report.outcome } });
      return Object.freeze({ queryId: reservation.queryId, result, report, run, replayed: false });
    } catch (error) {
      const current = this.runs.get(input.runId);
      if (current.state === "running") this.runs.transition(input.runId, error?.category === "canceled" ? "canceled" : "failed",
        { details: { category: error?.category === "canceled" ? "canceled" : "evidence-processing" } });
      if (error?.category === "canceled") throw error;
      throw new DeepSeekResearchIntegrationError("evidence-processing");
    }
  }

  recoverInterrupted(runId, idempotencyKey) {
    const row = this.database.prepare("SELECT query_id AS queryId FROM research_queries WHERE workspace_id = ? AND run_id = ? AND idempotency_key = ?")
      .get(this.workspaceId, runId, idempotencyKey);
    if (!row) throw new ResearchConflictError("DeepSeek research execution not found");
    const reservation = this.budgets.get(row.queryId);
    if (reservation.entries.length !== 1 || reservation.entries[0].entryType !== "reserved") {
      throw new ResearchConflictError("DeepSeek research execution is already finalized");
    }
    const reserved = reservation.entries[0];
    const conservative = Object.fromEntries(["searchCalls", "contentUrls", "modelTokens", "costMicrosUsd"].map((key) => [key, reserved[key]]));
    this.budgets.unknown(row.queryId, conservative, { category: "interrupted-unknown-outcome" });
    const run = this.runs.get(runId);
    if (run.state === "running") this.runs.transition(runId, "paused", { reason: "unknown-outcome", details: { category: "interrupted-unknown-outcome" } });
    return Object.freeze({ query: this.budgets.get(row.queryId), run: this.runs.get(runId) });
  }
}

export const DEEPSEEK_RESEARCH_PROVIDER_ID = PROVIDER_ID;
export const EMPTY_RESEARCH_USAGE = ZERO;
