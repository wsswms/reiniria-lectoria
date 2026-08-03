import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { freezeReferenceFamilies } from "./evaluation.mjs";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const sha = (value) => `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
const text = (value, name, maximum = 2_048) => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new TypeError(`${name} is invalid`);
  return value;
};

function validateSeed(seed) {
  if (!seed || seed.schemaVersion !== "m5e-historical-reference-seed-v1" || seed.status !== "pending-human-adjudication"
    || !DIGEST.test(seed.sourceSetDigest) || !DIGEST.test(seed.seedDigest) || !Array.isArray(seed.families)) {
    throw new TypeError("historical reference seed is invalid");
  }
  const comparable = { ...seed }; delete comparable.seedDigest;
  if (sha(comparable) !== seed.seedDigest) throw new Error("historical reference seed integrity failed");
  if (new Set(seed.families.map((item) => item.familyId)).size !== seed.families.length) throw new TypeError("seed family identities must be unique");
}

function quotedSubject(description) {
  const matches = [...description.matchAll(/[「“"]([^」”"]{2,96})[」”"]/gu)].map((match) => match[1].normalize("NFKC").trim().toLocaleLowerCase("und"));
  return matches.length === 1 ? matches[0] : null;
}

function suggestion(item) {
  if (item.origin === "candidate" && item.description.startsWith("resolve ")) {
    return Object.freeze({ disposition: "exclude", reason: "local-detector-signal-not-independent-research-reference", mergeKey: null });
  }
  if (item.origin === "candidate" && ["medium", "low"].includes(item.impact)) {
    return Object.freeze({ disposition: "exclude", reason: "outside-critical-high-reference-scope", mergeKey: null });
  }
  const subject = item.origin === "candidate" ? quotedSubject(item.description) : null;
  const mergeKey = subject ? `${item.kind}\0${subject}` : null;
  return Object.freeze({ disposition: "include", reason: item.origin === "qa" ? "historical-final-qa-family" : "explicit-critical-high-research-question", mergeKey });
}

export function buildReferenceAdjudicationProposal(seed, { createdAt }) {
  validateSeed(seed); if (Number.isNaN(Date.parse(createdAt))) throw new TypeError("createdAt is invalid");
  const rows = seed.families.map((item) => Object.freeze({ sourceFamilyId: text(item.familyId, "familyId", 255), ...suggestion(item) }));
  const included = seed.families.filter((_, index) => rows[index].disposition === "include");
  const groups = new Map();
  for (const item of included) {
    const row = rows[seed.families.indexOf(item)];
    const key = row.mergeKey ?? `singleton\0${item.familyId}`; const group = groups.get(key) ?? [];
    group.push(item); groups.set(key, group);
  }
  const proposedFamilies = [...groups.entries()].map(([key, members]) => {
    const kind = members[0].kind; const impact = members.some((item) => item.impact === "critical") ? "critical" : "high";
    const memberIds = members.map((item) => item.familyId).sort();
    return Object.freeze({ familyId: `reference:${sha({ key, memberIds })}`, kind, impact,
      segmentIds: Object.freeze([...new Set(members.flatMap((item) => item.segmentIds))].sort()),
      description: members.map((item) => item.description).sort((left, right) => left.length - right.length || left.localeCompare(right))[0],
      sourceFamilyIds: Object.freeze(memberIds), mergeBasis: key.startsWith("singleton\0") ? "none" : "single-exact-quoted-subject" });
  }).sort((left, right) => left.familyId.localeCompare(right.familyId));
  const counts = Object.freeze({ seedFamilies: seed.families.length, suggestedIncluded: included.length,
    suggestedExcluded: rows.filter((item) => item.disposition === "exclude").length, proposedFamilies: proposedFamilies.length,
    proposedMerges: included.length - proposedFamilies.length });
  const core = { schemaVersion: "m5e-reference-adjudication-proposal-v1", status: "pending-user-confirmation",
    sourceSetDigest: seed.sourceSetDigest, seedDigest: seed.seedDigest, createdAt: new Date(createdAt).toISOString(), counts,
    decisions: Object.freeze(rows), proposedFamilies: Object.freeze(proposedFamilies) };
  return Object.freeze({ ...core, proposalDigest: sha(core) });
}

export function confirmReferenceAdjudication(proposal, { confirmedAt, confirmedBy }) {
  if (!proposal || proposal.schemaVersion !== "m5e-reference-adjudication-proposal-v1" || proposal.status !== "pending-user-confirmation"
    || !DIGEST.test(proposal.proposalDigest)) throw new TypeError("reference adjudication proposal is invalid");
  const comparable = { ...proposal }; delete comparable.proposalDigest;
  if (sha(comparable) !== proposal.proposalDigest) throw new Error("reference adjudication proposal integrity failed");
  if (confirmedBy?.type !== "user" || typeof confirmedBy.id !== "string" || confirmedBy.id.length === 0) {
    throw new Error("only a user can confirm the reference family set");
  }
  const frozen = freezeReferenceFamilies(proposal.proposedFamilies, { sourceSetDigest: proposal.sourceSetDigest, frozenAt: confirmedAt });
  const adjudicationMapping = proposal.proposedFamilies.map((item) => Object.freeze({ familyId: item.familyId,
    sourceFamilyIds: item.sourceFamilyIds, mergeBasis: item.mergeBasis })).sort((left, right) => left.familyId.localeCompare(right.familyId));
  return Object.freeze({ ...frozen, adjudicationProposalDigest: proposal.proposalDigest,
    adjudicationMapping: Object.freeze(adjudicationMapping), adjudicationMappingDigest: sha(adjudicationMapping),
    confirmedBy: Object.freeze({ type: "user", id: confirmedBy.id }) });
}
