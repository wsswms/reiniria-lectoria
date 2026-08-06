import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { KnowledgeIterationService } from "../../src/knowledge/iteration-service.mjs";
import { ConfiguredResearchSourcePolicy, DeepSeekResearchSourceVerifier } from "../../src/research/deepseek-research-source-verifier.mjs";
import { DeepSeekResearchIntegrationError, DeepSeekResearchIntegrationService } from "../../src/research/deepseek-research-integration-service.mjs";
import { DEEPSEEK_RESEARCH_CREDENTIAL_REF } from "../../src/research/deepseek-research-broker-process.mjs";
import { ResearchAuthorizationError, ResearchConflictError } from "../../src/research/foundation-service.mjs";
import { ResearchProposalBridge } from "../../src/research/proposal-bridge.mjs";
import { ProposalConflictError } from "../../src/search/knowledge-proposal-service.mjs";
import { termInput } from "../m5-1/helpers.mjs";
import { researchWorkspace, system, user } from "../m5r-2/helpers.mjs";

const providerId = "deepseek-server-research";
const researchCase = Object.freeze({ schemaVersion: "deepseek-server-research-case-v1", caseId: "case-integration",
  question: "What does penultimate mean?", responseLanguage: "zh-CN", maxOutputTokens: 6000, reasoningEffort: "medium" });

function providerResult(outcome = "resolved-candidate") {
  return Object.freeze({ schemaVersion: "deepseek-server-research-provider-result-v1", adapterId: providerId,
    adapterVersion: "deepseek-responses-web-search-v1", caseId: researchCase.caseId, responseId: "resp-integration",
    modelId: "deepseek-v4-flash", outcome, answer: outcome === "resolved-candidate" ? "倒数第二" : "",
    explanation: "公开合成测试。", sources: outcome === "resolved-candidate" ? [{ url: "https://official.example/reference",
      title: "Official entry", quote: "next to the last", sourceClass: "dictionary" }] : [], droppedSources: [],
    actions: [{ type: "search", queries: ["penultimate"], url: null },
      { type: "open_page", queries: null, url: "https://official.example/reference" }],
    usage: { inputTokens: 120, cachedInputTokens: 20, outputTokens: 80, reasoningTokens: 30, totalTokens: 200 } });
}

function snapshot() {
  return Object.freeze({ requestedUrl: "https://official.example/reference", finalUrl: "https://official.example/reference",
    fetchedAt: new Date(0).toISOString(), policyVersion: "restricted-fetch-v1", statusCode: 200, mimeType: "text/plain",
    title: "Official entry", extractedText: "Penultimate means next to the last item in a series.", truncated: false,
    diagnostics: [], redirects: [], contentDigest: "sha256:94ffe5ea29f3d59c74541d661d2c3c946bc55c2fc37066888d7ec7e637ee12f7",
    snapshotDigest: "sha256:eec9fbf08b34d012ed1f455d1e56519893552934814ece10cb224b228f6e0a91", untrusted: true });
}

async function setup({ tier = "S1", invokeProvider } = {}) {
  const fixture = await researchWorkspace({ modelProviderId: providerId, questions: [researchCase.question],
    limits: { maxSearchCalls: 8, maxContentUrls: 8, maxModelTokens: 20_000, maxCostMicrosUsd: 10_000 },
    providerBudgets: { [providerId]: { maxSearchCalls: 8, maxContentUrls: 8, maxModelTokens: 20_000, maxCostMicrosUsd: 10_000 } } });
  const verifier = new DeepSeekResearchSourceVerifier({
    restrictedFetch: { fetchSelected: async () => snapshot() },
    sourcePolicy: new ConfiguredResearchSourcePolicy({ rules: [{ hostname: "official.example", includeSubdomains: false, tier }] }),
  });
  let calls = 0;
  const integration = new DeepSeekResearchIntegrationService(fixture.setup.fixture.database, fixture.setup.fixture.workspaceId,
    { capabilities: fixture.capabilities, budgets: fixture.budgets, runs: fixture.runs, evidence: fixture.evidence, verifier,
      invokeProvider: async (input) => { calls += 1; return invokeProvider ? invokeProvider(input) : providerResult(); },
      pricingSnapshot: { version: "fixture-usd-v1", inputMicrosUsdPerMillion: 2_000_000,
        cachedInputMicrosUsdPerMillion: 200_000, outputMicrosUsdPerMillion: 3_000_000 } });
  const input = { runId: fixture.run.runId, capabilityToken: fixture.capability, researchCase, round: 1, language: "en", country: "US",
    idempotencyKey: "deepseek-integration-case", estimate: { searchCalls: 4, contentUrls: 4, modelTokens: 8_000, costMicrosUsd: 2_000 },
    credentialRef: DEEPSEEK_RESEARCH_CREDENTIAL_REF, credentialFd: 3 };
  return { fixture, integration, input, calls: () => calls };
}

