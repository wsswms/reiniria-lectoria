import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { openWorkspaceDatabase } from "../../src/db/connection.mjs";
import { TaskConflictError } from "../../src/provider/task-orchestrator.mjs";
import { enqueueInput, orchestrator, seedWorkflow, sha, workspace } from "./helpers.mjs";

test("one hundred duplicate enqueues create one logical task and one attempt", async () => {
  const fixture = await workspace();
  try {
    const workflow = seedWorkflow(fixture);
    const input = enqueueInput(workflow, "same");
    const service = orchestrator(fixture);
    const results = Array.from({ length: 100 }, () => service.enqueue(input));
    assert.equal(new Set(results.map((result) => result.task.task_id)).size, 1);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM translation_tasks").get().total, 1);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM translation_attempts").get().total, 1);
    assert.throws(() => service.enqueue({ ...input, requestDigest: sha("different") }), TaskConflictError);
  } finally { await fixture.close(); }
});

test("multi-segment tasks bind each attempt to its own context digest", async () => {
  const fixture = await workspace();
  try {
    const workflow = seedWorkflow(fixture, { sourceText: "First source" });
    const secondSegmentId = randomUUID();
    const timestamp = fixture.clock.now().toISOString();
    fixture.database.prepare("INSERT INTO document_segments VALUES (?, ?, ?, ?)")
      .run(fixture.workspaceId, workflow.documentId, secondSegmentId, timestamp);
    fixture.database.prepare("INSERT INTO source_segment_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(fixture.workspaceId, workflow.documentId, workflow.sourceRevisionId, secondSegmentId, "paragraph", "/1", "Second source", sha("Second source"), 1, 1, "[]", "initial");
    const contextDigests = {
      [workflow.segmentId]: sha("context-first"),
      [secondSegmentId]: sha("context-second"),
    };
    const input = enqueueInput(workflow, "multi", {
      segmentIds: [workflow.segmentId, secondSegmentId],
      contextDigest: undefined,
      contextDigests,
    });
    const created = orchestrator(fixture).enqueue(input);
    assert.equal(created.attempts.length, 2);
    assert.deepEqual(Object.fromEntries(created.attempts.map((attempt) => [attempt.segment_id, attempt.context_digest])), contextDigests);
    assert.throws(() => orchestrator(fixture).enqueue({ ...input, idempotencyKey: "missing-context", contextDigests: { [workflow.segmentId]: sha("only-one") } }), /contextDigests/);
  } finally { await fixture.close(); }
});

test("one hundred lease contenders produce one holder and completion is idempotent", async () => {
  const fixture = await workspace();
  try {
    const workflow = seedWorkflow(fixture);
    const service = orchestrator(fixture);
    const task = service.enqueue(enqueueInput(workflow)).task;
    const leases = Array.from({ length: 100 }, (_, index) => service.leaseNext(`worker-${index}`, 1_000));
    assert.equal(leases.filter(Boolean).length, 1);
    const lease = leases.find(Boolean);
    const running = service.startProvider(lease.attempt_id, lease.version, lease.leaseHolder);
    const usage = {
      providerId: "fake-primary", modelId: "fixture-model-v1", providerResponseId: "response-1",
      inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, totalTokens: 14,
      currency: "USD", amountMicros: 12, pricingVersion: "pricing-v1",
    };
    const completed = service.complete(lease.attempt_id, running.version, lease.leaseHolder, sha("outcome"), { usage });
    assert.equal(completed.state, "completed");
    assert.equal(service.complete(lease.attempt_id, running.version, lease.leaseHolder, sha("outcome")).state, "completed");
    assert.equal(service.getTask(task.task_id).task.state, "completed");
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM attempt_events WHERE event_type = 'completed'").get().total, 1);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM usage_cost_records").get().total, 1);
  } finally { await fixture.close(); }
});

