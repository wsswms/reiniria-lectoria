import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentRuntimeLedgerService } from "../../src/agent/runtime-ledger-service.mjs";
import { assertDatabaseIntegrity, openWorkspaceDatabase } from "../../src/db/connection.mjs";
import { CURRENT_SCHEMA_VERSION } from "../../src/db/migrations.mjs";
import { DEFAULT_FLOW_BUDGET } from "../../src/m5c/contracts.mjs";
import { FlowPlanService } from "../../src/m5c/flow-plan-service.mjs";
import { TranslationFlowBudgetService } from "../../src/m5c/flow-budget-service.mjs";
import { TranslationTaskOrchestrator } from "../../src/provider/task-orchestrator.mjs";
import { setup } from "../m5c-1/helpers.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
const usage = (overrides = {}) => ({ calls: 1, inputTokens: 20, outputTokens: 10, costMicrosCny: 100, costMicrosUsd: 0, durationMs: 50, ...overrides });
const messages = (text = "译文") => [
  { role: "user", content: [{ type: "text", text: "source" }], timestamp: 0 },
  { role: "assistant", content: [{ type: "text", text }], api: "fixture", provider: "deepseek", model: "deepseek-chat",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 1 },
];

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5p3-"));
  const seeded = setup(join(root, "app.sqlite3")); const { workspaceId, database } = seeded;
  const clock = { value: 0, now: () => new Date(clock.value), advance: (ms) => { clock.value += ms; } };
  const segmentId = database.prepare("SELECT segment_id AS segmentId FROM source_segment_versions WHERE workspace_id = ? AND source_revision_id = ? ORDER BY ordinal LIMIT 1")
    .get(workspaceId, seeded.sourceRevisionId).segmentId;
  const workflow = { workflowId: seeded.workflowId, documentId: seeded.documentId, sourceRevisionId: seeded.sourceRevisionId,
    segmentId, targetLanguage: "zh-CN" };
  new FlowPlanService(database, workspaceId, { now: clock.now }).create({ workflowId: workflow.workflowId, documentId: workflow.documentId,
    sourceRevisionId: workflow.sourceRevisionId, targetLanguage: workflow.targetLanguage, budget: DEFAULT_FLOW_BUDGET }, { type: "user", id: "fixture-user" });
  const orchestrator = new TranslationTaskOrchestrator(database, workspaceId, { now: clock.now });
  const task = orchestrator.enqueue({ ...workflow, segmentIds: [workflow.segmentId], idempotencyKey: randomUUID(), requestDigest: sha("request"),
    policyVersion: "policy-v1", providerId: "deepseek", modelId: "deepseek-chat", promptVersion: "prompt-v1", contextDigest: sha("context"), maxAttempts: 1, batchSize: 1 });
  const attempt = task.attempts[0];
  database.prepare("UPDATE translation_attempts SET state = 'leased', version = version + 1 WHERE workspace_id = ? AND attempt_id = ?")
    .run(workspaceId, attempt.attempt_id);
  database.prepare("UPDATE attempt_runtime_states SET lease_holder = 'agent-worker', lease_expires_at = ?, heartbeat_at = ? WHERE workspace_id = ? AND attempt_id = ?")
    .run(new Date(10_000).toISOString(), clock.now().toISOString(), workspaceId, attempt.attempt_id);
  database.prepare("UPDATE translation_tasks SET state = 'running', version = version + 1 WHERE workspace_id = ? AND task_id = ?").run(workspaceId, task.task.task_id);
  database.prepare("UPDATE translation_flow_controls SET flow_state = 'translating' WHERE workspace_id = ? AND workflow_id = ?").run(workspaceId, workflow.workflowId);
  const lease = database.prepare("SELECT * FROM translation_attempts WHERE workspace_id = ? AND attempt_id = ?").get(workspaceId, attempt.attempt_id);
  const service = new AgentRuntimeLedgerService(database, workspaceId, { now: clock.now,
    flowBudgets: new TranslationFlowBudgetService(database, workspaceId, { now: clock.now }), ...options });
  return { root, workspaceId, database, clock, workflow, task: task.task, attempt: lease, service,
    close: async () => { database.close(); await rm(root, { recursive: true, force: true }); } };
}

