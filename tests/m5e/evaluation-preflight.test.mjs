import assert from "node:assert/strict";
import test from "node:test";
import { createBlindReviewPackage, freezeReferenceFamilies, summarizeM5EOutcomes } from "../../src/m5e/evaluation.mjs";
import { buildM5EPreflight } from "../../src/m5e/preflight.mjs";
import { buildM5EExperimentReport } from "../../src/m5e/experiment-report.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;

test("reference families freeze before translations and blind packages disclose no arm labels", () => {
  const frozen = freezeReferenceFamilies([{ familyId: "product-name", kind: "term", impact: "critical", segmentIds: ["s1"], description: "Product nickname" }],
    { sourceSetDigest: digest("b"), frozenAt: "2026-08-03T00:00:00.000Z" });
  assert.match(frozen.familySetDigest, /^sha256:/);
  const review = createBlindReviewPackage([{ pairId: "p1", segmentId: "s1", sourceText: "source", coldText: "cold", enhancedText: "enhanced" }],
    { seed: "fixed-seed", referenceFamilySetDigest: frozen.familySetDigest });
  assert.equal(JSON.stringify(review.reviewPackage).includes("enhancedLabel"), false);
  assert.equal(JSON.stringify(review.reviewPackage).includes("coldText"), false);
  assert.equal(JSON.stringify(review.reviewPackage).includes("enhancedText"), false);
  assert.deepEqual(new Set(review.reviewPackage.samples[0].candidates.map((item) => item.label)), new Set(["A", "B"]));
  assert.equal(review.answerKey.assignments.length, 1);
});

test("three M5E outcomes remain independent", () => {
  const result = summarizeM5EOutcomes({ candidate: { criticalCoverage: 1, highCoverage: 0.96, criticalHighWrongMerges: 0,
      overallWrongMergeRate: 0.01, residualDuplicateRate: 0.04, compressionRate: 0.55 },
    translation: { knowledgeErrorReduction: 0.35, terminologyErrorReduction: 0.6, criticalFactualEscapes: 0,
      blockingIncrease: 0, enhancedWinRate: 0.64 },
    reuse: { actionableReduction: 0.2, sharedFamilyReduction: 0.6, resourceRatio: 0.6, hitPrecision: 0.98,
      coveragePreserved: true, qualityPreserved: true } });
  assert.deepEqual(result, { candidatePruning: "go", translationQuality: "go", crossArticleReuse: "no-go" });
});

test("real-resource preflight stays closed until every offline and audit gate passes", () => {
  const base = { branch: "exp-m5e-knowledge-effect", isolatedModules: true, clusterTestsPassed: true, coordinatorTestsPassed: true,
    persistenceProbePassed: true, historicalReferenceSeedReady: true, referenceFamiliesFrozen: true, blindProtocolPassed: true,
    articleInputsReady: true, realRunnerDryRunPassed: true, fullRegressionPassed: true,
    auditDirectoryMode: "0700", auditFileMode: "0600", secretsReady: true, pricingCheckedAt: "2026-08-03T00:00:00.000Z",
    limits: { deepSeekAttempts: 310, deepSeekCostCny: 20, braveCalls: 50, braveCostUsd: 0.25, fetchUrls: 30 } };
  assert.equal(buildM5EPreflight(base).status, "ready");
  const closed = buildM5EPreflight({ ...base, fullRegressionPassed: false });
  assert.equal(closed.status, "closed"); assert.deepEqual(closed.blockers, ["full-regression"]);
  assert.deepEqual(buildM5EPreflight({ ...base, realRunnerDryRunPassed: false }).blockers, ["real-runner-dry-run"]);
  assert.throws(() => buildM5EPreflight({ ...base, limits: { ...base.limits, braveCalls: 51 } }), /hard limit/);
});

test("aggregate audit report accounts for every arm without embedding private article text", () => {
  const metrics = { candidate: { criticalCoverage: 1, highCoverage: 0.96, criticalHighWrongMerges: 0,
      overallWrongMergeRate: 0.01, residualDuplicateRate: 0.04, compressionRate: 0.55 },
    translation: { knowledgeErrorReduction: 0.35, terminologyErrorReduction: 0.6, criticalFactualEscapes: 0,
      blockingIncrease: 0, enhancedWinRate: 0.64 }, reuse: { actionableReduction: 0.35, sharedFamilyReduction: 0.55,
      resourceRatio: 0.65, hitPrecision: 0.97, coveragePreserved: true, qualityPreserved: true } };
  const arms = ["C1", "E1", "C2", "E2"].map((armId) => ({ armId,
    funnel: { rawOccurrences: 100, canonicalCandidates: 70, clusters: 40, actionableResearch: armId.startsWith("E") ? 10 : 20 },
    usage: { deepSeekAttempts: 10, inputTokens: 1_000, outputTokens: 500, reasoningTokens: 200,
      costMicrosCny: 100_000, braveCalls: armId.startsWith("E") ? 2 : 0, braveCostMicrosUsd: armId.startsWith("E") ? 10_000 : 0,
      fetchUrls: armId.startsWith("E") ? [`https://example.com/${armId}`] : [] }, auditDigest: digest("a"), qualityArtifactDigest: digest("9") }));
  const report = buildM5EExperimentReport({ planDigest: digest("1"), manifestDigest: digest("2"), referenceFamilySetDigest: digest("3"), arms, metrics });
  assert.equal(report.totals.deepSeekAttempts, 40); assert.equal(report.totals.braveCalls, 4); assert.equal(report.outcomes.crossArticleReuse, "go");
  assert.equal(JSON.stringify(report).includes("sourceText"), false); assert.match(report.reportDigest, /^sha256:/);
});
