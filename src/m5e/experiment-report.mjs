import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { summarizeM5EOutcomes } from "./evaluation.mjs";

const ARMS = Object.freeze(["C1", "E1", "C2", "E2"]);
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const sha = (value) => `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
const integer = (value, name) => { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} is invalid`); return value; };
const digest = (value, name) => { if (!DIGEST.test(value)) throw new TypeError(`${name} is invalid`); return value; };

function arm(input) {
  if (!input || !ARMS.includes(input.armId)) throw new TypeError("arm audit is invalid");
  const funnel = input.funnel; const usage = input.usage;
  for (const key of ["rawOccurrences", "canonicalCandidates", "clusters", "actionableResearch"]) integer(funnel?.[key], `funnel.${key}`);
  if (funnel.canonicalCandidates > funnel.rawOccurrences || funnel.clusters > funnel.canonicalCandidates || funnel.actionableResearch > funnel.clusters) {
    throw new TypeError("funnel counts are not monotonic");
  }
  for (const key of ["deepSeekAttempts", "inputTokens", "outputTokens", "reasoningTokens", "costMicrosCny", "braveCalls", "braveCostMicrosUsd"]) {
    integer(usage?.[key], `usage.${key}`);
  }
  if (!Array.isArray(usage.fetchUrls) || usage.fetchUrls.length > 30 || new Set(usage.fetchUrls).size !== usage.fetchUrls.length
    || usage.fetchUrls.some((value) => typeof value !== "string" || !value.startsWith("https://"))) throw new TypeError("fetch URL audit is invalid");
  return Object.freeze({ armId: input.armId, funnel: Object.freeze({ ...funnel }), usage: Object.freeze({ ...usage, fetchUrls: Object.freeze([...usage.fetchUrls].sort()) }),
    auditDigest: digest(input.auditDigest, "auditDigest"), qualityArtifactDigest: digest(input.qualityArtifactDigest, "qualityArtifactDigest") });
}

export function buildM5EExperimentReport({ planDigest, manifestDigest, referenceFamilySetDigest, arms, metrics }) {
  const normalized = arms.map(arm).sort((left, right) => ARMS.indexOf(left.armId) - ARMS.indexOf(right.armId));
  if (normalized.length !== 4 || normalized.some((item, index) => item.armId !== ARMS[index])) throw new TypeError("all four unique arms are required");
  const totals = normalized.reduce((sum, item) => ({ deepSeekAttempts: sum.deepSeekAttempts + item.usage.deepSeekAttempts,
    inputTokens: sum.inputTokens + item.usage.inputTokens, outputTokens: sum.outputTokens + item.usage.outputTokens,
    reasoningTokens: sum.reasoningTokens + item.usage.reasoningTokens, costMicrosCny: sum.costMicrosCny + item.usage.costMicrosCny,
    braveCalls: sum.braveCalls + item.usage.braveCalls, braveCostMicrosUsd: sum.braveCostMicrosUsd + item.usage.braveCostMicrosUsd,
    fetchUrls: [...new Set([...sum.fetchUrls, ...item.usage.fetchUrls])].sort() }),
  { deepSeekAttempts: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costMicrosCny: 0, braveCalls: 0, braveCostMicrosUsd: 0, fetchUrls: [] });
  if (totals.deepSeekAttempts > 310 || totals.costMicrosCny > 20_000_000 || totals.braveCalls > 50
    || totals.braveCostMicrosUsd > 250_000 || totals.fetchUrls.length > 30) throw new Error("M5E aggregate resource limit exceeded");
  const value = { schemaVersion: "m5e-experiment-report-v1", planDigest: digest(planDigest, "planDigest"),
    manifestDigest: digest(manifestDigest, "manifestDigest"), referenceFamilySetDigest: digest(referenceFamilySetDigest, "referenceFamilySetDigest"),
    arms: Object.freeze(normalized), totals: Object.freeze({ ...totals, fetchUrls: Object.freeze(totals.fetchUrls) }),
    metrics: Object.freeze(metrics), outcomes: summarizeM5EOutcomes(metrics) };
  return Object.freeze({ ...value, reportDigest: sha(value) });
}
