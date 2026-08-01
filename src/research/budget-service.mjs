import { createHash, randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { ResearchConflictError, ResearchFoundationService } from "./foundation-service.mjs";
import { ResearchRunService } from "./run-service.mjs";
import { researchQueryContract } from "./contracts.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const METRICS = Object.freeze(["searchCalls", "contentUrls", "modelTokens", "costMicrosUsd"]);

function usage(input, name = "usage") {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !METRICS.includes(key))) throw new TypeError(`${name} is invalid`);
  const output = {};
  for (const metric of METRICS) {
    const value = input[metric] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name}.${metric} is invalid`);
    output[metric] = value;
  }
  return Object.freeze(output);
}

function totals(database, workspaceId, grantId, providerId = null) {
  const rows = database.prepare(`SELECT query.provider_id AS providerId, ledger.query_id AS queryId, ledger.entry_type AS entryType,
    ledger.search_calls AS searchCalls, ledger.content_urls AS contentUrls, ledger.model_tokens AS modelTokens,
    ledger.cost_micros_usd AS costMicrosUsd FROM research_budget_ledger AS ledger
    JOIN research_queries AS query ON query.workspace_id = ledger.workspace_id AND query.query_id = ledger.query_id
    WHERE ledger.workspace_id = ? AND ledger.grant_id = ? ${providerId === null ? "" : "AND query.provider_id = ?"}
    ORDER BY ledger.query_id`).all(...(providerId === null ? [workspaceId, grantId] : [workspaceId, grantId, providerId]));
  const byQuery = new Map();
  for (const row of rows) {
    const entries = byQuery.get(row.queryId) ?? new Map(); entries.set(row.entryType, row); byQuery.set(row.queryId, entries);
  }
  const output = { searchCalls: 0, contentUrls: 0, modelTokens: 0, costMicrosUsd: 0 };
  for (const entries of byQuery.values()) {
    if (entries.has("released")) continue;
    const row = entries.get("unknown") ?? entries.get("settled") ?? entries.get("reserved");
    if (row) for (const metric of METRICS) output[metric] += row[metric];
  }
  return Object.freeze(output);
}

export class ResearchBudgetService {
  constructor(database, workspaceId, { now = () => new Date(), id = randomUUID } = {}) {
    this.database = database; this.workspaceId = workspaceId; this.now = now; this.id = id;
    this.foundation = new ResearchFoundationService(database, workspaceId, { now, id });
    this.runs = new ResearchRunService(database, workspaceId, { now, id });
  }

  reserve(runId, input) {
    const allowed = ["round", "capability", "providerId", "query", "language", "country", "idempotencyKey", "estimate"];
    if (!input || typeof input !== "object" || Object.keys(input).some((key) => !allowed.includes(key))) throw new TypeError("reservation input is invalid");
    const estimate = usage(input.estimate, "estimate");
    const run = this.runs.get(runId);
    if (run.state !== "running") throw new ResearchConflictError("run is not running");
    const { grant, status } = this.foundation.getGrant(run.grantId);
    if (status !== "active" || this.now().toISOString() >= run.deadlineAt) throw new ResearchConflictError("grant or run is no longer active");
    const provider = grant.providers.find((item) => item.capability === input.capability && item.providerId === input.providerId);
    if (!provider) throw new ResearchConflictError("provider capability is outside the grant");
    if (!Number.isInteger(input.round) || input.round < 1 || input.round > grant.limits.maxRounds) throw new ResearchConflictError("round is outside the grant");
    const queryId = this.id();
    const queryCanonical = researchQueryContract({ schemaVersion: "1.0", queryId, runId, round: input.round,
      capability: input.capability, providerId: input.providerId, query: input.query, language: input.language,
      country: input.country, requestDigest: sha(stableJson({ runId, input })), idempotencyKey: input.idempotencyKey });
    const existing = this.database.prepare("SELECT query_id AS queryId FROM research_queries WHERE workspace_id = ? AND run_id = ? AND idempotency_key = ?")
      .get(this.workspaceId, runId, input.idempotencyKey);
    if (existing) return this.get(existing.queryId);
    try {
      this.database.transaction(() => {
        const consumed = totals(this.database, this.workspaceId, run.grantId);
        const providerConsumed = totals(this.database, this.workspaceId, run.grantId, input.providerId);
        const mapping = { searchCalls: "maxSearchCalls", contentUrls: "maxContentUrls", modelTokens: "maxModelTokens", costMicrosUsd: "maxCostMicrosUsd" };
        for (const metric of METRICS) {
          if (consumed[metric] + estimate[metric] > grant.limits[mapping[metric]]) throw new ResearchConflictError(`grant ${metric} budget exceeded`);
          if (providerConsumed[metric] + estimate[metric] > provider.budget[mapping[metric]]) throw new ResearchConflictError(`provider ${metric} budget exceeded`);
        }
        this.database.prepare("INSERT INTO research_queries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(this.workspaceId, queryId, runId, input.round, input.capability, input.providerId, input.query,
            queryCanonical.requestDigest, input.idempotencyKey, this.now().toISOString());
        this.#entry(run.grantId, runId, queryId, "reserved", estimate, { estimate });
      })();
    } catch (error) { if (error instanceof ResearchConflictError) throw error; throw new ResearchConflictError("budget reservation conflict"); }
    return this.get(queryId);
  }

  settle(queryId, actual, receipt = {}) { return this.#finish(queryId, "settled", usage(actual, "actual"), receipt); }
  unknown(queryId, conservative, receipt = {}) { return this.#finish(queryId, "unknown", usage(conservative, "conservative"), receipt); }

  release(queryId, receipt = {}) {
    const current = this.get(queryId);
    if (current.entries.some((item) => item.entryType !== "reserved")) throw new ResearchConflictError("only an unconfirmed reservation can be released");
    this.#entry(current.grantId, current.runId, queryId, "released", { searchCalls: 0, contentUrls: 0, modelTokens: 0, costMicrosUsd: 0 }, receipt);
    return this.get(queryId);
  }

  get(queryId) {
    const query = this.database.prepare(`SELECT query.query_id AS queryId, query.run_id AS runId, run.grant_id AS grantId,
      query.provider_id AS providerId, query.capability, query.round, query.request_digest AS requestDigest,
      query.idempotency_key AS idempotencyKey FROM research_queries AS query JOIN research_runs AS run
      ON run.workspace_id = query.workspace_id AND run.run_id = query.run_id WHERE query.workspace_id = ? AND query.query_id = ?`)
      .get(this.workspaceId, queryId);
    if (!query) throw new ResearchConflictError("budget query not found");
    const entries = this.database.prepare(`SELECT entry_type AS entryType, search_calls AS searchCalls, content_urls AS contentUrls,
      model_tokens AS modelTokens, cost_micros_usd AS costMicrosUsd, usage_json AS usageJson, occurred_at AS occurredAt
      FROM research_budget_ledger WHERE workspace_id = ? AND query_id = ? ORDER BY occurred_at, entry_type`).all(this.workspaceId, queryId)
      .map((row) => Object.freeze({ ...row, receipt: Object.freeze(JSON.parse(row.usageJson)) }));
    return Object.freeze({ ...query, entries: Object.freeze(entries) });
  }

  totals(grantId, providerId = null) { return totals(this.database, this.workspaceId, grantId, providerId); }

  #finish(queryId, type, actual, receipt) {
    const current = this.get(queryId);
    if (current.entries.length !== 1 || current.entries[0].entryType !== "reserved") throw new ResearchConflictError("query already has a terminal budget outcome");
    const reserved = current.entries[0];
    for (const metric of METRICS) if (actual[metric] > reserved[metric]) throw new ResearchConflictError("actual usage exceeds its hard reservation");
    this.#entry(current.grantId, current.runId, queryId, type, actual, receipt);
    return this.get(queryId);
  }

  #entry(grantId, runId, queryId, type, amount, receipt) {
    this.database.prepare("INSERT INTO research_budget_ledger VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.workspaceId, this.id(), grantId, runId, queryId, type, amount.searchCalls, amount.contentUrls,
        amount.modelTokens, amount.costMicrosUsd, stableJson(receipt), this.now().toISOString());
  }
}
