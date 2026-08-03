import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";

export const M5E_FUNNEL_VERSION = "m5e-knowledge-need-funnel-v1";

const KINDS = new Set(["term", "entity", "fact", "relation", "style", "measurement"]);
const IMPACTS = new Set(["critical", "high", "medium", "low"]);
const IMPACT_RANK = Object.freeze({ critical: 4, high: 3, medium: 2, low: 1 });
const DECISIONS = new Set(["research", "guidance", "proceed-with-risk"]);
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

const sha = (value) => `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;

function boundedString(value, name, maximum = 4_096) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) throw new TypeError(`${name} must be a bounded non-empty string`);
  return value;
}

function normalizeText(value) {
  return boundedString(String(value), "semantic text").normalize("NFKC").toLocaleLowerCase("und").trim()
    .replace(/\s+/gu, " ").replace(/\s+([,.;:!?])/gu, "$1");
}

function normalizeValue(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return normalizeText(String(value));
  if (Array.isArray(value)) return value.map(normalizeValue).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeValue(value[key])]));
  throw new TypeError("semantic values must be strings, numbers, booleans, arrays, or objects");
}

function rawNeed(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("knowledge need must be an object");
  const needId = boundedString(input.needId, "needId", 255);
  if (!KINDS.has(input.kind)) throw new TypeError("knowledge need kind is invalid");
  if (!IMPACTS.has(input.impact)) throw new TypeError("knowledge need impact is invalid");
  if (!Array.isArray(input.relatedSegmentIds) || input.relatedSegmentIds.length < 1 || input.relatedSegmentIds.length > 128) {
    throw new TypeError("relatedSegmentIds must be a bounded non-empty array");
  }
  const relatedSegmentIds = [...new Set(input.relatedSegmentIds.map((item) => boundedString(item, "segmentId", 255)))].sort();
  const semantic = input.semantic === undefined ? null : normalizeValue(input.semantic);
  return Object.freeze({ needId, originType: boundedString(input.originType, "originType", 63),
    originId: boundedString(input.originId, "originId", 255), kind: input.kind, impact: input.impact,
    question: boundedString(input.question, "question", 4_096), normalizedQuestion: normalizeText(input.question),
    relatedSegmentIds: Object.freeze(relatedSegmentIds), semantic: semantic && Object.freeze(semantic) });
}

function aliasTable(input) {
  if (!Array.isArray(input) || input.length > 4_096) throw new TypeError("aliases must be a bounded array");
  const output = new Map();
  for (const item of input) {
    if (!item || !["term", "entity"].includes(item.kind) || item.approvedBy?.type !== "user"
      || typeof item.approvedBy.id !== "string" || item.approvedBy.id.length === 0) throw new TypeError("aliases must be user-approved term or entity aliases");
    const alias = normalizeText(item.alias); const canonical = normalizeText(item.canonical); const key = `${item.kind}\0${alias}`;
    const prior = output.get(key); if (prior && prior !== canonical) throw new TypeError("approved aliases conflict");
    output.set(key, canonical);
  }
  return output;
}

function candidateIdentity(need) {
  return Object.freeze({ kind: need.kind, question: need.normalizedQuestion, semantic: need.semantic });
}

function clusterIdentity(candidate, aliases) {
  if (!candidate.semantic || !["term", "entity"].includes(candidate.kind)) return candidateIdentity(candidate);
  const semantic = { ...candidate.semantic };
  const field = typeof semantic.surface === "string" ? "surface" : typeof semantic.name === "string" ? "name"
    : typeof semantic.term === "string" ? "term" : typeof semantic.value === "string" ? "value" : null;
  if (!field) return candidateIdentity(candidate);
  semantic[field] = aliases.get(`${candidate.kind}\0${semantic[field]}`) ?? semantic[field];
  return Object.freeze({ kind: candidate.kind, semantic: Object.freeze(semantic) });
}

function resolution(clusterId, impact, bindings, dispositions) {
  const binding = bindings.get(clusterId);
  if (binding) return Object.freeze({ resolution: "persisted-knowledge", binding });
  const disposition = dispositions.get(clusterId);
  if (disposition?.decision === "guidance") return Object.freeze({ resolution: "user-guidance", disposition });
  if (disposition?.decision === "proceed-with-risk") return Object.freeze({ resolution: "accepted-risk", disposition });
  if (disposition?.decision === "research" || ["critical", "high"].includes(impact)) return Object.freeze({ resolution: "actionable-research", disposition: disposition ?? null });
  return Object.freeze({ resolution: "deferred-low-impact", disposition: disposition ?? null });
}

function bindingTable(input) {
  if (!Array.isArray(input) || input.length > 4_096) throw new TypeError("knowledgeBindings must be a bounded array");
  const output = new Map();
  for (const item of input) {
    if (!item || item.exact !== true || !DIGEST.test(item.contentDigest) || typeof item.clusterId !== "string"
      || typeof item.factId !== "string" || typeof item.revisionId !== "string" || typeof item.retrieverVersion !== "string") {
      throw new TypeError("persisted knowledge bindings must be exact and revision-bound");
    }
    if (output.has(item.clusterId)) throw new TypeError("persisted knowledge bindings must be unique");
    output.set(item.clusterId, Object.freeze({ ...item }));
  }
  return output;
}

function dispositionTable(input) {
  if (!Array.isArray(input) || input.length > 4_096) throw new TypeError("dispositions must be a bounded array");
  const output = new Map();
  for (const item of input) {
    if (!item || !DECISIONS.has(item.decision) || item.decidedBy?.type !== "user" || typeof item.decidedBy.id !== "string") {
      throw new TypeError("cluster dispositions must be user decisions");
    }
    if (output.has(item.clusterId)) throw new TypeError("cluster dispositions must be unique");
    output.set(item.clusterId, Object.freeze({ ...item }));
  }
  return output;
}

export function buildKnowledgeNeedFunnel(needs, { aliases = [], knowledgeBindings = [], dispositions = [] } = {}) {
  if (!Array.isArray(needs) || needs.length > 16_384) throw new TypeError("knowledge needs must be a bounded array");
  const normalized = needs.map(rawNeed).sort((left, right) => left.needId.localeCompare(right.needId));
  if (new Set(normalized.map((item) => item.needId)).size !== normalized.length) throw new TypeError("knowledge need identities must be unique");
  const approvedAliases = aliasTable(aliases); const bindings = bindingTable(knowledgeBindings); const decisions = dispositionTable(dispositions);

  const candidateGroups = new Map();
  for (const item of normalized) {
    const identity = candidateIdentity(item); const key = stableJson(identity); const group = candidateGroups.get(key) ?? { identity, members: [] };
    group.members.push(item); candidateGroups.set(key, group);
  }
  const canonicalCandidates = [...candidateGroups.values()].map(({ identity, members }) => {
    const memberNeedIds = members.map((item) => item.needId).sort();
    return Object.freeze({ candidateId: sha({ type: "canonical-candidate", identity }), kind: identity.kind,
      normalizedQuestion: [...new Set(members.map((item) => item.normalizedQuestion))].sort()[0], semantic: identity.semantic,
      impact: members.map((item) => item.impact).sort((left, right) => IMPACT_RANK[right] - IMPACT_RANK[left])[0],
      memberNeedIds: Object.freeze(memberNeedIds), origins: Object.freeze(members.map((item) => `${item.originType}:${item.originId}`).sort()),
      relatedSegmentIds: Object.freeze([...new Set(members.flatMap((item) => item.relatedSegmentIds))].sort()) });
  }).sort((left, right) => left.candidateId.localeCompare(right.candidateId));

  const clusterGroups = new Map();
  for (const candidate of canonicalCandidates) {
    const identity = clusterIdentity(candidate, approvedAliases); const key = stableJson(identity); const group = clusterGroups.get(key) ?? { identity, members: [] };
    group.members.push(candidate); clusterGroups.set(key, group);
  }
  const clusters = [...clusterGroups.values()].map(({ identity, members }) => {
    const clusterId = sha({ type: "knowledge-need-cluster", identity });
    const impact = members.map((item) => item.impact).sort((left, right) => IMPACT_RANK[right] - IMPACT_RANK[left])[0];
    const status = resolution(clusterId, impact, bindings, decisions);
    return Object.freeze({ clusterId, kind: identity.kind, canonicalKey: stableJson(identity), impact,
      representativeQuestion: members.map((item) => item.normalizedQuestion).sort()[0], semantic: identity.semantic ?? null,
      memberCandidateIds: Object.freeze(members.map((item) => item.candidateId).sort()),
      memberNeedIds: Object.freeze([...new Set(members.flatMap((item) => item.memberNeedIds))].sort()),
      origins: Object.freeze([...new Set(members.flatMap((item) => item.origins))].sort()),
      relatedSegmentIds: Object.freeze([...new Set(members.flatMap((item) => item.relatedSegmentIds))].sort()), ...status });
  }).sort((left, right) => left.clusterId.localeCompare(right.clusterId));
  for (const clusterId of [...bindings.keys(), ...decisions.keys()]) if (!clusters.some((item) => item.clusterId === clusterId)) {
    throw new TypeError("cluster resolution references an unknown cluster");
  }
  const actionableResearch = clusters.filter((item) => item.resolution === "actionable-research").length;
  return Object.freeze({ schemaVersion: M5E_FUNNEL_VERSION,
    counts: Object.freeze({ rawOccurrences: normalized.length, canonicalCandidates: canonicalCandidates.length, clusters: clusters.length, actionableResearch }),
    canonicalCandidates: Object.freeze(canonicalCandidates), clusters: Object.freeze(clusters),
    mappingDigest: sha({ candidates: canonicalCandidates, clusters }) });
}

export function candidateSetDigest(funnel) {
  if (!funnel || funnel.schemaVersion !== M5E_FUNNEL_VERSION || !Array.isArray(funnel.clusters)) throw new TypeError("knowledge need funnel is invalid");
  const semanticSet = funnel.clusters.map((item) => ({ canonicalKey: boundedString(item.canonicalKey, "canonicalKey"),
    kind: item.kind, impact: item.impact, occurrenceCount: item.memberNeedIds.length, relatedSegmentCount: item.relatedSegmentIds.length }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  return sha({ schemaVersion: "m5e-candidate-set-v1", semanticSet });
}