test("authorized DeepSeek execution settles one atomic budget and persists direct evidence through a supported report", async () => {
  const value = await setup();
  try {
    const completed = await value.integration.execute(value.input);
    assert.equal(value.calls(), 1);
    assert.equal(completed.result.outcome, "resolved");
    assert.equal(completed.report.outcome, "supported");
    assert.equal(completed.run.state, "completed");
    assert.deepEqual(completed.report.usage, { searchCalls: 1, contentUrls: 1, modelTokens: 200, costMicrosUsd: 444 });
    assert.equal(value.fixture.setup.fixture.database.prepare("SELECT count(*) AS count FROM research_direct_fetch_snapshots").get().count, 1);
    assert.equal(value.fixture.setup.fixture.database.prepare("SELECT lineage FROM research_sources").get().lineage, "direct");
    assert.equal(value.fixture.setup.fixture.database.prepare("SELECT support_level AS level FROM research_claims").get().level, "C2");
    await assert.rejects(() => value.integration.execute(value.input), ResearchAuthorizationError);
    assert.equal(value.calls(), 1);
  } finally { await value.fixture.close(); }
});

test("a supported direct report creates a real pending proposal that only a user can approve and apply", async () => {
  const value = await setup();
  try {
    const completed = await value.integration.execute(value.input);
    const snapshotId = value.fixture.setup.fixture.database.prepare(
      "SELECT snapshot_id AS snapshotId FROM research_direct_fetch_snapshots WHERE workspace_id = ? AND run_id = ?")
      .get(value.fixture.setup.fixture.workspaceId, value.fixture.run.runId).snapshotId;
    const proposedSource = termInput({ factId: randomUUID(), revisionId: randomUUID(), language: "en",
      scope: { targetLanguages: ["zh-CN"], tags: [], documentIds: [value.fixture.setup.workflow.documentId] },
      content: { term: "penultimate", preferredTranslations: [{ language: "zh-CN", text: "倒数第二" }],
        forbiddenTranslations: [], variants: [], note: "Direct research proposal" } });
    const bridge = new ResearchProposalBridge(value.fixture.setup.fixture.database, value.fixture.setup.fixture.workspaceId);
    const [proposal] = bridge.createFromReport({ reportId: completed.report.reportId, runId: value.fixture.run.runId,
      directSnapshotId: snapshotId, segmentId: value.fixture.setup.workflow.segmentId,
      proposals: [{ operation: "create", proposedSource }] }, system);
    assert.equal(proposal.originKind, "research-run");
    assert.equal(proposal.revision.evidenceKind, "direct-fetch");
    assert.equal(proposal.revision.directSnapshotId, snapshotId);
    assert.throws(() => bridge.proposals.decide(proposal.proposalId, 0, "approved", system), ProposalConflictError);
    bridge.proposals.decide(proposal.proposalId, 0, "approved", user);
    const iterations = new KnowledgeIterationService(value.fixture.setup.fixture.root, value.fixture.setup.fixture.database,
      value.fixture.setup.fixture.workspaceId, { now: value.fixture.now, facts: value.fixture.setup.facts,
        retriever: value.fixture.setup.retriever, proposals: bridge.proposals });
    const applied = await iterations.apply(proposal.proposalId, user);
    assert.equal(applied.application.factId, proposedSource.factId);
    assert.deepEqual(value.fixture.setup.facts.get(proposedSource.factId).source.content.preferredTranslations,
      [{ language: "zh-CN", text: "倒数第二" }]);
  } finally { await value.fixture.close(); }
});

test("terminal and lower-tier results complete safely without affirmative proposal-grade reports", async () => {
  const terminal = await setup({ invokeProvider: async () => providerResult("not-found") });
  try {
    const completed = await terminal.integration.execute(terminal.input);
    assert.equal(completed.report.outcome, "insufficient");
    assert.equal(completed.report.claimIds.length, 0);
    assert.equal(completed.run.state, "completed");
  } finally { await terminal.fixture.close(); }
  const ordinary = await setup({ tier: "S3" });
  try {
    const completed = await ordinary.integration.execute(ordinary.input);
    assert.equal(completed.result.outcome, "resolved");
    assert.equal(completed.report.outcome, "insufficient");
    assert.equal(ordinary.fixture.setup.fixture.database.prepare("SELECT support_level AS level FROM research_claims").get().level, "C1");
    const snapshotId = ordinary.fixture.setup.fixture.database.prepare("SELECT snapshot_id AS snapshotId FROM research_direct_fetch_snapshots").get().snapshotId;
    const bridge = new ResearchProposalBridge(ordinary.fixture.setup.fixture.database, ordinary.fixture.setup.fixture.workspaceId);
    assert.throws(() => bridge.createFromReport({ reportId: completed.report.reportId, runId: ordinary.fixture.run.runId,
      directSnapshotId: snapshotId, segmentId: ordinary.fixture.setup.workflow.segmentId,
      proposals: [{ operation: "create", proposedSource: termInput() }] }, system), ResearchConflictError);
  } finally { await ordinary.fixture.close(); }
});

