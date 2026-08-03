import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("isolated real runner completes four offline arms, pauses at the user checkpoint and proves exact warm lineage", async () => {
  const { stdout, stderr } = await execute(process.execPath, ["scripts/m5e-isolated-runner.mjs"], {
    cwd: process.cwd(), env: { ...process.env, M5E_RUNNER_MODE: "dry-run" }, timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(stderr, ""); const result = JSON.parse(stdout);
  assert.equal(result.status, "passed"); assert.equal(result.networkCalls, 0); assert.equal(result.checkpointPauseObserved, true);
  assert.equal(result.plannerRerunCount, 4); assert.equal(result.plannerCandidateSetDigests.length, 4);
  assert.equal(result.fakeRecoveryPauses, 2); assert.equal(result.exactPart2RetrievalBindings, 1); assert.equal(result.lineageMisses, 0);
  assert.equal(result.simulatedSearchCalls, 2); assert.equal(result.simulatedFetchAttempts, 4);
});
