import assert from "node:assert/strict";
import test from "node:test";
import { planCoverageDrivenResearch } from "../../src/m5e/research-queue.mjs";

const cluster = (id, impact, overrides = {}) => ({ clusterId: id, canonicalKey: `key-${id}`, kind: "term", impact,
  resolution: "actionable-research", memberNeedIds: [`need-${id}`], relatedSegmentIds: [`segment-${id}`], ...overrides });

test("research queue is coverage-driven and prioritizes critical, shared and high-occurrence clusters", () => {
  const clusters = [cluster("critical", "critical"), cluster("ordinary", "high"),
    cluster("shared", "high", { canonicalKey: "shared-key", memberNeedIds: ["n1", "n2"], relatedSegmentIds: ["s1", "s2", "s3"] }),
    cluster("medium", "medium")];
  const result = planCoverageDrivenResearch({ clusters }, { remainingResearchRequests: 3, sharedCanonicalKeys: ["shared-key"] });
  assert.deepEqual(result.queue.map((item) => item.clusterId), ["critical", "shared", "ordinary"]);
  assert.equal(result.gate.status, "ready"); assert.equal(result.coverageCapacity.critical, 1); assert.equal(result.coverageCapacity.high, 1);
  assert.equal(result.gate.evidenceCoverageEstablished, false);
  assert.equal(result.deferred[0].clusterId, "medium");
});

test("resource pressure closes the gate instead of silently sacrificing critical or high coverage", () => {
  const clusters = [cluster("c1", "critical"), cluster("c2", "critical"),
    ...Array.from({ length: 100 }, (_, index) => cluster(`h${String(index).padStart(3, "0")}`, "high"))];
  const result = planCoverageDrivenResearch({ clusters }, { remainingResearchRequests: 50 });
  assert.equal(result.queue.filter((item) => item.impact === "critical").length, 2);
  assert.equal(result.coverageCapacity.critical, 1); assert.equal(result.coverageCapacity.high, 0.48);
  assert.equal(result.gate.status, "closed"); assert.deepEqual(result.gate.blockers, ["high-coverage-capacity"]);
  assert.equal(result.deferred.length, 52);
});

test("resolved clusters never consume research capacity", () => {
  const result = planCoverageDrivenResearch({ clusters: [cluster("covered", "critical", { resolution: "persisted-knowledge" }),
    cluster("risk", "high", { resolution: "accepted-risk" }), cluster("open", "high")] }, { remainingResearchRequests: 1 });
  assert.deepEqual(result.queue.map((item) => item.clusterId), ["open"]); assert.equal(result.gate.status, "ready");
});