test("retryable failures respect maximum attempts while auth and unknown outcomes never auto-retry", async () => {
  const fixture = await workspace();
  try {
    const service = orchestrator(fixture);
    const retryWorkflow = seedWorkflow(fixture);
    const retryTask = service.enqueue(enqueueInput(retryWorkflow, "retry", { maxAttempts: 2 })).task;
    let lease = service.leaseNext("worker", 1_000);
    let running = service.startProvider(lease.attempt_id, lease.version, "worker");
    const failed = service.fail(lease.attempt_id, running.version, "worker", { category: "rate-limit", message: "limited", retryable: true }, { retryDelayMs: 100 });
    assert.ok(failed.retryAttemptId);
    assert.equal(service.leaseNext("early"), null);
    fixture.clock.advance(100);
    lease = service.leaseNext("worker-2", 1_000);
    running = service.startProvider(lease.attempt_id, lease.version, "worker-2");
    assert.equal(service.fail(lease.attempt_id, running.version, "worker-2", { category: "timeout", message: "timeout", retryable: true }).state, "failed");
    assert.equal(service.getTask(retryTask.task_id).attempts.length, 2);
    assert.equal(service.getTask(retryTask.task_id).task.state, "failed");

    const authTask = service.enqueue(enqueueInput(seedWorkflow(fixture), "auth")).task;
    lease = service.leaseNext("auth-worker", 1_000);
    running = service.startProvider(lease.attempt_id, lease.version, "auth-worker");
    service.fail(lease.attempt_id, running.version, "auth-worker", { category: "auth", message: "auth", retryable: false });
    assert.equal(service.getTask(authTask.task_id).attempts.length, 1);

    const unknownTask = service.enqueue(enqueueInput(seedWorkflow(fixture), "unknown")).task;
    lease = service.leaseNext("unknown-worker", 1_000);
    running = service.startProvider(lease.attempt_id, lease.version, "unknown-worker");
    service.fail(lease.attempt_id, running.version, "unknown-worker", { category: "unknown-outcome", message: "unknown", retryable: false });
    assert.equal(service.getTask(unknownTask.task_id).task.state, "paused");
    assert.equal(service.getTask(unknownTask.task_id).attempts.length, 1);
  } finally { await fixture.close(); }
});

test("expired leases recover safely before Provider calls and become unknown after Provider calls", async () => {
  const fixture = await workspace();
  try {
    const service = orchestrator(fixture);
    for (let index = 0; index < 30; index += 1) service.enqueue(enqueueInput(seedWorkflow(fixture), `safe-${index}`));
    const safeLeases = [];
    for (let index = 0; index < 30; index += 1) safeLeases.push(service.leaseNext(`safe-${index}`, 10));
    fixture.clock.advance(10);
    assert.equal(service.recoverExpired().filter((item) => item.state === "queued").length, 30);

    for (let index = 0; index < 30; index += 1) service.enqueue(enqueueInput(seedWorkflow(fixture), `unknown-${index}`));
    const running = [];
    for (let index = 0; index < 30; index += 1) {
      const lease = service.leaseNext(`unknown-${index}`, 10);
      running.push(service.startProvider(lease.attempt_id, lease.version, lease.leaseHolder));
    }
    fixture.clock.advance(10);
    assert.equal(service.recoverExpired().filter((item) => item.state === "unknown-outcome").length, 30);
  } finally { await fixture.close(); }
});

test("offline pause resume and cancellation are explicit and release active attempts", async () => {
  const fixture = await workspace();
  try {
    const terminated = [];
    const service = orchestrator(fixture, { onTerminate: (attemptId) => terminated.push(attemptId) });
    for (let index = 0; index < 30; index += 1) {
      const task = service.enqueue(enqueueInput(seedWorkflow(fixture), `offline-${index}`)).task;
      assert.equal(service.pauseOffline(task.task_id).task.state, "paused");
      assert.equal(service.resume(task.task_id).task.state, "queued");
      assert.equal(service.cancel(task.task_id).task.state, "canceled");
    }
    assert.equal(terminated.length, 30);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM translation_attempts WHERE state != 'canceled'").get().total, 0);
  } finally { await fixture.close(); }
});