test("schema v31 adds only immutable call, outcome, and checkpoint facts", async () => {
  const value = await fixture();
  try {
    assert.equal(CURRENT_SCHEMA_VERSION, 31);
    const names = value.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent_runtime_%' ORDER BY name").all().map((row) => row.name);
    assert.deepEqual(names, ["agent_runtime_calls", "agent_runtime_checkpoints", "agent_runtime_outcomes"]);
    assert.equal(value.database.prepare("SELECT count(*) AS total FROM sqlite_master WHERE type = 'table' AND name LIKE '%session%'").get().total, 0);
    assertDatabaseIntegrity(value.database);
  } finally { await value.close(); }
});

test("provider, remote tool, local receipt, checkpoint, and final facts settle atomically and reconstruct exactly", async () => {
  const value = await fixture();
  try {
    const provider = value.service.beginCall({ attemptId: value.attempt.attempt_id, callId: "provider-1", callSequence: 1, turnOrdinal: 1,
      kind: "provider", name: "deepseek", requestDigest: sha("provider-request"), budgetReservationId: "provider-budget-1", estimate: usage() });
    assert.equal(provider.reused, false);
    assert.throws(() => value.service.acceptCheckpoint(value.attempt.attempt_id, { ordinal: 1, messages: messages() }), /unfinished call/);
    value.service.completeCall("provider-1", { resultDigest: sha("provider-result"), actualUsage: usage({ inputTokens: 18 }) });

    value.service.beginCall({ attemptId: value.attempt.attempt_id, callId: "tool-1", callSequence: 2, turnOrdinal: 1, kind: "remote-tool",
      name: "lookup_dictionary", toolCallId: "pi-tool-1", requestDigest: sha("tool-request"), budgetReservationId: "tool-budget-1", estimate: usage({ outputTokens: 2 }) });
    value.service.completeCall("tool-1", { resultDigest: sha("tool-result"), actualUsage: usage({ inputTokens: 8, outputTokens: 2 }) });

    value.service.beginCall({ attemptId: value.attempt.attempt_id, callId: "local-1", callSequence: 3, turnOrdinal: 1, kind: "local-tool",
      name: "calculate_number", toolCallId: "pi-tool-2", requestDigest: sha("local-request") });
    value.service.completeCall("local-1", { resultDigest: sha("local-result"), receiptDigest: sha("receipt") });
    const checkpoint = value.service.acceptCheckpoint(value.attempt.attempt_id, { ordinal: 1, messages: messages() });
    const final = value.service.acceptFinal(value.attempt.attempt_id, { final: { translation: "译文" }, checkpointDigest: checkpoint.transcriptDigest });
    const recovered = value.service.recover(value.attempt.attempt_id);

    assert.equal(final.reused, false); assert.equal(recovered.action, "persist-candidate");
    assert.equal(recovered.calls.length, 3); assert.equal(recovered.checkpoint.ordinal, 1);
    assert.deepEqual(recovered.final, { translation: "译文" });
    assert.equal(value.database.prepare("SELECT count(*) AS total FROM flow_budget_ledger WHERE entry_type = 'reserved'").get().total, 2);
    assert.equal(value.database.prepare("SELECT count(*) AS total FROM flow_budget_ledger WHERE entry_type = 'settled'").get().total, 2);
    assertDatabaseIntegrity(value.database);
  } finally { await value.close(); }
});

test("unknown Provider and remote-tool calls pause once and never become retryable", async () => {
  for (const kind of ["provider", "remote-tool"]) {
    const value = await fixture();
    try {
      value.service.beginCall({ attemptId: value.attempt.attempt_id, callId: `${kind}-unknown`, callSequence: 1, turnOrdinal: 1, kind,
        name: kind === "provider" ? "deepseek" : "lookup_entity", ...(kind === "remote-tool" ? { toolCallId: "unknown-tool" } : {}),
        requestDigest: sha(kind), budgetReservationId: `${kind}-budget`, estimate: usage() });
      const first = value.service.markUnknown(`${kind}-unknown`, { reason: "parent-eof" });
      const second = value.service.markUnknown(`${kind}-unknown`, { reason: "parent-eof" });
      assert.equal(first.reused, false); assert.equal(second.reused, true);
      assert.equal(value.service.recover(value.attempt.attempt_id).action, "paused-unknown");
      assert.equal(value.database.prepare("SELECT state FROM translation_attempts WHERE attempt_id = ?").get(value.attempt.attempt_id).state, "unknown-outcome");
      assert.equal(value.database.prepare("SELECT count(*) AS total FROM agent_runtime_calls WHERE call_id = ?").get(`${kind}-unknown`).total, 1);
      assert.equal(value.database.prepare("SELECT count(*) AS total FROM agent_runtime_outcomes WHERE call_id = ?").get(`${kind}-unknown`).total, 1);
    } finally { await value.close(); }
  }
});

