import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PricingBudgetService } from "../../src/provider/cost-budget.mjs";
import { buildContextManifest } from "../../src/provider/prompt-context.mjs";
import { parseModelResponse } from "../../src/provider/model-response.mjs";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../../src/storage/backup.mjs";
import { PrivateLedger } from "../../src/storage/ledger.mjs";
import { MachineCandidateService } from "../../src/translation/machine-candidate-service.mjs";
import { WorkspaceManager } from "../../src/workspace/manager.mjs";
import { enqueueInput, orchestrator, seedWorkflow, workspace } from "../m4-3/helpers.mjs";
import { responseFor } from "../m4-4/helpers.mjs";

test("thirty backup restores retain task attempt candidate usage budget and idempotency relationships", async () => {
  const fixture = await workspace();
  const targets = [];
  try {
    for (const path of ["private/objects", "private/ledger", "derived", "staging"]) await mkdir(join(fixture.root, path), { recursive: true });
    const workflow = seedWorkflow(fixture);
    const context = buildContextManifest(fixture.database, fixture.workspaceId, { workflowId: workflow.workflowId, segmentIds: [workflow.segmentId] });
    const tasks = orchestrator(fixture);
    const created = tasks.enqueue(enqueueInput(workflow, "backup", { promptVersion: context.manifest.promptVersion, contextDigest: context.contextDigest }));
    const attemptId = created.attempts[0].attempt_id;
    const budgets = new PricingBudgetService(fixture.database, fixture.workspaceId, { now: fixture.clock.now });
    budgets.addPricing({ providerId: "fake-primary", modelId: "fixture-model-v1", pricingVersion: "backup-price", currency: "USD", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, cachedInputMicrosPerMillion: 500_000, source: "backup-fixture" });
    budgets.addPolicy({ policyVersion: "backup-budget", currency: "USD", softLimitMicros: 100, hardLimitMicros: 200, unknownPriceAction: "pause" });
    budgets.assignTask(created.task.task_id, "backup-budget");
    const reservation = budgets.reserve(attemptId, "backup-price", { inputTokens: 4, outputTokens: 2, cachedInputTokens: 0 });
    const response = responseFor(context);
    const parsed = parseModelResponse(response, context);
    const lease = tasks.leaseNext("backup-worker", 1_000);
    const running = tasks.startProvider(attemptId, lease.version, "backup-worker");
    const usage = budgets.pricedUsage("fake-primary", "fixture-model-v1", "backup-price", { providerId: "fake-primary", modelId: "fixture-model-v1", providerResponseId: "backup-response", inputTokens: 4, outputTokens: 2, cachedInputTokens: 0, totalTokens: 6 });
    tasks.complete(attemptId, running.version, "backup-worker", parsed.outputDigest, { usage });
    new MachineCandidateService(fixture.database, fixture.workspaceId, { now: fixture.clock.now }).accept(attemptId, response);
    const usageId = fixture.database.prepare("SELECT usage_record_id FROM usage_cost_records WHERE attempt_id = ?").get(attemptId).usage_record_id;
    budgets.finalize(reservation.reservationId, usageId);
    const ledger = new PrivateLedger(fixture.root, { now: fixture.clock.now });
    await ledger.append({ event: "translation-completed", taskId: created.task.task_id, authorization: "must-redact" });
    const backup = join(fixture.root, "m4-backup");
    await createWorkspaceBackup({ database: fixture.database, workspaceRoot: fixture.root, destination: backup });
    assert.equal(await ledger.enforceRetention("1970-01-02"), 1);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM translation_tasks").get().total, 1);

    for (let round = 0; round < 30; round += 1) {
      const targetRoot = await mkdtemp(join(tmpdir(), "lectoria-m4-5-restore-"));
      targets.push(targetRoot);
      const manager = await WorkspaceManager.create(targetRoot);
      try {
        await restoreWorkspaceBackup({ backupRoot: backup, manager });
        const handle = manager.open(fixture.workspaceId);
        const relationship = handle.database.prepare(`
          SELECT count(*) AS total
          FROM translation_tasks task
          JOIN translation_attempts attempt ON attempt.workspace_id = task.workspace_id AND attempt.task_id = task.task_id
          JOIN machine_candidate_provenance provenance ON provenance.workspace_id = attempt.workspace_id AND provenance.attempt_id = attempt.attempt_id
          JOIN usage_cost_records usage ON usage.workspace_id = attempt.workspace_id AND usage.attempt_id = attempt.attempt_id
          JOIN budget_reservations budget ON budget.workspace_id = attempt.workspace_id AND budget.attempt_id = attempt.attempt_id AND budget.usage_record_id = usage.usage_record_id
        `).get();
        assert.equal(relationship.total, 1);
        assert.equal(handle.database.prepare("SELECT state FROM translation_tasks").get().state, "completed");
        assert.equal(handle.database.prepare("SELECT state FROM budget_reservations").get().state, "consumed");
        handle.database.close();
      } finally { manager.close(); }
    }
  } finally {
    await fixture.close();
    for (const target of targets) await rm(target, { recursive: true, force: true });
  }
});
