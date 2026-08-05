import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";

const IMPACTS = new Set(["critical", "high", "medium", "low"]);
const KINDS = new Set(["term", "entity", "fact", "relation", "style", "measurement"]);
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const sha = (value) => `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
const text = (value, name, maximum = 65_536) => { if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new TypeError(`${name} is invalid`); return value; };

export function freezeReferenceFamilies(families, { sourceSetDigest, frozenAt }) {
  if (!DIGEST.test(sourceSetDigest) || Number.isNaN(Date.parse(frozenAt))) throw new TypeError("reference freeze metadata is invalid");
  if (!Array.isArray(families) || families.length < 1 || families.length > 4_096) throw new TypeError("reference families must be bounded");
  const normalized = families.map((item) => {
    if (!KINDS.has(item.kind) || !IMPACTS.has(item.impact) || !Array.isArray(item.segmentIds) || item.segmentIds.length < 1) throw new TypeError("reference family is invalid");
    return Object.freeze({ familyId: text(item.familyId, "familyId", 255), kind: item.kind, impact: item.impact,
      segmentIds: Object.freeze([...new Set(item.segmentIds.map((value) => text(value, "segmentId", 255)))].sort()),
      description: text(item.description, "description", 2_048) });
  }).sort((left, right) => left.familyId.localeCompare(right.familyId));
  if (new Set(normalized.map((item) => item.familyId)).size !== normalized.length) throw new TypeError("reference family identities must be unique");
  const value = { schemaVersion: "m5e-reference-family-set-v1", sourceSetDigest, frozenAt: new Date(frozenAt).toISOString(), families: normalized };
  return Object.freeze({ ...value, familySetDigest: sha(value) });
}

export function createBlindReviewPackage(pairs, { seed, referenceFamilySetDigest }) {
  text(seed, "seed", 255); if (!DIGEST.test(referenceFamilySetDigest)) throw new TypeError("referenceFamilySetDigest is invalid");
  if (!Array.isArray(pairs) || pairs.length < 1 || pairs.length > 4_096) throw new TypeError("review pairs must be bounded");
  const samples = []; const answerKey = [];
  for (const pair of [...pairs].sort((left, right) => left.pairId.localeCompare(right.pairId))) {
    const pairId = text(pair.pairId, "pairId", 255); const flip = createHash("sha256").update(`${seed}\0${pairId}`).digest()[0] % 2 === 1;
    const first = flip ? pair.enhancedText : pair.coldText; const second = flip ? pair.coldText : pair.enhancedText;
    samples.push(Object.freeze({ sampleId: sha({ referenceFamilySetDigest, pairId }), pairId, segmentId: text(pair.segmentId, "segmentId", 255),
      sourceText: text(pair.sourceText, "sourceText"), candidates: Object.freeze([{ label: "A", text: text(first, "candidate") }, { label: "B", text: text(second, "candidate") }]) }));
    answerKey.push(Object.freeze({ pairId, enhancedLabel: flip ? "A" : "B" }));
  }
  const review = { schemaVersion: "m5e-blind-review-v1", referenceFamilySetDigest, samples: Object.freeze(samples) };
  const reviewPackage = Object.freeze({ ...review, reviewDigest: sha(review) });
  const sealedAnswerKey = Object.freeze({ schemaVersion: "m5e-blind-answer-key-v1", referenceFamilySetDigest,
    assignments: Object.freeze(answerKey), answerKeyDigest: sha(answerKey) });
  return Object.freeze({ reviewPackage, answerKey: sealedAnswerKey });
}

export function summarizeM5EOutcomes({ candidate, translation, reuse }) {
  const candidateGo = candidate.criticalCoverage === 1 && candidate.highCoverage >= 0.95 && candidate.criticalHighWrongMerges === 0
    && candidate.overallWrongMergeRate <= 0.02 && candidate.residualDuplicateRate <= 0.05 && candidate.compressionRate >= 0.5;
  const translationGo = translation.knowledgeErrorReduction >= 0.3 && translation.terminologyErrorReduction >= 0.5
    && translation.criticalFactualEscapes === 0 && translation.blockingIncrease <= 0 && translation.enhancedWinRate > 0.6;
  const reuseGo = reuse.actionableReduction >= 0.3 && reuse.sharedFamilyReduction >= 0.5 && reuse.resourceRatio <= 0.7
    && reuse.hitPrecision >= 0.95 && reuse.coveragePreserved === true && reuse.qualityPreserved === true;
  return Object.freeze({ candidatePruning: candidateGo ? "go" : "no-go", translationQuality: translationGo ? "go" : "no-go",
    crossArticleReuse: reuseGo ? "go" : "no-go" });
}