test("queued running retry-wait paused and canceled states survive thirty restart rounds each", async () => {
  const fixture = await workspace();
  try {
    let service = orchestrator(fixture);
    for (let index = 0; index < 30; index += 1) {
      const task = service.enqueue(enqueueInput(seedWorkflow(fixture), `restart-paused-${index}`)).task;
      service.pauseOffline(task.task_id);
    }
    for (let index = 0; index < 30; index += 1) {
      const task = service.enqueue(enqueueInput(seedWorkflow(fixture), `restart-canceled-${index}`)).task;
      service.cancel(task.task_id);
    }
    for (let index = 0; index < 30; index += 1) {
      service.enqueue(enqueueInput(seedWorkflow(fixture), `restart-retry-${index}`));
      const lease = service.leaseNext(`retry-worker-${index}`, 10);
      service.fail(lease.attempt_id, lease.version, lease.leaseHolder, { category: "rate-limit", message: "limited", retryable: true }, { retryDelayMs: 10 });
    }
    for (let index = 0; index < 30; index += 1) {
      service.enqueue(enqueueInput(seedWorkflow(fixture), `restart-running-${index}`));
      const lease = service.leaseNext(`running-worker-${index}`, 10);
      service.startProvider(lease.attempt_id, lease.version, lease.leaseHolder);
    }
    for (let index = 0; index < 30; index += 1) service.enqueue(enqueueInput(seedWorkflow(fixture), `restart-queued-${index}`));
    fixture.clock.advance(10);
    fixture.database.close();
    fixture.database = openWorkspaceDatabase(join(fixture.root, "app.sqlite3"), { workspaceId: fixture.workspaceId });
    service = orchestrator(fixture);

    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM translation_tasks WHERE state = 'queued'").get().total, 30);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM translation_tasks WHERE state = 'paused'").get().total, 30);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM translation_tasks WHERE state = 'canceled'").get().total, 30);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM translation_attempts WHERE state = 'retry-wait'").get().total, 30);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM translation_attempts WHERE state = 'running'").get().total, 30);
    assert.equal(service.recoverExpired().filter((item) => item.state === "unknown-outcome").length, 30);
  } finally { await fixture.close(); }
});

test("stale workflows cancel active attempts and reject one hundred late results", async () => {
  const fixture = await workspace();
  try {
    const service = orchestrator(fixture);
    for (let index = 0; index < 100; index += 1) {
      const workflow = seedWorkflow(fixture);
      service.enqueue(enqueueInput(workflow, `stale-${index}`));
      const lease = service.leaseNext(`worker-${index}`, 1_000);
      const running = service.startProvider(lease.attempt_id, lease.version, lease.leaseHolder);
      fixture.database.prepare("UPDATE translation_workflows SET state = 'stale', version = version + 1 WHERE workspace_id = ? AND workflow_id = ?").run(fixture.workspaceId, workflow.workflowId);
      assert.equal(service.invalidateStaleWorkflow(workflow.workflowId), 1);
      assert.throws(() => service.complete(lease.attempt_id, running.version, lease.leaseHolder, sha(`late-${index}`)), /completion conflict|late result/);
    }
  } finally { await fixture.close(); }
});

test("state transition failures roll back before commit and remain explainable after commit", async () => {
  for (const point of ["before-enqueue", "after-enqueue-writes", "after-enqueue-commit"]) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const fixture = await workspace();
      try {
        const workflow = seedWorkflow(fixture);
        const service = orchestrator(fixture, { inject(current) { if (current === point) throw new Error(`injected ${point}`); } });
        assert.throws(() => service.enqueue(enqueueInput(workflow, `${point}-${attempt}`)), /injected/);
        const total = fixture.database.prepare("SELECT count(*) AS total FROM translation_tasks").get().total;
        assert.equal(total, point === "after-enqueue-commit" ? 1 : 0);
      } finally { await fixture.close(); }
    }
  }
});

