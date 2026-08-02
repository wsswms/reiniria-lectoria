import { createHash, randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { ResearchAuthorizationError, ResearchConflictError } from "./foundation-service.mjs";
import { WebSearchArtifactService } from "./web-search-artifact-service.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export class ResearchToolGateway {
  constructor(database, workspaceId, { capabilities, budgets, evidence, adapters, artifacts, now = () => new Date(), id = randomUUID } = {}) {
    if (!capabilities || !budgets || !evidence || !(adapters instanceof Map)) throw new TypeError("research gateway dependencies are required");
    this.database = database; this.workspaceId = workspaceId; this.capabilities = capabilities; this.budgets = budgets;
    this.evidence = evidence; this.adapters = adapters; this.artifacts = artifacts ?? new WebSearchArtifactService(database, workspaceId, { now });
    this.now = now; this.id = id;
  }

  async search(token, runId, input) {
    this.capabilities.verify(token, { runId, tool: "propose-query", capability: "search", providerId: input.providerId });
    const adapter = this.#adapter(input.providerId, "search");
    const estimate = adapter.estimatedUsage ?? { searchCalls: 1, contentUrls: 0, modelTokens: 0, costMicrosUsd: 0 };
    const reservation = this.budgets.reserve(runId, { round: input.round, capability: "search", providerId: input.providerId,
      query: input.query, language: input.language, country: input.country, idempotencyKey: input.idempotencyKey,
      estimate });
    if (reservation.entries.length !== 1 || reservation.entries[0].entryType !== "reserved") throw new ResearchConflictError("terminal tool receipt cannot execute twice");
    try {
      const response = await adapter.search({ query: input.query, count: input.count, country: input.country, searchLanguage: input.language });
      const artifacts = this.artifacts.recordResearch(reservation.queryId, response);
      this.budgets.settle(reservation.queryId, response.usage, { responseDigest: response.responseDigest, adapterVersion: response.adapterVersion });
      return Object.freeze({ ...response, queryId: reservation.queryId, artifactRunId: artifacts.artifactRunId, results: artifacts.results });
    } catch (error) {
      this.budgets.unknown(reservation.queryId, estimate, { category: error?.category ?? "unknown" });
      throw error;
    }
  }

  async extract(token, runId, input) {
    this.capabilities.verify(token, { runId, tool: "select-source", capability: "extract", providerId: input.providerId });
    const adapter = this.#adapter(input.providerId, "extract");
    const reservation = this.budgets.reserve(runId, { round: input.round, capability: "extract", providerId: input.providerId,
      query: input.url, language: input.language, country: input.country, idempotencyKey: input.idempotencyKey,
      estimate: { searchCalls: 0, contentUrls: 1, modelTokens: 0, costMicrosUsd: 0 } });
    if (reservation.entries.length !== 1 || reservation.entries[0].entryType !== "reserved") throw new ResearchConflictError("terminal tool receipt cannot execute twice");
    try {
      const response = await adapter.extract({ url: input.url });
      const snapshotId = sha(stableJson({ runId, queryId: reservation.queryId, providerId: input.providerId, url: response.url, contentDigest: response.contentDigest }));
      const snapshotCanonical = { runId, queryId: reservation.queryId, providerId: input.providerId, url: response.url,
        contentDigest: response.contentDigest, lineage: "provider-processed" };
      this.database.prepare(`INSERT OR IGNORE INTO provider_content_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'provider-processed', 1, ?)`)
        .run(this.workspaceId, snapshotId, runId, reservation.queryId, input.providerId, response.url, response.content,
          response.contentDigest, sha(stableJson(snapshotCanonical)), this.now().toISOString());
      this.budgets.settle(reservation.queryId, response.usage, { snapshotId, adapterVersion: response.adapterVersion });
      return Object.freeze({ ...response, snapshotId, queryId: reservation.queryId });
    } catch (error) {
      this.budgets.unknown(reservation.queryId, { searchCalls: 0, contentUrls: 1, modelTokens: 0, costMicrosUsd: 0 }, { category: error?.category ?? "unknown" });
      throw error;
    }
  }

  async reason(token, runId, input) {
    this.capabilities.verify(token, { runId, tool: "submit-report", capability: "research-model", providerId: input.providerId });
    const adapter = this.#adapter(input.providerId, "reason");
    const estimatedTokens = Math.max(1, Math.ceil(input.prompt.length / 4));
    const estimate = typeof adapter.estimateReason === "function" ? adapter.estimateReason(input)
      : { searchCalls: 0, contentUrls: 0, modelTokens: estimatedTokens, costMicrosUsd: 0 };
    const reservation = this.budgets.reserve(runId, { round: input.round, capability: "research-model", providerId: input.providerId,
      query: "structured-research-reasoning", language: input.language, country: input.country, idempotencyKey: input.idempotencyKey,
      estimate });
    if (reservation.entries.length !== 1 || reservation.entries[0].entryType !== "reserved") throw new ResearchConflictError("terminal tool receipt cannot execute twice");
    try {
      const response = await adapter.reason({ prompt: input.prompt, fixture: input.fixture });
      this.budgets.settle(reservation.queryId, response.usage, { adapterVersion: response.adapterVersion });
      return response;
    } catch (error) {
      this.budgets.unknown(reservation.queryId, estimate, { category: error?.category ?? "unknown" });
      throw error;
    }
  }

  #adapter(providerId, method) {
    const adapter = this.adapters.get(providerId);
    if (!adapter || typeof adapter[method] !== "function") throw new ResearchAuthorizationError("research adapter is unavailable");
    return adapter;
  }
}