test("actual remote usage above its atomic reservation pauses instead of accepting a result", async () => {
  const value = await fixture();
  try {
    value.service.beginCall({ attemptId: value.attempt.attempt_id, callId: "overrun", callSequence: 1, turnOrdinal: 1,
      kind: "provider", name: "deepseek", requestDigest: sha("overrun"), budgetReservationId: "overrun-budget", estimate: usage() });
    const result = value.service.completeCall("overrun", { resultDigest: sha("result"), actualUsage: usage({ outputTokens: 11 }) });
    assert.deepEqual(result, { outcome: "unknown", reused: false, overrun: true });
    assert.equal(value.service.recover(value.attempt.attempt_id).action, "paused-unknown");
    assert.equal(value.database.prepare("SELECT count(*) AS total FROM agent_runtime_outcomes WHERE outcome = 'completed'").get().total, 0);
  } finally { await value.close(); }
});

test("recovery marks interrupted remote work unknown and pauses unfinished local receipt", async () => {
  const remote = await fixture();
  try {
    remote.service.beginCall({ attemptId: remote.attempt.attempt_id, callId: "remote-active", callSequence: 1, turnOrdinal: 1,
      kind: "provider", name: "deepseek", requestDigest: sha("remote"), budgetReservationId: "remote-budget", estimate: usage() });
    assert.equal(remote.service.recover(remote.attempt.attempt_id).action, "paused-unknown");
    assert.equal(remote.database.prepare("SELECT outcome FROM agent_runtime_outcomes WHERE call_id = 'remote-active'").get().outcome, "unknown");
  } finally { await remote.close(); }

  const local = await fixture();
  try {
    local.service.beginCall({ attemptId: local.attempt.attempt_id, callId: "local-active", callSequence: 1, turnOrdinal: 1,
      kind: "local-tool", name: "calculate_number", toolCallId: "local-tool", requestDigest: sha("local") });
    const recovery = local.service.recover(local.attempt.attempt_id);
    assert.equal(recovery.action, "paused-local-replay"); assert.equal(recovery.call.callId, "local-active");
    local.service.completeCall("local-active", { resultDigest: sha("result"), receiptDigest: sha("receipt") });
    assert.equal(local.service.completeCall("local-active", { resultDigest: sha("result"), receiptDigest: sha("receipt") }).reused, true);
    assert.throws(() => local.service.completeCall("local-active", { resultDigest: sha("forged"), receiptDigest: sha("receipt") }), /outcome conflict/);
  } finally { await local.close(); }
});

test("ordering, identity, digest, transcript, late outcome, and cross-workspace forgeries fail closed", async () => {
  const value = await fixture(); const other = await fixture();
  try {
    assert.throws(() => value.service.beginCall({ attemptId: other.attempt.attempt_id, callId: "cross", callSequence: 1, turnOrdinal: 1,
      kind: "local-tool", name: "calculate_number", toolCallId: "cross", requestDigest: sha("cross") }), /attempt scope/);
    assert.throws(() => value.service.beginCall({ attemptId: value.attempt.attempt_id, callId: "forged-provider", callSequence: 1, turnOrdinal: 1,
      kind: "provider", name: "other", requestDigest: sha("forged"), budgetReservationId: "forged-budget", estimate: usage() }), /identity/);
    assert.throws(() => value.service.beginCall({ attemptId: value.attempt.attempt_id, callId: "bad-order", callSequence: 2, turnOrdinal: 1,
      kind: "local-tool", name: "calculate_number", toolCallId: "bad", requestDigest: sha("bad") }), /sequence/);
    value.service.beginCall({ attemptId: value.attempt.attempt_id, callId: "local", callSequence: 1, turnOrdinal: 1,
      kind: "local-tool", name: "calculate_number", toolCallId: "local", requestDigest: sha("local") });
    assert.throws(() => value.service.beginCall({ attemptId: value.attempt.attempt_id, callId: "parallel", callSequence: 2, turnOrdinal: 1,
      kind: "local-tool", name: "calculate_number", toolCallId: "parallel", requestDigest: sha("parallel") }), /unfinished call/);
    value.service.completeCall("local", { resultDigest: sha("result"), receiptDigest: sha("receipt") });
    assert.throws(() => value.service.acceptCheckpoint(value.attempt.attempt_id, { ordinal: 2, messages: messages() }), /ordinal/);
    assert.throws(() => value.service.acceptCheckpoint(value.attempt.attempt_id, { ordinal: 1,
      messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] }] }), /transcript/);
    assert.throws(() => value.service.acceptCheckpoint(value.attempt.attempt_id, { ordinal: 1,
      messages: [{ role: "assistant", content: [{ type: "toolCall", id: "forged", name: "shell", arguments: {} }],
        api: "fixture", provider: "deepseek", model: "deepseek-chat", usage: {}, stopReason: "toolUse", timestamp: 1 }] }), /transcript/);
    const checkpoint = value.service.acceptCheckpoint(value.attempt.attempt_id, { ordinal: 1, messages: messages() });
    assert.throws(() => value.service.acceptFinal(value.attempt.attempt_id, { final: { translation: "x", extra: true }, checkpointDigest: checkpoint.transcriptDigest }), /final/);
    assert.throws(() => value.service.acceptFinal(value.attempt.attempt_id, { final: { translation: "x" }, checkpointDigest: sha("forged") }), /checkpoint/);
    assertDatabaseIntegrity(value.database);
  } finally { await value.close(); await other.close(); }
});

