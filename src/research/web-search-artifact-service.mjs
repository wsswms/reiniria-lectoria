import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { searchResultContract } from "../search/contracts.mjs";
import { ResearchConflictError } from "./foundation-service.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function normalizedResults(results) {
  if (!Array.isArray(results) || results.length > 20) throw new TypeError("search results are invalid");
  return results.map((item, index) => {
    if (!item || item.rank !== index + 1 || typeof item.title !== "string" || typeof item.url !== "string" || typeof item.description !== "string") {
      throw new TypeError("search result is invalid");
    }
    const canonical = searchResultContract({ rank: item.rank, url: item.url, title: item.title, description: item.description });
    const url = canonical.url;
    return Object.freeze({ ...canonical, urlDigest: sha(url), resultDigest: sha(stableJson(canonical)) });
  });
}

export class WebSearchArtifactService {
  constructor(database, workspaceId, { now = () => new Date() } = {}) { this.database = database; this.workspaceId = workspaceId; this.now = now; }

  recordResearch(queryId, response, { policyVersion = "research-search-policy-v1" } = {}) {
    const query = this.database.prepare(`SELECT query.query_id AS queryId, query.run_id AS runId, query.request_digest AS queryDigest,
      query.provider_id AS providerId FROM research_queries query WHERE query.workspace_id = ? AND query.query_id = ?`)
      .get(this.workspaceId, queryId);
    if (!query || query.providerId !== response?.adapterId) throw new ResearchConflictError("search artifact query identity mismatch");
    return this.#record({ scopeKind: "research-query", investigationId: null, researchRunId: query.runId, researchQueryId: query.queryId,
      adapterId: response.adapterId, adapterVersion: response.adapterVersion, policyVersion, queryDigest: query.queryDigest, results: response.results });
  }

  recordLegacy(searchRunId) {
    const run = this.database.prepare(`SELECT search_run_id AS artifactRunId, investigation_id AS investigationId, adapter_id AS adapterId,
      adapter_version AS adapterVersion, policy_version AS policyVersion, query_digest AS queryDigest, result_set_digest AS resultSetDigest
      FROM internet_search_runs WHERE workspace_id = ? AND search_run_id = ?`).get(this.workspaceId, searchRunId);
    if (!run) throw new ResearchConflictError("legacy search run is unavailable");
    const results = this.database.prepare(`SELECT rank, url, title, description FROM internet_search_results
      WHERE workspace_id = ? AND search_run_id = ? ORDER BY rank`).all(this.workspaceId, searchRunId);
    return this.#record({ scopeKind: "legacy-investigation", investigationId: run.investigationId, researchRunId: null, researchQueryId: null,
      adapterId: run.adapterId, adapterVersion: run.adapterVersion, policyVersion: run.policyVersion, queryDigest: run.queryDigest,
      results, fixedRunId: run.artifactRunId, fixedResultSetDigest: run.resultSetDigest });
  }

  getResult(resultId) {
    const row = this.database.prepare(`SELECT result.result_id AS resultId, result.artifact_run_id AS artifactRunId, result.rank,
      result.url, result.url_digest AS urlDigest, result.title, result.description, result.result_digest AS resultDigest,
      run.scope_kind AS scopeKind, run.adapter_id AS adapterId, run.adapter_version AS adapterVersion,
      run.investigation_id AS investigationId, run.research_run_id AS researchRunId, run.research_query_id AS researchQueryId
      FROM web_search_artifact_results result JOIN web_search_artifact_runs run
        ON run.workspace_id = result.workspace_id AND run.artifact_run_id = result.artifact_run_id
      WHERE result.workspace_id = ? AND result.result_id = ?`).get(this.workspaceId, resultId);
    if (!row) throw new ResearchConflictError("search artifact result not found");
    return Object.freeze(row);
  }

  #record(input) {
    const results = normalizedResults(input.results);
    const resultSetDigest = input.fixedResultSetDigest ?? sha(stableJson(results.map(({ urlDigest, resultDigest, ...item }) => item)));
    const identity = { scopeKind: input.scopeKind, investigationId: input.investigationId, researchRunId: input.researchRunId,
      researchQueryId: input.researchQueryId, adapterId: input.adapterId, adapterVersion: input.adapterVersion,
      policyVersion: input.policyVersion, queryDigest: input.queryDigest, resultSetDigest };
    const artifactRunId = input.fixedRunId ?? sha(stableJson(identity));
    const timestamp = this.now().toISOString();
    this.database.transaction(() => {
      this.database.prepare("INSERT OR IGNORE INTO web_search_artifact_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, artifactRunId, input.scopeKind, input.investigationId, input.researchRunId, input.researchQueryId,
          input.adapterId, input.adapterVersion, input.policyVersion, input.queryDigest, resultSetDigest, timestamp);
      const insert = this.database.prepare("INSERT OR IGNORE INTO web_search_artifact_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      results.forEach((item) => {
        const resultId = input.fixedRunId
          ? this.database.prepare("SELECT result_id AS resultId FROM internet_search_results WHERE workspace_id = ? AND search_run_id = ? AND rank = ?")
            .get(this.workspaceId, input.fixedRunId, item.rank)?.resultId
          : sha(stableJson({ artifactRunId, rank: item.rank, resultDigest: item.resultDigest }));
        insert.run(this.workspaceId, artifactRunId, resultId, item.rank, item.url, item.urlDigest, item.title, item.description, item.resultDigest, timestamp);
      });
    })();
    const resultIds = this.database.prepare("SELECT result_id AS resultId FROM web_search_artifact_results WHERE workspace_id = ? AND artifact_run_id = ? ORDER BY rank")
      .all(this.workspaceId, artifactRunId).map((item) => item.resultId);
    return Object.freeze({ artifactRunId, resultSetDigest, results: Object.freeze(resultIds.map((resultId) => this.getResult(resultId))) });
  }
}
