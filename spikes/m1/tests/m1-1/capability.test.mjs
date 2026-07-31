import assert from "node:assert/strict";
import test from "node:test";
import { createTaskGateway, issueCapability } from "../../src/m1-1/capability.mjs";

const secret = "capability-test-key";
const now = 1_800_000_000_000;
const tasks = new Map([
  ["task-a", { workspaceId: "workspace-a", segments: new Map([["seg-a", "alpha"]]) }],
  ["task-b", { workspaceId: "workspace-b", segments: new Map([["seg-b", "beta"]]) }],
]);
const gateway = createTaskGateway({ secret, tasks, now: () => now });

function token(overrides = {}) {
  return issueCapability(
    {
      workspaceId: "workspace-a",
      taskId: "task-a",
      segmentIds: ["seg-a"],
      expiresAt: now + 60_000,
      ...overrides,
    },
    secret,
  );
}

test("server-bound capability returns only the allowed segment", () => {
  const result = gateway.getSegment({
    capability: token(),
    taskId: "task-a",
    segmentId: "seg-a",
    workspace_id: "workspace-b",
  });
  assert.deepEqual(result, {
    workspaceId: "workspace-a",
    taskId: "task-a",
    segmentId: "seg-a",
    text: "alpha",
  });
});

test("expired, wrong-task, wrong-segment, cross-workspace and tampered capabilities are rejected", () => {
  const cases = [
    () => gateway.getSegment({ capability: token({ expiresAt: now }), taskId: "task-a", segmentId: "seg-a" }),
    () => gateway.getSegment({ capability: token(), taskId: "task-b", segmentId: "seg-a" }),
    () => gateway.getSegment({ capability: token(), taskId: "task-a", segmentId: "seg-b" }),
    () => gateway.getSegment({ capability: token({ workspaceId: "workspace-b" }), taskId: "task-a", segmentId: "seg-a" }),
    () => gateway.getSegment({ capability: `${token()}x`, taskId: "task-a", segmentId: "seg-a" }),
  ];
  for (const action of cases) assert.throws(action);
});