test("authorization and budget failures make zero provider calls", async () => {
  const unauthorized = await setup();
  try {
    await assert.rejects(() => unauthorized.integration.execute({ ...unauthorized.input, capabilityToken: `${unauthorized.input.capabilityToken}x` }), ResearchAuthorizationError);
    assert.equal(unauthorized.calls(), 0);
    assert.equal(unauthorized.fixture.setup.fixture.database.prepare("SELECT count(*) AS count FROM research_queries").get().count, 0);
    await assert.rejects(() => unauthorized.integration.execute({ ...unauthorized.input,
      estimate: { ...unauthorized.input.estimate, modelTokens: 20_001 } }), ResearchConflictError);
    assert.equal(unauthorized.calls(), 0);
    await assert.rejects(() => unauthorized.integration.execute({ ...unauthorized.input, idempotencyKey: "forged-question",
      researchCase: { ...researchCase, question: "Research an unapproved topic." } }), ResearchConflictError);
    await assert.rejects(() => unauthorized.integration.execute({ ...unauthorized.input, idempotencyKey: "forged-language", language: "ja" }), ResearchConflictError);
    assert.equal(unauthorized.calls(), 0);
  } finally { await unauthorized.fixture.close(); }
});

test("unknown outcome is conservatively charged paused and never automatically retried", async () => {
  const value = await setup({ invokeProvider: async () => { throw Object.assign(new Error("private network detail"), { category: "unknown-outcome" }); } });
  try {
    await assert.rejects(() => value.integration.execute(value.input), (error) => error instanceof DeepSeekResearchIntegrationError
      && error.category === "unknown-outcome" && !String(error).includes("private network detail"));
    assert.equal(value.calls(), 1);
    assert.equal(value.fixture.runs.get(value.fixture.run.runId).state, "paused");
    assert.equal(value.fixture.runs.get(value.fixture.run.runId).reason, "unknown-outcome");
    assert.equal(value.fixture.setup.fixture.database.prepare("SELECT entry_type AS type FROM research_budget_ledger ORDER BY rowid DESC LIMIT 1").get().type, "unknown");
    await assert.rejects(() => value.integration.execute(value.input), ResearchConflictError);
    assert.equal(value.calls(), 1);
  } finally { await value.fixture.close(); }
});

test("actual usage above the reservation pauses before evidence and never calls the provider twice", async () => {
  const value = await setup();
  try {
    const input = { ...value.input, estimate: { searchCalls: 0, contentUrls: 0, modelTokens: 100, costMicrosUsd: 100 } };
    await assert.rejects(() => value.integration.execute(input), (error) => error.category === "budget-exhausted");
    assert.equal(value.calls(), 1);
    assert.equal(value.fixture.runs.get(value.fixture.run.runId).reason, "budget-exhausted");
    assert.equal(value.fixture.setup.fixture.database.prepare("SELECT count(*) AS count FROM research_direct_fetch_snapshots").get().count, 0);
    await assert.rejects(() => value.integration.execute(input), ResearchConflictError);
    assert.equal(value.calls(), 1);
  } finally { await value.fixture.close(); }
});

test("concurrent duplicate execution is rejected without disturbing the single provider call", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const value = await setup({ invokeProvider: async () => { await gate; return providerResult(); } });
  try {
    const first = value.integration.execute(value.input);
    while (value.calls() === 0) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(() => value.integration.execute(value.input), ResearchConflictError);
    assert.equal(value.calls(), 1);
    release();
    assert.equal((await first).run.state, "completed");
    assert.equal(value.calls(), 1);
  } finally { await value.fixture.close(); }
});

test("control-plane recovery marks an interrupted reservation unknown without calling the provider", async () => {
  const value = await setup();
  try {
    value.fixture.budgets.reserve(value.fixture.run.runId, { round: 1, capability: "research-model", providerId,
      query: researchCase.question, language: "en", country: "US", idempotencyKey: value.input.idempotencyKey,
      estimate: value.input.estimate });
    const recovered = value.integration.recoverInterrupted(value.fixture.run.runId, value.input.idempotencyKey);
    assert.equal(recovered.query.entries.at(-1).entryType, "unknown");
    assert.equal(recovered.run.reason, "unknown-outcome");
    assert.equal(value.calls(), 0);
    assert.throws(() => value.integration.recoverInterrupted(value.fixture.run.runId, value.input.idempotencyKey), ResearchConflictError);
  } finally { await value.fixture.close(); }
});

test("compact quote verification still creates an exact citation over the stored page text", async () => {
  const value = await setup({ invokeProvider: async () => ({ ...providerResult(), sources: [{ ...providerResult().sources[0],
    quote: "next—to the\nlast" }] }) });
  try {
    const completed = await value.integration.execute(value.input);
    assert.equal(completed.report.outcome, "supported");
    const citation = value.fixture.setup.fixture.database.prepare("SELECT quote_text AS quote FROM research_citations").get();
    assert.equal(citation.quote, "next to the last");
  } finally { await value.fixture.close(); }
});
