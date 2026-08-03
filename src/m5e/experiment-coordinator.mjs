import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";

export const M5E_ARM_ORDER = Object.freeze(["C1", "E1", "C2", "E2"]);
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

const sha = (value) => `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;

function digest(value, name) { if (!DIGEST.test(value)) throw new TypeError(`${name} must be a sha256 digest`); return value; }
function string(value, name) { if (typeof value !== "string" || value.length === 0 || value.length > 255) throw new TypeError(`${name} is invalid`); return value; }

export function createM5EExperimentPlan(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("experiment plan is invalid");
  const plan = Object.freeze({ schemaVersion: "m5e-experiment-plan-v2",
    part1SourceDigest: digest(input.part1SourceDigest, "part1SourceDigest"), part2SourceDigest: digest(input.part2SourceDigest, "part2SourceDigest"),
    plannerConfigDigest: digest(input.plannerConfigDigest, "plannerConfigDigest"),
    referenceFamilySetDigest: digest(input.referenceFamilySetDigest, "referenceFamilySetDigest"),
    coldFactSetDigest: digest(input.coldFactSetDigest, "coldFactSetDigest"),
    arms: Object.freeze([
      Object.freeze({ armId: "C1", article: "part1", knowledgeMode: "cold", externalResearch: false }),
      Object.freeze({ armId: "E1", article: "part1", knowledgeMode: "enhanced-temporary", externalResearch: true }),
      Object.freeze({ armId: "C2", article: "part2", knowledgeMode: "cold-counterfactual", externalResearch: false }),
      Object.freeze({ armId: "E2", article: "part2", knowledgeMode: "warm-persisted", externalResearch: true }),
    ]) });
  return Object.freeze({ ...plan, planDigest: sha(plan) });
}

function application(input) {
  if (!input || input.applied !== true) throw new TypeError("knowledge applications must be applied");
  return Object.freeze({ clusterId: string(input.clusterId, "clusterId"), proposalId: string(input.proposalId, "proposalId"),
    factId: string(input.factId, "factId"), revisionId: string(input.revisionId, "revisionId"),
    contentDigest: digest(input.contentDigest, "contentDigest"), applied: true });
}

function armResult(input) {
  if (!input || !M5E_ARM_ORDER.includes(input.armId)) throw new TypeError("arm result is invalid");
  if (!Number.isSafeInteger(input.providerAttempts) || input.providerAttempts < 0 || input.providerAttempts > 310) throw new TypeError("providerAttempts is invalid");
  if (!Number.isSafeInteger(input.braveCalls) || input.braveCalls < 0 || input.braveCalls > 50) throw new TypeError("braveCalls is invalid");
  if (!Array.isArray(input.fetchUrls) || input.fetchUrls.length > 30 || new Set(input.fetchUrls).size !== input.fetchUrls.length) throw new TypeError("fetchUrls is invalid");
  if (typeof input.referenceFamiliesInjected !== "boolean") throw new TypeError("referenceFamiliesInjected is invalid");
  return Object.freeze({ armId: input.armId, funnelDigest: digest(input.funnelDigest, "funnelDigest"), auditDigest: digest(input.auditDigest, "auditDigest"),
    sourceDigest: digest(input.sourceDigest, "sourceDigest"), candidateSetDigest: digest(input.candidateSetDigest, "candidateSetDigest"),
    plannerConfigDigest: digest(input.plannerConfigDigest, "plannerConfigDigest"), referenceFamiliesInjected: input.referenceFamiliesInjected,
    qualityArtifactDigest: digest(input.qualityArtifactDigest, "qualityArtifactDigest"), providerAttempts: input.providerAttempts,
    braveCalls: input.braveCalls, fetchUrls: Object.freeze([...input.fetchUrls].sort()),
    knowledgeSnapshotDigest: digest(input.knowledgeSnapshotDigest, "knowledgeSnapshotDigest"),
    retrievalBindings: Object.freeze((input.retrievalBindings ?? []).map((item) => Object.freeze({ clusterId: string(item.clusterId, "clusterId"),
      factId: string(item.factId, "factId"), revisionId: string(item.revisionId, "revisionId"), contentDigest: digest(item.contentDigest, "contentDigest"),
      retrieverVersion: string(item.retrieverVersion, "retrieverVersion") }))) });
}

export class M5EExperimentCoordinator {
  constructor(plan, { now = () => new Date() } = {}) {
    const comparable = plan && { ...plan }; if (comparable) delete comparable.planDigest;
    if (!plan || plan.schemaVersion !== "m5e-experiment-plan-v2" || plan.planDigest !== sha(comparable)) throw new TypeError("experiment plan integrity failed");
    this.plan = plan; this.now = now; this.results = []; this.checkpoint = null;
  }

  next() {
    if (this.results.length === 2 && !this.checkpoint) return Object.freeze({ action: "await-user-knowledge-approval" });
    if (this.results.length >= M5E_ARM_ORDER.length) return Object.freeze({ action: "complete" });
    return Object.freeze({ action: "run-arm", armId: M5E_ARM_ORDER[this.results.length] });
  }

  completeArm(input) {
    const result = armResult(input); const expected = M5E_ARM_ORDER[this.results.length];
    if (result.armId !== expected) throw new Error(`expected arm ${expected}`);
    if (result.armId === "E2" && !this.checkpoint) throw new Error("Part1 knowledge checkpoint is required");
    const part1 = ["C1", "E1"].includes(result.armId);
    if (result.sourceDigest !== (part1 ? this.plan.part1SourceDigest : this.plan.part2SourceDigest)) throw new Error("arm source does not match the experiment plan");
    if (result.plannerConfigDigest !== this.plan.plannerConfigDigest) throw new Error("arm Planner configuration does not match the experiment plan");
    if (result.referenceFamiliesInjected) throw new Error("reference families must not be injected into Planner input");
    const expectedSnapshot = result.armId === "E2" ? this.checkpoint.warmFactSetDigest : this.plan.coldFactSetDigest;
    if (result.knowledgeSnapshotDigest !== expectedSnapshot) {
      throw new Error(result.armId === "E2" ? "E2 must use the warm fact set" : "cold arms must use the cold fact set");
    }
    if (result.armId !== "E2" && result.retrievalBindings.length > 0) throw new Error("only E2 may claim persisted knowledge retrieval");
    if (result.armId === "E2") for (const binding of result.retrievalBindings) {
      const exact = this.checkpoint.applications.some((item) => item.clusterId === binding.clusterId && item.factId === binding.factId
        && item.revisionId === binding.revisionId && item.contentDigest === binding.contentDigest);
      if (!exact) throw new Error("E2 retrieval lineage does not match applied knowledge");
    }
    this.results.push(Object.freeze({ ...result, completedAt: this.now().toISOString() }));
    return this.manifest();
  }

  recordPart1KnowledgeCheckpoint(input, actor) {
    if (actor?.type !== "user" || typeof actor.id !== "string" || actor.id.length === 0) throw new Error("only a user can record the Part1 knowledge checkpoint");
    if (this.results.length !== 2 || this.checkpoint) throw new Error("Part1 checkpoint is not available");
    const applications = (input.applications ?? []).map(application).sort((left, right) => left.clusterId.localeCompare(right.clusterId));
    if (applications.length < 1 || new Set(applications.map((item) => item.clusterId)).size !== applications.length) throw new TypeError("Part1 applications must be non-empty and unique");
    const warmFactSetDigest = digest(input.warmFactSetDigest, "warmFactSetDigest");
    if (warmFactSetDigest === this.plan.coldFactSetDigest) throw new Error("warm fact set must differ from cold fact set");
    this.checkpoint = Object.freeze({ warmFactSetDigest, applications: Object.freeze(applications), approvedBy: actor.id,
      recordedAt: this.now().toISOString(), checkpointDigest: sha({ warmFactSetDigest, applications }) });
    return this.checkpoint;
  }

  manifest() {
    const value = { schemaVersion: "m5e-experiment-manifest-v1", planDigest: this.plan.planDigest,
      arms: this.results, knowledgeCheckpoint: this.checkpoint, next: this.next() };
    return Object.freeze({ ...value, manifestDigest: sha(value) });
  }
}