test("every runtime state transition converges across before-write after-write and after-commit faults", async () => {
  const operations = [
    {
      name: "lease",
      prepare(service, fixture) { const task = service.enqueue(enqueueInput(seedWorkflow(fixture))).task; return { taskId: task.task_id }; },
      run(service) { service.leaseNext("worker", 10); },
      state(fixture, context) { return fixture.database.prepare("SELECT state FROM translation_attempts WHERE task_id = ?").get(context.taskId).state; },
      old: "queued", next: "leased",
    },
    {
      name: "provider-start",
      prepare(service, fixture) { const task = service.enqueue(enqueueInput(seedWorkflow(fixture))).task; const lease = service.leaseNext("worker", 10); return { taskId: task.task_id, lease }; },
      run(service, context) { service.startProvider(context.lease.attempt_id, context.lease.version, "worker"); },
      state(fixture, context) { return fixture.database.prepare("SELECT state FROM translation_attempts WHERE task_id = ?").get(context.taskId).state; },
      old: "leased", next: "running",
    },
    {
      name: "complete",
      prepare(service, fixture) { const task = service.enqueue(enqueueInput(seedWorkflow(fixture))).task; const lease = service.leaseNext("worker", 10); const running = service.startProvider(lease.attempt_id, lease.version, "worker"); return { taskId: task.task_id, lease, running }; },
      run(service, context) { service.complete(context.lease.attempt_id, context.running.version, "worker", sha("outcome"), { usage: { providerId: "fake-primary", modelId: "fixture-model-v1", providerResponseId: "fault-response", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 } }); },
      state(fixture, context) { return fixture.database.prepare("SELECT state FROM translation_attempts WHERE task_id = ?").get(context.taskId).state; },
      old: "running", next: "completed",
    },
    {
      name: "fail",
      prepare(service, fixture) { const task = service.enqueue(enqueueInput(seedWorkflow(fixture))).task; const lease = service.leaseNext("worker", 10); const running = service.startProvider(lease.attempt_id, lease.version, "worker"); return { taskId: task.task_id, lease, running }; },
      run(service, context) { service.fail(context.lease.attempt_id, context.running.version, "worker", { category: "auth", message: "auth", retryable: false }); },
      state(fixture, context) { return fixture.database.prepare("SELECT state FROM translation_attempts WHERE task_id = ?").get(context.taskId).state; },
      old: "running", next: "failed",
    },
    {
      name: "cancel",
      prepare(service, fixture) { const task = service.enqueue(enqueueInput(seedWorkflow(fixture))).task; return { taskId: task.task_id }; },
      run(service, context) { service.cancel(context.taskId); },
      state(fixture, context) { return fixture.database.prepare("SELECT state FROM translation_tasks WHERE task_id = ?").get(context.taskId).state; },
      old: "queued", next: "canceled",
    },
    {
      name: "pause",
      prepare(service, fixture) { const task = service.enqueue(enqueueInput(seedWorkflow(fixture))).task; return { taskId: task.task_id }; },
      run(service, context) { service.pauseOffline(context.taskId); },
      state(fixture, context) { return fixture.database.prepare("SELECT state FROM translation_tasks WHERE task_id = ?").get(context.taskId).state; },
      old: "queued", next: "paused",
    },
    {
      name: "resume",
      prepare(service, fixture) { const task = service.enqueue(enqueueInput(seedWorkflow(fixture))).task; service.pauseOffline(task.task_id); return { taskId: task.task_id }; },
      run(service, context) { service.resume(context.taskId); },
      state(fixture, context) { return fixture.database.prepare("SELECT state FROM translation_tasks WHERE task_id = ?").get(context.taskId).state; },
      old: "paused", next: "queued",
    },
    {
      name: "recover",
      prepare(service, fixture) { const task = service.enqueue(enqueueInput(seedWorkflow(fixture))).task; service.leaseNext("worker", 10); fixture.clock.advance(10); return { taskId: task.task_id }; },
      run(service) { service.recoverExpired(); },
      state(fixture, context) { return fixture.database.prepare("SELECT state FROM translation_attempts WHERE task_id = ?").get(context.taskId).state; },
      old: "leased", next: "queued",
    },
    {
      name: "stale",
      prepare(service, fixture) { const workflow = seedWorkflow(fixture); const task = service.enqueue(enqueueInput(workflow)).task; fixture.database.prepare("UPDATE translation_workflows SET state = 'stale', version = version + 1 WHERE workspace_id = ? AND workflow_id = ?").run(fixture.workspaceId, workflow.workflowId); return { taskId: task.task_id, workflowId: workflow.workflowId }; },
      run(service, context) { service.invalidateStaleWorkflow(context.workflowId); },
      state(fixture, context) { return fixture.database.prepare("SELECT state FROM translation_tasks WHERE task_id = ?").get(context.taskId).state; },
      old: "queued", next: "failed",
    },
  ];

  for (const operation of operations) {
    for (const position of ["before", "after-writes", "after-commit"]) {
      const point = position === "before" ? `before-${operation.name}` : `${position === "after-writes" ? "after" : "after"}-${operation.name}-${position === "after-writes" ? "writes" : "commit"}`;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const fixture = await workspace();
        try {
          const plain = orchestrator(fixture);
          const context = operation.prepare(plain, fixture);
          const faulting = orchestrator(fixture, { inject(current) { if (current === point) throw new Error(`injected ${point}`); } });
          assert.throws(() => operation.run(faulting, context), /injected/);
          assert.equal(operation.state(fixture, context), position === "after-commit" ? operation.next : operation.old, `${operation.name}:${position}`);
        } finally { await fixture.close(); }
      }
    }
  }
});
