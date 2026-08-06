import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { calculationReceiptContract, numberCalculationRequestContract } from "./contracts.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export class CalculationReceiptConflictError extends Error {}

export class CalculationReceiptService {
  constructor(database, workspaceId, { now = () => new Date() } = {}) {
    this.database = database;
    this.workspaceId = workspaceId;
    this.now = now;
  }

  find(taskId, requestInput) {
    const requestJson = stableJson(numberCalculationRequestContract(requestInput));
    const row = this.database.prepare(`SELECT receipt_json AS receiptJson FROM translation_calculation_receipts
      WHERE workspace_id = ? AND task_id = ? AND request_digest = ?`).get(this.workspaceId, taskId, sha(requestJson));
    return row ? calculationReceiptContract(JSON.parse(row.receiptJson)) : null;
  }

  persist(taskId, requestInput, receiptInput, maxCalls) {
    const request = numberCalculationRequestContract(requestInput);
    const receipt = calculationReceiptContract(receiptInput);
    if (stableJson(receipt.request) !== stableJson(request)) throw new CalculationReceiptConflictError("calculation receipt request mismatch");
    if (!Number.isSafeInteger(maxCalls) || maxCalls < 1) throw new TypeError("calculation maxCalls is invalid");
    const requestJson = stableJson(request);
    const requestDigest = sha(requestJson);
    const receiptJson = stableJson(receipt);
    const existing = this.find(taskId, request);
    if (existing) {
      if (existing.receiptDigest !== receipt.receiptDigest || stableJson(existing) !== receiptJson) {
        throw new CalculationReceiptConflictError("calculation request has a conflicting receipt");
      }
      return existing;
    }
    try {
      this.database.transaction(() => {
        const count = this.database.prepare(`SELECT count(*) AS value FROM translation_calculation_receipts
          WHERE workspace_id = ? AND task_id = ?`).get(this.workspaceId, taskId).value;
        if (count >= maxCalls) throw new CalculationReceiptConflictError("number tool call limit exceeded");
        this.database.prepare(`INSERT INTO translation_calculation_receipts
          (workspace_id, receipt_digest, task_id, request_digest, request_json, receipt_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(this.workspaceId, receipt.receiptDigest, taskId, requestDigest,
          requestJson, receiptJson, this.now().toISOString());
      })();
    } catch (error) {
      if (error instanceof CalculationReceiptConflictError) throw error;
      const concurrent = this.find(taskId, request);
      if (!concurrent || concurrent.receiptDigest !== receipt.receiptDigest || stableJson(concurrent) !== receiptJson) {
        throw new CalculationReceiptConflictError("calculation receipt persistence conflict");
      }
      return concurrent;
    }
    return receipt;
  }
}
