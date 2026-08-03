import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { RUNNER_OUTPUT_VERSION, RUNNER_TASK_VERSION, runnerOutputContract, runnerTaskContract } from "../../src/runner/protocol.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function taskFixture() {
  return runnerTaskContract({
    schemaVersion: RUNNER_TASK_VERSION,
    request: {
      workspaceId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), workflowId: randomUUID(), sourceRevisionId: randomUUID(),
      targetLanguage: "zh-CN", providerId: "fake-primary", modelId: "fixture-model-v1", promptVersion: "prompt-v1", contextDigest: sha("context"),
      segments: [{ segmentId: randomUUID(), sourceDigest: sha("source"), sourceText: "Hello", protected: [] }],
    },
    capability: { token: "signed.capability" },
    limits: { inputBytes: 65536, outputBytes: 65536, toolCalls: 2, runtimeMs: 5000 },
    apiKey: "M4-SECRET-CANARY",
    runnerEnvironment: { PROVIDER_KEY: "M4-SECRET-CANARY" },
  });
}

function outputFixture(task) {
  return {
    schemaVersion: RUNNER_OUTPUT_VERSION, status: "completed", taskId: task.request.taskId, attemptId: task.request.attemptId,
    providerId: task.request.providerId, modelId: task.request.modelId, toolReceiptDigests: [], runtime: "pi-agent-core@0.83.0",
    response: {
      responseId: "fake-response", providerId: task.request.providerId, modelId: task.request.modelId,
      candidates: task.request.segments.map((segment) => ({ segmentId: segment.segmentId, text: "目标", knowledgeNeeds: [] })),
      usage: { inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, totalTokens: 3 },
    },
  };
}

test("runner tasks are immutable, bounded and contain no Provider secret", () => {
  const task = taskFixture();
  assert.equal(JSON.stringify(task).includes("M4-SECRET-CANARY"), false);
  assert.equal(Object.isFrozen(task), true);
  assert.equal(Object.isFrozen(task.request), true);
  assert.equal(Object.isFrozen(task.limits), true);
});

test("control plane rejects forged runner identity, usage, segments, success and tool receipts", () => {
  const task = taskFixture();
  const valid = outputFixture(task);
  assert.deepEqual(runnerOutputContract(valid, task), valid);
  for (let index = 0; index < 100; index += 1) {
    assert.throws(() => runnerOutputContract({ ...valid, status: "failed" }, task), /not completed/);
    assert.throws(() => runnerOutputContract({ ...valid, taskId: randomUUID() }, task), /taskId/);
    assert.throws(() => runnerOutputContract({ ...valid, attemptId: randomUUID() }, task), /attemptId/);
    assert.throws(() => runnerOutputContract({ ...valid, modelId: `forged-${index}` }, task), /modelId/);
    assert.throws(() => runnerOutputContract({ ...valid, providerId: `forged-${index}` }, task), /providerId/);
    assert.throws(() => runnerOutputContract({ ...valid, response: { ...valid.response, candidates: [{ segmentId: randomUUID(), text: "x" }] } }, task), /segment set/);
    assert.throws(() => runnerOutputContract({ ...valid, response: { ...valid.response, usage: { ...valid.response.usage, totalTokens: 999 } } }, task), /totalTokens/);
    assert.throws(() => runnerOutputContract({ ...valid, toolReceiptDigests: [sha(`forged-${index}`)] }, task), /tool receipts/);
  }
});

test("runner task resource bounds fail closed", () => {
  const task = taskFixture();
  for (const [name, value] of [["inputBytes", 0], ["outputBytes", 5_000_000], ["toolCalls", 33], ["runtimeMs", 300_001]]) {
    for (let index = 0; index < 100; index += 1) {
      assert.throws(() => runnerTaskContract({ ...task, limits: { ...task.limits, [name]: value } }), /invalid/);
    }
  }
});
