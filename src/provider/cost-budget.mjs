import { randomUUID } from "node:crypto";

function nonNegative(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function required(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function amount(rate, tokens) {
  return BigInt(rate) * BigInt(tokens);
}

function micros(snapshot, usage) {
  const uncached = usage.inputTokens - usage.cachedInputTokens;
  const numerator = amount(snapshot.input_micros_per_million, uncached)
    + amount(snapshot.cached_input_micros_per_million, usage.cachedInputTokens)
    + amount(snapshot.output_micros_per_million, usage.outputTokens);
  const result = (numerator + 999_999n) / 1_000_000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("calculated cost exceeds safe integer range");
  return Number(result);
}

export class PricingBudgetService {
  constructor(database, trustedWorkspaceId, { now = () => new Date(), id = () => randomUUID() } = {}) {
    this.database = database;
    this.workspaceId = required(trustedWorkspaceId, "trustedWorkspaceId");
    this.now = now;
    this.id = id;
  }

  addPricing(input) {
    const timestamp = this.now().toISOString();
    this.database.prepare("INSERT INTO pricing_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      this.workspaceId, required(input.providerId, "providerId"), required(input.modelId, "modelId"),
      required(input.pricingVersion, "pricingVersion"), required(input.currency, "currency").toUpperCase(),
      nonNegative(input.inputMicrosPerMillion, "inputMicrosPerMillion"),
      nonNegative(input.outputMicrosPerMillion, "outputMicrosPerMillion"),
      nonNegative(input.cachedInputMicrosPerMillion, "cachedInputMicrosPerMillion"),
      required(input.source, "source"), timestamp,
    );
    return Object.freeze({ ...input, currency: input.currency.toUpperCase(), createdAt: timestamp });
  }

  addPolicy(input) {
    const currency = required(input.currency, "currency").toUpperCase();
    const soft = nonNegative(input.softLimitMicros, "softLimitMicros");
    const hard = nonNegative(input.hardLimitMicros, "hardLimitMicros");
    if (hard < soft) throw new TypeError("hardLimitMicros cannot be below softLimitMicros");
    if (!["pause", "block"].includes(input.unknownPriceAction)) throw new TypeError("unknownPriceAction is invalid");
    this.database.prepare("INSERT INTO budget_policy_snapshots VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      this.workspaceId, required(input.policyVersion, "policyVersion"), currency, soft, hard,
      input.unknownPriceAction, this.now().toISOString(),
    );
    return Object.freeze({ policyVersion: input.policyVersion, currency, softLimitMicros: soft, hardLimitMicros: hard });
  }

  assignTask(taskId, policyVersion, { softLimitMicros = null, hardLimitMicros = null } = {}) {
    if ((softLimitMicros === null) !== (hardLimitMicros === null)) throw new TypeError("task limits must be supplied together");
    if (softLimitMicros !== null) {
      nonNegative(softLimitMicros, "softLimitMicros");
      nonNegative(hardLimitMicros, "hardLimitMicros");
      if (hardLimitMicros < softLimitMicros) throw new TypeError("task hard limit cannot be below soft limit");
    }
    this.database.prepare("INSERT INTO task_budget_assignments VALUES (?, ?, ?, ?, ?, 'active', 0)")
      .run(this.workspaceId, taskId, policyVersion, softLimitMicros, hardLimitMicros);
    return this.getTaskBudget(taskId);
  }

  quote(providerId, modelId, pricingVersion, usageInput) {
    const usage = {
      inputTokens: nonNegative(usageInput.inputTokens, "inputTokens"),
      outputTokens: nonNegative(usageInput.outputTokens, "outputTokens"),
      cachedInputTokens: nonNegative(usageInput.cachedInputTokens ?? 0, "cachedInputTokens"),
    };
    if (usage.cachedInputTokens > usage.inputTokens) throw new TypeError("cachedInputTokens cannot exceed inputTokens");
    const snapshot = this.database.prepare("SELECT * FROM pricing_snapshots WHERE workspace_id = ? AND provider_id = ? AND model_id = ? AND pricing_version = ?")
      .get(this.workspaceId, providerId, modelId, pricingVersion);
    if (!snapshot) return Object.freeze({ status: "unknown-price", amountMicros: null, currency: null, pricingVersion });
    return Object.freeze({ status: "priced", amountMicros: micros(snapshot, usage), currency: snapshot.currency, pricingVersion, ...usage });
  }

  authorizeSoftLimit(taskId, actor) {
    if (!actor || actor.type !== "user" || typeof actor.id !== "string" || actor.id.length === 0) throw new TypeError("only a user can authorize budget continuation");
    const authorizationId = this.id();
    this.database.transaction(() => {
      const assignment = this.database.prepare("SELECT state, version FROM task_budget_assignments WHERE workspace_id = ? AND task_id = ?").get(this.workspaceId, taskId);
      if (!assignment || assignment.state !== "soft-paused") throw new Error("task is not soft-paused");
      this.database.prepare("INSERT INTO budget_soft_approvals VALUES (?, ?, ?, 'user', ?, ?)")
        .run(this.workspaceId, authorizationId, taskId, actor.id, this.now().toISOString());
      this.database.prepare("UPDATE task_budget_assignments SET state = 'active', version = version + 1 WHERE workspace_id = ? AND task_id = ? AND version = ?")
        .run(this.workspaceId, taskId, assignment.version);
      this.database.prepare("UPDATE translation_tasks SET state = 'queued', version = version + 1, updated_at = ? WHERE workspace_id = ? AND task_id = ? AND state = 'paused'")
        .run(this.now().toISOString(), this.workspaceId, taskId);
    })();
    return authorizationId;
  }

  acknowledgeUnknown(taskId, actor) {
    if (!actor || actor.type !== "user" || typeof actor.id !== "string" || actor.id.length === 0) throw new TypeError("only a user can acknowledge unknown cost");
    return this.database.transaction(() => {
      const assignment = this.database.prepare("SELECT state, version FROM task_budget_assignments WHERE workspace_id = ? AND task_id = ?")
        .get(this.workspaceId, taskId);
      if (!assignment || assignment.state !== "unknown-paused") throw new Error("task has no unknown cost to acknowledge");
      this.database.prepare("UPDATE task_budget_assignments SET state = 'active', version = version + 1 WHERE workspace_id = ? AND task_id = ? AND version = ?")
        .run(this.workspaceId, taskId, assignment.version);
      this.database.prepare("UPDATE translation_tasks SET state = 'queued', version = version + 1, updated_at = ? WHERE workspace_id = ? AND task_id = ? AND state = 'paused'")
        .run(this.now().toISOString(), this.workspaceId, taskId);
      this.database.prepare("UPDATE task_execution_policies SET offline_reason = NULL WHERE workspace_id = ? AND task_id = ?")
        .run(this.workspaceId, taskId);
      return Object.freeze({ taskId, state: "active", acknowledgedBy: actor.id });
    })();
  }

  reserve(attemptId, pricingVersion, estimate, { authorizationId = null } = {}) {
    return this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT attempt.*, runtime.provider_call_state, assignment.policy_version,
               assignment.task_soft_limit_micros, assignment.task_hard_limit_micros,
               assignment.state AS budget_state, assignment.version AS budget_version,
               policy.currency, policy.soft_limit_micros, policy.hard_limit_micros,
               policy.unknown_price_action
        FROM translation_attempts attempt
        JOIN attempt_runtime_states runtime ON runtime.workspace_id = attempt.workspace_id AND runtime.attempt_id = attempt.attempt_id
        JOIN task_budget_assignments assignment ON assignment.workspace_id = attempt.workspace_id AND assignment.task_id = attempt.task_id
        JOIN budget_policy_snapshots policy ON policy.workspace_id = assignment.workspace_id AND policy.policy_version = assignment.policy_version
        WHERE attempt.workspace_id = ? AND attempt.attempt_id = ?
      `).get(this.workspaceId, attemptId);
      if (!row || row.provider_call_state !== "not-started" || !["queued", "leased"].includes(row.state)) throw new Error("attempt is not reservable");
      const quote = this.quote(row.provider_id, row.model_id, pricingVersion, estimate);
      if (quote.status !== "priced" || quote.currency !== row.currency) {
        this.#pause(row, "unknown-paused", `unknown-price:${row.provider_id}:${row.model_id}`);
        return Object.freeze({ decision: row.unknown_price_action === "block" ? "blocked-unknown-price" : "paused-unknown-price", amountMicros: null });
      }
      const workspaceSpent = this.database.prepare("SELECT coalesce(sum(coalesce(actual_amount_micros, estimated_amount_micros)), 0) AS total FROM budget_reservations WHERE workspace_id = ? AND currency = ? AND state IN ('reserved','consumed','unknown')")
        .get(this.workspaceId, row.currency).total;
      const taskSpent = this.database.prepare("SELECT coalesce(sum(coalesce(actual_amount_micros, estimated_amount_micros)), 0) AS total FROM budget_reservations WHERE workspace_id = ? AND task_id = ? AND currency = ? AND state IN ('reserved','consumed','unknown')")
        .get(this.workspaceId, row.task_id, row.currency).total;
      const workspaceProjected = workspaceSpent + quote.amountMicros;
      const taskProjected = taskSpent + quote.amountMicros;
      const hardExceeded = workspaceProjected > row.hard_limit_micros ||
        (row.task_hard_limit_micros !== null && taskProjected > row.task_hard_limit_micros);
      if (hardExceeded) {
        this.#pause(row, "hard-blocked", "budget-hard-limit");
        return Object.freeze({ decision: "blocked-hard-limit", amountMicros: quote.amountMicros, workspaceProjected, taskProjected });
      }
      const softExceeded = workspaceProjected > row.soft_limit_micros ||
        (row.task_soft_limit_micros !== null && taskProjected > row.task_soft_limit_micros);
      if (softExceeded) {
        const authorization = authorizationId && this.database.prepare("SELECT 1 FROM budget_soft_approvals WHERE workspace_id = ? AND approval_id = ? AND task_id = ?")
          .get(this.workspaceId, authorizationId, row.task_id);
        if (!authorization) {
          this.#pause(row, "soft-paused", "budget-soft-limit");
          return Object.freeze({ decision: "paused-soft-limit", amountMicros: quote.amountMicros, workspaceProjected, taskProjected });
        }
      }
      const reservationId = this.id();
      this.database.prepare("INSERT INTO budget_reservations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'reserved', 0, ?, NULL)").run(
        this.workspaceId, reservationId, row.task_id, attemptId, row.provider_id, row.model_id,
        pricingVersion, quote.currency, quote.inputTokens, quote.outputTokens, quote.cachedInputTokens,
        quote.amountMicros, authorizationId, this.now().toISOString(),
      );
      return Object.freeze({ decision: "reserved", reservationId, amountMicros: quote.amountMicros, currency: quote.currency, workspaceProjected, taskProjected });
    })();
  }

  finalize(reservationId, usageRecordId) {
    return this.database.transaction(() => {
      const reservation = this.database.prepare("SELECT * FROM budget_reservations WHERE workspace_id = ? AND reservation_id = ?").get(this.workspaceId, reservationId);
      if (!reservation || !["reserved", "unknown"].includes(reservation.state)) throw new Error("reservation is not finalizable");
      const usage = usageRecordId && this.database.prepare("SELECT * FROM usage_cost_records WHERE workspace_id = ? AND usage_record_id = ? AND attempt_id = ?")
        .get(this.workspaceId, usageRecordId, reservation.attempt_id);
      if (!usage || usage.amount_micros === null || usage.currency !== reservation.currency || usage.pricing_version !== reservation.pricing_version) {
        this.database.prepare("UPDATE budget_reservations SET state = 'unknown', version = version + 1, usage_record_id = ?, finalized_at = ? WHERE workspace_id = ? AND reservation_id = ?")
          .run(usage?.usage_record_id ?? null, this.now().toISOString(), this.workspaceId, reservationId);
        this.database.prepare("UPDATE task_budget_assignments SET state = 'unknown-paused', version = version + 1 WHERE workspace_id = ? AND task_id = ?")
          .run(this.workspaceId, reservation.task_id);
        return Object.freeze({ state: "unknown", actualAmountMicros: null, varianceMicros: null });
      }
      this.database.prepare("UPDATE budget_reservations SET state = 'consumed', version = version + 1, actual_amount_micros = ?, usage_record_id = ?, finalized_at = ? WHERE workspace_id = ? AND reservation_id = ?")
        .run(usage.amount_micros, usageRecordId, this.now().toISOString(), this.workspaceId, reservationId);
      return Object.freeze({ state: "consumed", actualAmountMicros: usage.amount_micros, varianceMicros: usage.amount_micros - reservation.estimated_amount_micros });
    })();
  }

  release(reservationId) {
    const changed = this.database.prepare("UPDATE budget_reservations SET state = 'released', version = version + 1, finalized_at = ? WHERE workspace_id = ? AND reservation_id = ? AND state IN ('reserved','unknown')")
      .run(this.now().toISOString(), this.workspaceId, reservationId);
    if (changed.changes !== 1) throw new Error("reservation is not releasable");
  }

  pricedUsage(providerId, modelId, pricingVersion, usage) {
    const quote = this.quote(providerId, modelId, pricingVersion, usage);
    return quote.status === "priced" ? Object.freeze({ ...usage, currency: quote.currency, amountMicros: quote.amountMicros, pricingVersion }) : Object.freeze({ ...usage, currency: null, amountMicros: null, pricingVersion: null });
  }

  getTaskBudget(taskId) {
    const row = this.database.prepare("SELECT * FROM task_budget_assignments WHERE workspace_id = ? AND task_id = ?").get(this.workspaceId, taskId);
    if (!row) throw new Error("task budget not found");
    return Object.freeze(row);
  }

  #pause(row, state, reason) {
    this.database.prepare("UPDATE task_budget_assignments SET state = ?, version = version + 1 WHERE workspace_id = ? AND task_id = ?")
      .run(state, this.workspaceId, row.task_id);
    this.database.prepare("UPDATE translation_tasks SET state = 'paused', version = version + 1, updated_at = ? WHERE workspace_id = ? AND task_id = ? AND state IN ('queued','running')")
      .run(this.now().toISOString(), this.workspaceId, row.task_id);
    this.database.prepare("UPDATE task_execution_policies SET offline_reason = ? WHERE workspace_id = ? AND task_id = ?")
      .run(reason, this.workspaceId, row.task_id);
  }
}
