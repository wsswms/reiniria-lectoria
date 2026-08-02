import { randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import {
  assertBudgetCategory,
  budgetUsageContract,
  contentDigest,
  flowBudgetPolicyContract,
  FLOW_BUDGET_CATEGORIES,
  M5C_CONTRACT_VERSION,
} from "./contracts.mjs";

export class FlowBudgetConflictError extends Error {
  constructor(message = "translation flow budget conflict") {
    super(message); this.name = "FlowBudgetConflictError"; this.code = "FLOW_BUDGET_CONFLICT";
  }
}

const zero = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, costMicrosCny: 0, costMicrosUsd: 0, durationMs: 0 });
const keys = Object.freeze(Object.keys(zero()));
const plus = (target, usage) => { for (const key of keys) target[key] += usage[key]; return target; };

function user(input) {
  if (!input || input.type !== "user" || typeof input.id !== "string" || input.id.length === 0) throw new FlowBudgetConflictError("only a user can authorize a flow budget");
  return input;
}

export class TranslationFlowBudgetService {
  constructor(database, trustedWorkspaceId, { id = () => randomUUID(), now = () => new Date() } = {}) {
    this.database = database; this.workspaceId = trustedWorkspaceId; this.id = id; this.now = now;
  }

  create(workflowId, limits, actorInput) {
    const by = user(actorInput);
    const policy = flowBudgetPolicyContract({ schemaVersion: M5C_CONTRACT_VERSION, workflowId, revision: 1,
      ...limits, authorizedBy: by, createdAt: this.now().toISOString() });
    const revisionId = this.id();
    const json = stableJson(policy);
    try {
      this.database.transaction(() => {
        this.database.prepare("INSERT INTO flow_budget_policy_revisions VALUES (?, ?, ?, 1, ?, ?, 'user', ?, ?)")
          .run(this.workspaceId, revisionId, workflowId, json, contentDigest(policy), by.id, policy.createdAt);
        this.database.prepare("INSERT INTO flow_budget_policy_heads VALUES (?, ?, ?, 1, 0, ?)")
          .run(this.workspaceId, workflowId, revisionId, policy.createdAt);
      }).immediate();
    } catch (error) { throw new FlowBudgetConflictError(String(error?.message ?? error)); }
    return this.get(workflowId);
  }

  expand(workflowId, expectedVersion, limits, actorInput) {
    const by = user(actorInput);
    const current = this.get(workflowId);
    const policy = flowBudgetPolicyContract({ schemaVersion: M5C_CONTRACT_VERSION, workflowId, revision: current.policy.revision + 1,
      ...limits, authorizedBy: by, createdAt: this.now().toISOString() });
    this.#assertNonDecreasing(current.policy, policy);
    const revisionId = this.id();
    const json = stableJson(policy);
    try {
      this.database.transaction(() => {
        this.database.prepare("INSERT INTO flow_budget_policy_revisions VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?)")
          .run(this.workspaceId, revisionId, workflowId, policy.revision, json, contentDigest(policy), by.id, policy.createdAt);
        const changed = this.database.prepare("UPDATE flow_budget_policy_heads SET policy_revision_id = ?, revision = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND version = ?")
          .run(revisionId, policy.revision, policy.createdAt, this.workspaceId, workflowId, expectedVersion).changes;
        if (changed !== 1) throw new FlowBudgetConflictError("budget policy version conflict");
      }).immediate();
    } catch (error) { if (error instanceof FlowBudgetConflictError) throw error; throw new FlowBudgetConflictError(String(error?.message ?? error)); }
    return this.get(workflowId);
  }

