import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { runRunnerProcess, RunnerProcessError } from "../../src/runner/process-runner.mjs";
import { RUNNER_TASK_VERSION, runnerOutputContract } from "../../src/runner/protocol.mjs";

const fixture = new URL("./process-fixture.mjs", import.meta.url);
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function taskFixture(overrides = {}) {
  return {
    schemaVersion: RUNNER_TASK_VERSION,
    request: {
      workspaceId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), workflowId: randomUUID(), sourceRevisionId: randomUUID(),
      targetLanguage: "ja", providerId: "fake-primary", modelId: "fixture-model-v1", promptVersion: "prompt-v1", contextDigest: sha("context"),
      segments: [{ segmentId: randomUUID(), sourceDigest: sha("source"), sourceText: "Hello", protected: [] }],
    },
    capability: { token: "signed.capability" },
    limits: { inputBytes: 65536, outputBytes: 65536, toolCalls: 2, runtimeMs: 1000 },
    ...overrides,
  };
}

test("production runner entry uses Pi Agent core and emits one validated structured result", async () => {
  const task = taskFixture({ limits: { inputBytes: 65536, outputBytes: 65536, toolCalls: 2, runtimeMs: 5000 } });
  const output = await runRunnerProcess(task);
  assert.equal(runnerOutputContract(output, task).runtime, "pi-agent-core@0.83.0");
});

test("normal, Provider hang, tool hang and cancellation terminate within five seconds", async () => {
  for (let index = 0; index < 10; index += 1) {
    const started = Date.now();
    assert.equal((await runRunnerProcess(taskFixture(), { entry: fixture, args: ["normal"] })).status, "completed");
    assert.ok(Date.now() - started < 5_000);
  }
  for (const mode of ["provider-hang", "tool-hang"]) {
    for (let index = 0; index < 10; index += 1) {
      const started = Date.now();
      await assert.rejects(runRunnerProcess(taskFixture(), { entry: fixture, args: [mode], timeoutMs: 50, killGraceMs: 25 }), (error) => error instanceof RunnerProcessError && error.category === "timeout");
      assert.ok(Date.now() - started < 5_000);
    }
  }
  for (let index = 0; index < 10; index += 1) {
    const controller = new AbortController();
    const started = Date.now();
    const running = runRunnerProcess(taskFixture(), { entry: fixture, args: ["cancel-hang"], signal: controller.signal, killGraceMs: 25 });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(running, (error) => error instanceof RunnerProcessError && error.category === "canceled");
    assert.ok(Date.now() - started < 5_000);
  }
});

test("runner process environment is allowlisted and output/input limits fail closed", async () => {
  process.env.M4_PROVIDER_SECRET = "M4-SECRET-CANARY";
  try {
    const environment = await runRunnerProcess(taskFixture(), { entry: fixture, args: ["environment"] });
    assert.deepEqual(Object.keys(environment).sort(), ["NODE_ENV", "PATH"]);
    assert.equal(JSON.stringify(environment).includes("M4-SECRET-CANARY"), false);
  } finally {
    delete process.env.M4_PROVIDER_SECRET;
  }
  for (let index = 0; index < 100; index += 1) {
    await assert.rejects(runRunnerProcess(taskFixture(), { entry: fixture, args: ["normal"], inputBytes: 1 }), (error) => error.category === "input-limit");
  }
  for (let index = 0; index < 10; index += 1) {
    await assert.rejects(runRunnerProcess(taskFixture(), { entry: fixture, args: ["large-output"], outputBytes: 1024 }), (error) => error.category === "output-limit");
  }
});