test("started, outcome, and checkpoint fault cuts expose only the complete old or new fact", async () => {
  for (const point of ["before-call", "after-call", "before-outcome", "after-outcome", "before-checkpoint", "after-checkpoint"]) {
    const value = await fixture({ inject(current) { if (current === point) throw new Error(`injected ${point}`); } });
    try {
      if (point.includes("call")) {
        assert.throws(() => value.service.beginCall({ attemptId: value.attempt.attempt_id, callId: "fault", callSequence: 1, turnOrdinal: 1,
          kind: "local-tool", name: "calculate_number", toolCallId: "fault", requestDigest: sha("fault") }), /injected/);
        assert.equal(value.database.prepare("SELECT count(*) AS total FROM agent_runtime_calls").get().total, point === "after-call" ? 1 : 0);
      } else {
        value.service.beginCall({ attemptId: value.attempt.attempt_id, callId: "fault", callSequence: 1, turnOrdinal: 1,
          kind: "local-tool", name: "calculate_number", toolCallId: "fault", requestDigest: sha("fault") });
        if (point.includes("outcome")) {
          assert.throws(() => value.service.completeCall("fault", { resultDigest: sha("result"), receiptDigest: sha("receipt") }), /injected/);
          assert.equal(value.database.prepare("SELECT count(*) AS total FROM agent_runtime_outcomes").get().total, point === "after-outcome" ? 1 : 0);
        } else {
          value.service.completeCall("fault", { resultDigest: sha("result"), receiptDigest: sha("receipt") });
          assert.throws(() => value.service.acceptCheckpoint(value.attempt.attempt_id, { ordinal: 1, messages: messages() }), /injected/);
          assert.equal(value.database.prepare("SELECT count(*) AS total FROM agent_runtime_checkpoints").get().total, point === "after-checkpoint" ? 1 : 0);
        }
      }
    } finally { await value.close(); }
  }
});

test("accepted facts reconstruct identically across ten process-style database restarts", async () => {
  const value = await fixture(); const filename = join(value.root, "app.sqlite3");
  try {
    value.service.beginCall({ attemptId: value.attempt.attempt_id, callId: "restart-provider", callSequence: 1, turnOrdinal: 1,
      kind: "provider", name: "deepseek", requestDigest: sha("restart"), budgetReservationId: "restart-budget", estimate: usage() });
    value.service.completeCall("restart-provider", { resultDigest: sha("restart-result"), actualUsage: usage() });
    const checkpoint = value.service.acceptCheckpoint(value.attempt.attempt_id, { ordinal: 1, messages: messages("restart") });
    value.database.close();
    for (let index = 0; index < 10; index += 1) {
      const database = openWorkspaceDatabase(filename, { workspaceId: value.workspaceId });
      const recovered = new AgentRuntimeLedgerService(database, value.workspaceId).recover(value.attempt.attempt_id);
      assert.equal(recovered.action, "resume-host"); assert.equal(recovered.checkpoint.transcriptDigest, checkpoint.transcriptDigest);
      assert.equal(recovered.calls.length, 1); database.close();
    }
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
