import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";

const IMPACT_RANK = Object.freeze({ critical: 4, high: 3, medium: 2, low: 1 });
const sha = (value) => `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;

function ratio(covered, total) { return total === 0 ? 1 : covered / total; }

export function planCoverageDrivenResearch(funnel, { remainingResearchRequests, sharedCanonicalKeys = [], coreClusterIds = [] }) {
  if (!funnel || !Array.isArray(funnel.clusters) || !Number.isSafeInteger(remainingResearchRequests)
    || remainingResearchRequests < 0 || remainingResearchRequests > 50) throw new TypeError("research queue input is invalid");
  const shared = new Set(sharedCanonicalKeys); const core = new Set(coreClusterIds);
  const actionable = funnel.clusters.filter((item) => item.resolution === "actionable-research").sort((left, right) => {
    const impact = IMPACT_RANK[right.impact] - IMPACT_RANK[left.impact]; if (impact !== 0) return impact;
    const coreRank = Number(core.has(right.clusterId)) - Number(core.has(left.clusterId)); if (coreRank !== 0) return coreRank;
    const sharedRank = Number(shared.has(right.canonicalKey)) - Number(shared.has(left.canonicalKey)); if (sharedRank !== 0) return sharedRank;
    const segments = right.relatedSegmentIds.length - left.relatedSegmentIds.length; if (segments !== 0) return segments;
    const occurrences = right.memberNeedIds.length - left.memberNeedIds.length; if (occurrences !== 0) return occurrences;
    return left.clusterId.localeCompare(right.clusterId);
  });
  const selectedIds = new Set(actionable.slice(0, remainingResearchRequests).map((item) => item.clusterId));
  const queue = actionable.filter((item) => selectedIds.has(item.clusterId)).map((item, index) => Object.freeze({ ordinal: index + 1,
    clusterId: item.clusterId, canonicalKey: item.canonicalKey, kind: item.kind, impact: item.impact,
    relatedSegmentIds: Object.freeze([...item.relatedSegmentIds]), occurrenceCount: item.memberNeedIds.length,
    sharedAcrossArticles: shared.has(item.canonicalKey), core: core.has(item.clusterId) }));
  const deferred = funnel.clusters.filter((item) => item.resolution === "actionable-research" && !selectedIds.has(item.clusterId)
    || !["actionable-research", "persisted-knowledge", "user-guidance", "accepted-risk"].includes(item.resolution))
    .map((item) => Object.freeze({ clusterId: item.clusterId, kind: item.kind, impact: item.impact,
      reason: item.resolution === "actionable-research" ? "resource-capacity" : item.resolution }));
  const totals = Object.fromEntries(["critical", "high"].map((impact) => [impact, funnel.clusters.filter((item) => item.impact === impact).length]));
  const covered = Object.fromEntries(["critical", "high"].map((impact) => [impact, funnel.clusters.filter((item) => item.impact === impact
    && (item.resolution !== "actionable-research" || selectedIds.has(item.clusterId))).length]));
  const coverageCapacity = Object.freeze({ critical: ratio(covered.critical, totals.critical), high: ratio(covered.high, totals.high) });
  const blockers = []; if (coverageCapacity.critical < 1) blockers.push("critical-coverage-capacity"); if (coverageCapacity.high < 0.95) blockers.push("high-coverage-capacity");
  const value = { schemaVersion: "m5e-coverage-driven-research-v1", remainingResearchRequests,
    queue: Object.freeze(queue), deferred: Object.freeze(deferred), coverageCapacity,
    gate: Object.freeze({ status: blockers.length ? "closed" : "ready", blockers: Object.freeze(blockers), evidenceCoverageEstablished: false }) };
  return Object.freeze({ ...value, queueDigest: sha(value) });
}
