import assert from "node:assert/strict";
import test from "node:test";
import { OfflineTaskGate } from "../../src/provider/offline-gate.mjs";
import { enqueueInput, orchestrator, seedWorkflow, workspace } from "../m4-3/helpers.mjs";

test("thirty offline tasks pause explicitly and resume without a Provider call", async () => {
  const fixture = await workspace();
  try {
    const service = orchestrator(fixture);
    let online = false;
    const gate = new OfflineTaskGate(service, { isOnline: () => online, checkedAt: fixture.clock.now });
    const taskIds = [];
    for (let index = 0; index < 30; index += 1) {
      const taskId = service.enqueue(enqueueInput(seedWorkflow(fixture), `offline-gate-${index}`)).task.task_id;
      taskIds.push(taskId);
      assert.deepEqual(gate.guard(taskId), { online: false, runnable: false, reason: "network-offline", checkedAt: fixture.clock.now().toISOString() });
    }
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM translation_tasks WHERE state = 'paused'").get().total, 30);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM attempt_events WHERE event_type = 'provider-started'").get().total, 0);
    online = true;
    for (const taskId of taskIds) assert.equal(gate.guard(taskId).runnable, true);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM translation_tasks WHERE state = 'queued'").get().total, 30);
  } finally { await fixture.close(); }
});