  reserve(workflowId, categoryInput, reservationId, usageInput, details = {}) {
    const category = assertBudgetCategory(categoryInput);
    const usage = budgetUsageContract(usageInput);
    if (typeof reservationId !== "string" || reservationId.length === 0) throw new TypeError("reservationId is required");
    const timestamp = this.now().toISOString();
    return this.database.transaction(() => {
      const existing = this.database.prepare("SELECT category, entry_type AS entryType, usage_json AS usageJson FROM flow_budget_ledger WHERE workspace_id = ? AND workflow_id = ? AND reservation_id = ? ORDER BY rowid")
        .all(this.workspaceId, workflowId, reservationId);
      if (existing.length) {
        const first = existing[0];
        if (first.category !== category || stableJson(JSON.parse(first.usageJson).requested) !== stableJson(usage)) throw new FlowBudgetConflictError("reservation idempotency conflict");
        return Object.freeze({ decision: first.entryType === "released" ? "released" : first.entryType, reservationId, reused: true, usage: Object.freeze(usage) });
      }
      const snapshot = this.#snapshot(workflowId);
      this.#assertAvailable(snapshot, category, usage);
      this.database.prepare("INSERT INTO flow_budget_ledger VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, this.id(), workflowId, snapshot.policyRevisionId, reservationId, category,
          usage.calls, usage.inputTokens, usage.outputTokens, usage.costMicrosCny, usage.costMicrosUsd, usage.durationMs,
          stableJson({ requested: usage, details }), timestamp);
      return Object.freeze({ decision: "reserved", reservationId, reused: false, usage: Object.freeze(usage) });
    }).immediate();
  }

