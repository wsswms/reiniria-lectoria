import assert from "node:assert/strict";
import test from "node:test";
import { M5EExperimentCoordinator, createM5EExperimentPlan } from "../../src/m5e/experiment-coordinator.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const armResult = (armId) => ({ armId, funnelDigest: digest(armId.toLowerCase()[0]), auditDigest: digest("a"),
  sourceDigest: digest(armId.endsWith("1") ? "1" : "2"), candidateSetDigest: digest(armId.toLowerCase()[0]),
  plannerConfigDigest: digest("5"), referenceFamiliesInjected: false,
  knowledgeSnapshotDigest: digest("0"), providerAttempts: 1, braveCalls: 0, fetchUrls: [], qualityArtifactDigest: digest("9") });

function plan() {
  return createM5EExperimentPlan({ part1SourceDigest: digest("1"), part2SourceDigest: digest("2"),
    plannerConfigDigest: digest("5"), referenceFamilySetDigest: digest("6"), coldFactSetDigest: digest("0") });
}

test("four-arm coordinator enforces cold/enhanced ordering and the user approval checkpoint", () => {
  const flow = new M5EExperimentCoordinator(plan(), { now: () => new Date(0) });
  assert.equal(flow.next().action, "run-arm"); assert.equal(flow.next().armId, "C1");
  flow.completeArm(armResult("C1")); flow.completeArm(armResult("E1"));
  assert.equal(flow.next().action, "await-user-knowledge-approval");
  assert.throws(() => flow.recordPart1KnowledgeCheckpoint({}, { type: "model", id: "planner" }), /only a user/);
  const checkpoint = flow.recordPart1KnowledgeCheckpoint({ warmFactSetDigest: digest("f"), applications: [{
    clusterId: "cluster-1", proposalId: "proposal-1", factId: "fact-1", revisionId: "revision-1", contentDigest: digest("d"), applied: true,
  }] }, { type: "user", id: "owner" });
  assert.equal(checkpoint.applications.length, 1);
  flow.completeArm(armResult("C2"));
  assert.throws(() => flow.completeArm({ ...armResult("E2"), knowledgeSnapshotDigest: digest("e"), retrievalBindings: [] }), /warm fact set/);
  flow.completeArm({ ...armResult("E2"), knowledgeSnapshotDigest: digest("f"), retrievalBindings: [{
    clusterId: "cluster-1", factId: "fact-1", revisionId: "revision-1", contentDigest: digest("d"), retrieverVersion: "fts-v1",
  }] });
  assert.equal(flow.next().action, "complete");
  assert.equal(flow.manifest().arms.length, 4);
});

test("cold arms cannot claim warm knowledge and E2 cannot forge retrieval lineage", () => {
  const flow = new M5EExperimentCoordinator(plan());
  assert.throws(() => flow.completeArm({ ...armResult("C1"), knowledgeSnapshotDigest: digest("f") }), /cold fact set/);
  flow.completeArm(armResult("C1")); flow.completeArm(armResult("E1"));
  flow.recordPart1KnowledgeCheckpoint({ warmFactSetDigest: digest("f"), applications: [{ clusterId: "cluster-1",
    proposalId: "proposal-1", factId: "fact-1", revisionId: "revision-1", contentDigest: digest("d"), applied: true }] }, { type: "user", id: "owner" });
  flow.completeArm(armResult("C2"));
  assert.throws(() => flow.completeArm({ ...armResult("E2"), knowledgeSnapshotDigest: digest("f"), retrievalBindings: [{
    clusterId: "cluster-1", factId: "forged", revisionId: "revision-1", contentDigest: digest("d"), retrieverVersion: "fts-v1",
  }] }), /applied knowledge/);
});

test("every arm reruns Planner and may produce a different candidate set without changing the frozen Planner configuration", () => {
  const flow = new M5EExperimentCoordinator(plan());
  flow.completeArm({ ...armResult("C1"), candidateSetDigest: digest("7") });
  flow.completeArm({ ...armResult("E1"), candidateSetDigest: digest("8") });
  assert.notEqual(flow.manifest().arms[0].candidateSetDigest, flow.manifest().arms[1].candidateSetDigest);
  assert.throws(() => new M5EExperimentCoordinator(plan()).completeArm({ ...armResult("C1"), plannerConfigDigest: digest("7") }), /Planner configuration/);
  assert.throws(() => new M5EExperimentCoordinator(plan()).completeArm({ ...armResult("C1"), referenceFamiliesInjected: true }), /reference families/);
});

test("arms cannot drift from their frozen source", () => {
  const flow = new M5EExperimentCoordinator(plan());
  assert.throws(() => flow.completeArm({ ...armResult("C1"), sourceDigest: digest("2") }), /source/);
});
