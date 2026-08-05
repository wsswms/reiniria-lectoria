import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const FACT_KINDS = new Set(["term", "style", "knowledge"]);
const sha = (value) => `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;

function text(value, name, maximum = 1_024) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

function application(input) {
  if (!input || input.applied !== true || !FACT_KINDS.has(input.factKind) || !DIGEST.test(input.contentDigest)) {
    throw new TypeError("applied knowledge lineage is invalid");
  }
  return Object.freeze({ clusterId: text(input.clusterId, "clusterId", 255), proposalId: text(input.proposalId, "proposalId", 255),
    factId: text(input.factId, "factId", 255), revisionId: text(input.revisionId, "revisionId", 255),
    contentDigest: input.contentDigest, retrievalQuery: text(input.retrievalQuery, "retrievalQuery"), factKind: input.factKind, applied: true });
}

export function probeAppliedKnowledgeReuse({ clusters, applications, retriever, expectedFactSetDigest, language, targetLanguage, tags = [], documentIds = [] }) {
  if (!Array.isArray(clusters) || !Array.isArray(applications) || applications.length > 4_096 || !retriever
    || typeof retriever.manifest !== "function" || typeof retriever.search !== "function") throw new TypeError("reuse probe input is invalid");
  if (!DIGEST.test(expectedFactSetDigest)) throw new TypeError("expectedFactSetDigest is invalid");
  text(language, "language", 63); text(targetLanguage, "targetLanguage", 63);
  const manifest = retriever.manifest();
  if (manifest.factSetDigest !== expectedFactSetDigest) throw new Error("persistent knowledge snapshot mismatch");
  const clusterIds = new Set(clusters.map((item) => text(item.clusterId, "clusterId", 255)));
  const normalized = applications.map(application).sort((left, right) => left.clusterId.localeCompare(right.clusterId));
  if (new Set(normalized.map((item) => item.clusterId)).size !== normalized.length) throw new TypeError("one application per cluster is required");
  const bindings = []; const misses = [];
  for (const item of normalized) {
    if (!clusterIds.has(item.clusterId)) throw new TypeError("application references an unknown cluster");
    const hits = retriever.search({ query: item.retrievalQuery, language, kinds: [item.factKind], tags, documentIds, topK: 50 });
    const exact = hits.find((hit) => hit.factId === item.factId && hit.revisionId === item.revisionId && hit.contentDigest === item.contentDigest);
    if (!exact) {
      misses.push(Object.freeze({ clusterId: item.clusterId, proposalId: item.proposalId, reason: "lineage-mismatch",
        returnedHitCount: hits.length }));
      continue;
    }
    bindings.push(Object.freeze({ clusterId: item.clusterId, factId: exact.factId, revisionId: exact.revisionId,
      contentDigest: exact.contentDigest, retrieverVersion: exact.retrieverVersion, exact: true }));
  }
  const value = { schemaVersion: "m5e-persistent-reuse-probe-v1", factSetDigest: manifest.factSetDigest,
    targetLanguage, bindings: Object.freeze(bindings), misses: Object.freeze(misses) };
  return Object.freeze({ ...value, probeDigest: sha(value) });
}