  settle(workflowId, reservationId, actualUsage, details = {}) { return this.#terminal(workflowId, reservationId, "settled", actualUsage, details); }
  unknown(workflowId, reservationId, details = {}) { return this.#terminal(workflowId, reservationId, "unknown", null, details); }
  release(workflowId, reservationId, details = {}) { return this.#terminal(workflowId, reservationId, "released", null, details); }

  get(workflowId) {
    const row = this.database.prepare(`SELECT head.policy_revision_id AS policyRevisionId, head.version,
      revision.policy_json AS policyJson FROM flow_budget_policy_heads head JOIN flow_budget_policy_revisions revision
      ON revision.workspace_id = head.workspace_id AND revision.policy_revision_id = head.policy_revision_id
      WHERE head.workspace_id = ? AND head.workflow_id = ?`).get(this.workspaceId, workflowId);
    if (!row) throw new FlowBudgetConflictError("flow budget not found");
    const snapshot = this.#snapshot(workflowId);
    return Object.freeze({ policyRevisionId: row.policyRevisionId, version: row.version, policy: flowBudgetPolicyContract(JSON.parse(row.policyJson)), ...snapshot });
  }

  #terminal(workflowId, reservationId, entryType, actualInput, details) {
    const timestamp = this.now().toISOString();
    return this.database.transaction(() => {
      const rows = this.database.prepare("SELECT * FROM flow_budget_ledger WHERE workspace_id = ? AND workflow_id = ? AND reservation_id = ? ORDER BY rowid")
        .all(this.workspaceId, workflowId, reservationId);
      if (!rows.length || rows[0].entry_type !== "reserved") throw new FlowBudgetConflictError("active reservation not found");
      const terminal = rows.find((row) => row.entry_type !== "reserved");
      if (terminal) {
        if (terminal.entry_type !== entryType) throw new FlowBudgetConflictError("reservation already finalized differently");
        return Object.freeze({ decision: entryType, reservationId, reused: true });
      }
      const requested = budgetUsageContract(JSON.parse(rows[0].usage_json).requested);
      const actual = actualInput === null ? (entryType === "released" ? zero() : requested) : budgetUsageContract(actualInput);
      if (entryType === "settled") {
        const snapshot = this.#snapshot(workflowId, reservationId);
        this.#assertAvailable(snapshot, rows[0].category, actual);
      }
      this.database.prepare("INSERT INTO flow_budget_ledger VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, this.id(), workflowId, rows[0].policy_revision_id, reservationId, rows[0].category, entryType,
          actual.calls, actual.inputTokens, actual.outputTokens, actual.costMicrosCny, actual.costMicrosUsd, actual.durationMs,
          stableJson({ requested, actual, details }), timestamp);
      return Object.freeze({ decision: entryType, reservationId, reused: false, usage: Object.freeze(actual) });
    }).immediate();
  }

  #snapshot(workflowId, excludeReservationId = null) {
    const head = this.database.prepare(`SELECT head.policy_revision_id AS policyRevisionId, revision.policy_json AS policyJson
      FROM flow_budget_policy_heads head JOIN flow_budget_policy_revisions revision
      ON revision.workspace_id = head.workspace_id AND revision.policy_revision_id = head.policy_revision_id
      WHERE head.workspace_id = ? AND head.workflow_id = ?`).get(this.workspaceId, workflowId);
    if (!head) throw new FlowBudgetConflictError("flow budget not found");
    const policy = flowBudgetPolicyContract(JSON.parse(head.policyJson));
    const rows = this.database.prepare("SELECT reservation_id AS reservationId, category, entry_type AS entryType, calls, input_tokens AS inputTokens, output_tokens AS outputTokens, cost_micros_cny AS costMicrosCny, cost_micros_usd AS costMicrosUsd, duration_ms AS durationMs FROM flow_budget_ledger WHERE workspace_id = ? AND workflow_id = ? ORDER BY rowid")
      .all(this.workspaceId, workflowId);
    const latest = new Map(); for (const row of rows) if (row.reservationId !== excludeReservationId) latest.set(row.reservationId, row);
    const totals = zero(); const categories = Object.fromEntries(FLOW_BUDGET_CATEGORIES.map((name) => [name, zero()])); let unknownOutcomes = 0;
    for (const row of latest.values()) {
      if (row.entryType === "released") continue;
      plus(totals, row); plus(categories[row.category], row); if (row.entryType === "unknown") unknownOutcomes += 1;
    }
    return Object.freeze({ policyRevisionId: head.policyRevisionId, totals: Object.freeze(totals), categories: Object.freeze(Object.fromEntries(Object.entries(categories).map(([key, value]) => [key, Object.freeze(value)]))), unknownOutcomes });
  }

  #assertAvailable(snapshot, category, usage) {
    if (snapshot.unknownOutcomes >= this.#policy(snapshot.policyRevisionId).maxUnknownOutcomes) throw new FlowBudgetConflictError("unknown outcome stop line reached");
    const policy = this.#policy(snapshot.policyRevisionId); const limits = policy.categories[category];
    for (const key of keys) {
      const totalKey = `max${key[0].toUpperCase()}${key.slice(1)}`;
      if (snapshot.totals[key] + usage[key] > policy[totalKey]) throw new FlowBudgetConflictError(`flow ${key} budget exceeded`);
      if (snapshot.categories[category][key] + usage[key] > limits[totalKey]) throw new FlowBudgetConflictError(`${category} ${key} budget exceeded`);
    }
  }

  #policy(policyRevisionId) {
    const row = this.database.prepare("SELECT policy_json AS policyJson FROM flow_budget_policy_revisions WHERE workspace_id = ? AND policy_revision_id = ?")
      .get(this.workspaceId, policyRevisionId);
    if (!row) throw new FlowBudgetConflictError("flow budget policy not found");
    return flowBudgetPolicyContract(JSON.parse(row.policyJson));
  }

  #assertNonDecreasing(previous, next) {
    for (const key of ["maxCalls", "maxInputTokens", "maxOutputTokens", "maxCostMicrosCny", "maxCostMicrosUsd", "maxDurationMs", "maxResearchCycles", "maxQaCycles", "maxRetranslations", "maxUnknownOutcomes"])
      if (next[key] < previous[key]) throw new FlowBudgetConflictError("budget expansion cannot reduce an existing limit");
    for (const category of FLOW_BUDGET_CATEGORIES) for (const key of keys)
      if (next.categories[category][`max${key[0].toUpperCase()}${key.slice(1)}`] < previous.categories[category][`max${key[0].toUpperCase()}${key.slice(1)}`])
        throw new FlowBudgetConflictError("budget expansion cannot reduce a category limit");
  }
}
