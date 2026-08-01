import { parentPort, workerData } from "node:worker_threads";
import { openWorkspaceDatabase } from "../../src/db/connection.mjs";
import { PricingBudgetService } from "../../src/provider/cost-budget.mjs";

const database = openWorkspaceDatabase(workerData.filename, { workspaceId: workerData.workspaceId });
const service = new PricingBudgetService(database, workerData.workspaceId, { now: () => new Date(0) });
const decisions = [];
const errors = [];
const waiter = new Int32Array(new SharedArrayBuffer(4));

try {
  for (const attemptId of workerData.attemptIds) {
    let completed = false;
    for (let retry = 0; retry < 20 && !completed; retry += 1) {
      try {
        decisions.push(service.reserve(attemptId, "unit", { inputTokens: 0, outputTokens: 1, cachedInputTokens: 0 }).decision);
        completed = true;
      } catch (error) {
        if (error?.code?.startsWith("SQLITE_BUSY") || error?.code?.startsWith("SQLITE_LOCKED")) {
          Atomics.wait(waiter, 0, 0, 10);
          continue;
        }
        errors.push({ attemptId, code: error?.code ?? "ERROR", message: error?.message ?? "unknown" });
        completed = true;
      }
    }
    if (!completed) errors.push({ attemptId, code: "BUSY_RETRY_EXHAUSTED" });
  }
} finally {
  database.close();
}

parentPort.postMessage({ decisions, errors });
