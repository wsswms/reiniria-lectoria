import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { buildKnowledgeNeedFunnel } from "./knowledge-need-cluster.mjs";
import { observePlanKnowledgeNeeds, observeTranslationKnowledgeNeeds } from "./observation-adapter.mjs";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const sha = (value) => `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;

function qaKind(code) {
  if (/terminolog|product-name|transliterat|species-name/u.test(code)) return "term";
  if (/number|measurement|unit|date/u.test(code)) return "measurement";
  if (/causal|negation|relation|reference/u.test(code)) return "relation";
  if (/style|quality|typograph/u.test(code)) return "style";
  return "fact";
}

function qaImpact(severity) {
  if (severity === "error" || severity === "blocking") return "critical";
  if (severity === "warning") return "high";
  if (severity === "info") return "medium";
  throw new TypeError("QA finding severity is invalid");
}

export function buildHistoricalReferenceSeed(articles) {
  if (!Array.isArray(articles) || articles.length < 1 || articles.length > 16) throw new TypeError("historical articles are invalid");
  const observations = []; const qaGroups = new Map(); const sourceDigests = [];
  for (const article of [...articles].sort((left, right) => left.articleId.localeCompare(right.articleId))) {
    if (typeof article.articleId !== "string" || !DIGEST.test(article.sourceDigest)) throw new TypeError("historical article identity is invalid");
    sourceDigests.push(Object.freeze({ articleId: article.articleId, sourceDigest: article.sourceDigest }));
    for (const item of observePlanKnowledgeNeeds(article.planner)) observations.push(Object.freeze({ ...item, needId: `${article.articleId}:${item.needId}` }));
    for (const attempt of article.translationAttempts ?? []) for (const item of observeTranslationKnowledgeNeeds(attempt, attempt.needs)) {
      observations.push(Object.freeze({ ...item, needId: `${article.articleId}:${item.needId}` }));
    }
    for (const finding of article.qaFindings ?? []) {
      const identity = { articleId: article.articleId, code: finding.code, details: finding.details ?? {} };
      const key = stableJson(identity); const group = qaGroups.get(key) ?? { identity, severity: finding.severity, segmentIds: [] };
      group.segmentIds.push(finding.segmentId); qaGroups.set(key, group);
    }
  }
  const funnel = buildKnowledgeNeedFunnel(observations); const families = funnel.clusters.map((item) => Object.freeze({
    familyId: `candidate:${item.clusterId}`, origin: "candidate", kind: item.kind, impact: item.impact,
    segmentIds: item.relatedSegmentIds, description: item.representativeQuestion,
  }));
  for (const { identity, severity, segmentIds } of qaGroups.values()) families.push(Object.freeze({
    familyId: `qa:${sha(identity)}`, origin: "qa", kind: qaKind(identity.code), impact: qaImpact(severity),
    segmentIds: Object.freeze([...new Set(segmentIds)].sort()), description: `${identity.code}: ${stableJson(identity.details)}`.slice(0, 2_048),
  }));
  families.sort((left, right) => left.familyId.localeCompare(right.familyId));
  const value = { schemaVersion: "m5e-historical-reference-seed-v1", status: "pending-human-adjudication",
    sourceSetDigest: sha(sourceDigests), counts: Object.freeze({ ...funnel.counts, qaFindings: [...qaGroups.values()].reduce((sum, item) => sum + item.segmentIds.length, 0),
      qaFamilies: qaGroups.size, totalSeedFamilies: families.length }), mappingDigest: funnel.mappingDigest, families: Object.freeze(families) };
  return Object.freeze({ ...value, seedDigest: sha(value) });
}
