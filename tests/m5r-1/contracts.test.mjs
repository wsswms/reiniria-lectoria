import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { stableJson } from "../../src/domain/contracts.mjs";
import {
  RESEARCH_CONTRACT_VERSION,
  RESEARCH_LIMITS,
  researchCitationContract,
  researchClaimContract,
  researchGrantContract,
  researchQueryContract,
  researchReportContract,
  researchRequestContract,
  researchRunContract,
  researchSourceContract,
} from "../../src/research/contracts.mjs";

const now = new Date(0).toISOString();
const later = new Date(60 * 60 * 1_000).toISOString();
const sha = (value) => `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;

function fixtures() {
  const requestId = randomUUID();
  const requestRevisionId = randomUUID();
  const grantId = randomUUID();
  const runId = randomUUID();
  const queryId = randomUUID();
  const sourceId = randomUUID();
  const citationId = randomUUID();
  const claimId = randomUUID();
  return {
    request: { schemaVersion: RESEARCH_CONTRACT_VERSION, requestId, revisionId: requestRevisionId,
      taskId: randomUUID(), workflowId: randomUUID(), documentId: randomUUID(), sourceRevisionId: randomUUID(),
      targetLanguage: "zh-cn", segmentIds: [randomUUID()], gapKinds: ["term", "background-fact"],
      questions: ["What is the authoritative product term?"], localEvidenceDigest: sha("local"),
      origin: { type: "model", id: "fixture-model" }, createdAt: now },
    grant: { schemaVersion: RESEARCH_CONTRACT_VERSION, grantId, requestId, requestRevisionId,
      providers: [{ capability: "search", providerId: "brave-search", fallbackOrder: 0 }],
      limits: { ...RESEARCH_LIMITS.defaults }, allowedDomains: ["example.com"], allowedLanguages: ["en", "zh-CN"],
      approvedBy: { type: "user", id: "fixture-user" }, approvedAt: now, expiresAt: later },
    run: { schemaVersion: RESEARCH_CONTRACT_VERSION, runId, grantId, attempt: 1, state: "running", round: 1,
      requestDigest: sha("run"), startedAt: now, deadlineAt: later, pauseReason: null },
    query: { schemaVersion: RESEARCH_CONTRACT_VERSION, queryId, runId, round: 1, capability: "search", providerId: "brave-search",
      query: "authoritative product terminology", language: "en", country: "us", requestDigest: sha("query"), idempotencyKey: "query-1" },
    source: { schemaVersion: RESEARCH_CONTRACT_VERSION, sourceId, runId, queryId, canonicalUrl: "https://example.com/reference",
      urlDigest: sha("url"), sourceClusterId: randomUUID(), tier: "S1", lineage: "direct", artifactType: "fetch-snapshot",
      artifactId: randomUUID(), artifactDigest: sha("artifact"), retrievedAt: now },
    citation: { schemaVersion: RESEARCH_CONTRACT_VERSION, citationId, sourceId, quote: "The official product term is Workspace.",
      quoteDigest: sha("quote"), locator: { start: 0, end: 39, selector: "main > p" }, verified: true },
    claim: { schemaVersion: RESEARCH_CONTRACT_VERSION, claimId, runId, text: "Workspace is the official product term.",
      claimDigest: sha("claim"), supportLevel: "C2", citationIds: [citationId], inference: false },
    report: { schemaVersion: RESEARCH_CONTRACT_VERSION, reportId: randomUUID(), runId, outcome: "supported", stopReason: "questions-answered",
      questionAnswers: [{ question: "What is the term?", answer: "Workspace", status: "supported" }], claimIds: [claimId],
      usage: { searchCalls: 1, contentUrls: 1, modelTokens: 0, costMicrosUsd: 0 }, reportDigest: sha("report"), createdAt: now },
  };
}

const contracts = [
  ["Request", researchRequestContract, "request"], ["Grant", researchGrantContract, "grant"],
  ["Run", researchRunContract, "run"], ["Query", researchQueryContract, "query"],
  ["Source", researchSourceContract, "source"], ["Citation", researchCitationContract, "citation"],
  ["Claim", researchClaimContract, "claim"], ["Report", researchReportContract, "report"],
];

for (const [name, contract, key] of contracts) test(`${name} contract round-trips byte-stably one hundred times`, () => {
  for (let index = 0; index < 100; index += 1) {
    const input = fixtures()[key];
    const first = contract(input);
    const second = contract(JSON.parse(stableJson(first)));
    assert.equal(stableJson(first), stableJson(second));
    assert.equal(Object.isFrozen(first), true);
  }
});

test("contracts fail closed on unknown fields versions authorization and hard-limit violations", () => {
  const sample = fixtures();
  for (const [contract, input] of [
    [researchRequestContract, { ...sample.request, schemaVersion: "2.0" }],
    [researchRequestContract, { ...sample.request, unexpected: true }],
    [researchGrantContract, { ...sample.grant, approvedBy: { type: "system", id: "forged" } }],
    [researchGrantContract, { ...sample.grant, limits: { ...sample.grant.limits, maxRounds: 11 } }],
    [researchRunContract, { ...sample.run, state: "paused", pauseReason: null }],
    [researchQueryContract, { ...sample.query, capability: "shell" }],
    [researchSourceContract, { ...sample.source, lineage: "provider-processed", artifactType: "fetch-snapshot" }],
    [researchClaimContract, { ...sample.claim, citationIds: [], supportLevel: "C3" }],
    [researchReportContract, { ...sample.report, outcome: "confident" }],
  ]) assert.throws(() => contract(input), TypeError);
});

test("grant defaults and maxima preserve the approved product limits", () => {
  assert.deepEqual(RESEARCH_LIMITS.defaults, { maxRounds: 5, maxSearchCalls: 12, maxResultsPerSearch: 10,
    maxContentUrls: 16, maxDurationSeconds: 1_800, maxRuns: 2, maxModelTokens: 0, maxCostMicrosUsd: 0 });
  assert.deepEqual(RESEARCH_LIMITS.maxima, { maxRounds: 10, maxSearchCalls: 30, maxResultsPerSearch: 10,
    maxContentUrls: 40, maxDurationSeconds: 5_400, maxRuns: 3, maxModelTokens: 10_000_000, maxCostMicrosUsd: 1_000_000 });
});
