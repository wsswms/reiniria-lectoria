import { createHash, createHmac, randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { searchResponseContract } from "./contracts.mjs";
import { BRAVE_SEARCH_ADAPTER_VERSION } from "./brave-search-adapter.mjs";
import { FETCH_POLICY_VERSION } from "./fetch-proxy.mjs";

export const SEARCH_POLICY_VERSION = "internet-search-policy-v1";
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function exact(input, keys, name) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw new TypeError(`${name} contains an unknown field`);
}

function user(actor) {
  if (!actor || actor.type !== "user" || typeof actor.id !== "string" || actor.id.length === 0) throw new InvestigationConflictError("only a user can create an investigation");
  return actor;
}

export class InvestigationConflictError extends Error {
  constructor(message = "internet investigation conflict") {
    super(message);
    this.name = "InvestigationConflictError";
    this.code = "INVESTIGATION_CONFLICT";
  }
}

export class InvestigationService {
  constructor(database, trustedWorkspaceId, {
    now = () => new Date(), id = () => randomUUID(), searchInvoker, fetchProxy,
    handleKey, searchPolicyVersion = SEARCH_POLICY_VERSION, fetchPolicyVersion = FETCH_POLICY_VERSION,
    investigationTtlMs = 24 * 60 * 60 * 1000, handleTtlMs = 15 * 60 * 1000,
  } = {}) {
    if (typeof searchInvoker !== "function" || !fetchProxy || typeof fetchProxy.fetchSelected !== "function") throw new TypeError("investigation network services are required");
    if (!(handleKey instanceof Uint8Array) || handleKey.byteLength < 32) throw new TypeError("investigation handle key is invalid");
    this.database = database;
    this.workspaceId = trustedWorkspaceId;
    this.now = now;
    this.id = id;
    this.searchInvoker = searchInvoker;
    this.fetchProxy = fetchProxy;
    this.handleKey = Buffer.from(handleKey);
    this.searchPolicyVersion = searchPolicyVersion;
    this.fetchPolicyVersion = fetchPolicyVersion;
    this.investigationTtlMs = investigationTtlMs;
    this.handleTtlMs = handleTtlMs;
  }

  create(input, actorInput) {
    exact(input, ["taskId", "workflowId", "segmentId", "query", "maxResults", "country", "searchLanguage"], "investigation request");
    const by = user(actorInput);
    if (typeof input.query !== "string" || input.query.trim().length === 0 || [...input.query].length > 512) throw new TypeError("investigation query is invalid");
    if (!Number.isInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > 20) throw new TypeError("investigation maxResults is invalid");
    const scope = this.database.prepare(`
      SELECT task.task_id AS taskId, task.workflow_id AS workflowId, task.document_id AS documentId,
             task.source_revision_id AS sourceRevisionId, task.target_language AS targetLanguage
      FROM translation_tasks AS task JOIN source_segment_versions AS segment
        ON segment.workspace_id = task.workspace_id AND segment.source_revision_id = task.source_revision_id AND segment.segment_id = ?
      WHERE task.workspace_id = ? AND task.task_id = ? AND task.workflow_id = ?
    `).get(input.segmentId, this.workspaceId, input.taskId, input.workflowId);
    if (!scope) throw new InvestigationConflictError("investigation scope is unavailable");
    const created = this.now();
    const investigationId = this.id();
    const query = { text: input.query, country: input.country, searchLanguage: input.searchLanguage };
    try {
      this.database.transaction(() => {
        this.database.prepare("INSERT INTO internet_investigations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?, ?)")
          .run(this.workspaceId, investigationId, scope.taskId, scope.workflowId, scope.documentId, scope.sourceRevisionId,
            scope.targetLanguage, input.segmentId, input.query, input.country, input.searchLanguage, sha(stableJson(query)), input.maxResults,
            this.searchPolicyVersion, this.fetchPolicyVersion, by.id, created.toISOString(), new Date(created.getTime() + this.investigationTtlMs).toISOString());
        this.#event(investigationId, "created", null, { queryDigest: sha(stableJson(query)) });
      })();
    } catch (error) {
      if (error?.code?.startsWith("SQLITE_CONSTRAINT")) throw new InvestigationConflictError("investigation scope conflict");
      throw error;
    }
    return this.get(investigationId);
  }

  get(investigationId) {
    const row = this.database.prepare(`SELECT investigation_id AS investigationId, task_id AS taskId,
      workflow_id AS workflowId, document_id AS documentId, source_revision_id AS sourceRevisionId,
      target_language AS targetLanguage, segment_id AS segmentId, query_text AS query,
      country, search_language AS searchLanguage,
      query_digest AS queryDigest, max_results AS maxResults, search_policy_version AS searchPolicyVersion,
      fetch_policy_version AS fetchPolicyVersion, actor_id AS actorId, created_at AS createdAt, expires_at AS expiresAt
      FROM internet_investigations WHERE workspace_id = ? AND investigation_id = ?`).get(this.workspaceId, investigationId);
    if (!row) throw new InvestigationConflictError("investigation not found");
    const events = this.database.prepare(`SELECT event_id AS eventId, action, category, details_json AS detailsJson,
      occurred_at AS occurredAt FROM internet_investigation_events WHERE workspace_id = ? AND investigation_id = ?
      ORDER BY occurred_at, event_id`).all(this.workspaceId, investigationId)
      .map((event) => Object.freeze({ ...event, details: JSON.parse(event.detailsJson) }));
    return Object.freeze({ ...row, events: Object.freeze(events) });
  }

  async search(investigationId) {
    const investigation = this.#current(investigationId);
    const request = { query: investigation.query, count: investigation.maxResults,
      country: investigation.country, searchLanguage: investigation.searchLanguage };
    let response;
    try { response = searchResponseContract(await this.searchInvoker(request), request); }
    catch (error) { this.#event(investigationId, "search-failed", error?.category ?? "unavailable", {}); throw error; }
    const results = response.results.map((item) => ({ ...item, urlDigest: sha(item.url), resultDigest: sha(stableJson(item)) }));
    const resultSetDigest = sha(stableJson(results));
    const identity = { investigationId, queryDigest: investigation.queryDigest, adapterId: response.adapterId,
      adapterVersion: response.adapterVersion, policyVersion: this.searchPolicyVersion, resultSetDigest };
    const searchRunId = sha(stableJson(identity));
    const created = this.now();
    const handleExpiresAt = new Date(Math.min(new Date(investigation.expiresAt).getTime(), created.getTime() + this.handleTtlMs)).toISOString();
    this.database.transaction(() => {
      this.database.prepare("INSERT OR IGNORE INTO internet_search_runs VALUES (?, ?, ?, ?, ?, ?, 'brave-search', ?, ?, ?, ?, ?)")
        .run(this.workspaceId, searchRunId, investigationId, investigation.taskId, investigation.workflowId,
          investigation.segmentId, response.adapterVersion, this.searchPolicyVersion, investigation.queryDigest,
          resultSetDigest, created.toISOString());
      for (const item of results) {
        const resultId = sha(stableJson({ searchRunId, rank: item.rank, resultDigest: item.resultDigest }));
        this.database.prepare("INSERT OR IGNORE INTO internet_search_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(this.workspaceId, searchRunId, investigationId, resultId, item.rank, item.url, item.urlDigest,
            item.title, item.description, item.resultDigest, handleExpiresAt);
      }
      this.#event(investigationId, "search-succeeded", null, { searchRunId, resultSetDigest });
    })();
    return this.getSearchRun(searchRunId);
  }

  getSearchRun(searchRunId) {
    const row = this.database.prepare(`SELECT search_run_id AS searchRunId, investigation_id AS investigationId,
      adapter_id AS adapterId, adapter_version AS adapterVersion, policy_version AS policyVersion,
      query_digest AS queryDigest, result_set_digest AS resultSetDigest, created_at AS createdAt
      FROM internet_search_runs WHERE workspace_id = ? AND search_run_id = ?`).get(this.workspaceId, searchRunId);
    if (!row) throw new InvestigationConflictError("search run not found");
    const results = this.database.prepare(`SELECT result_id AS resultId, rank, url, url_digest AS urlDigest,
      title, description, result_digest AS resultDigest, handle_expires_at AS handleExpiresAt
      FROM internet_search_results WHERE workspace_id = ? AND search_run_id = ? ORDER BY rank`)
      .all(this.workspaceId, searchRunId).map((item) => Object.freeze({ ...item, handle: this.#handle(row.investigationId, item), untrusted: true }));
    return Object.freeze({ ...row, results: Object.freeze(results) });
  }

  async fetch(investigationId, resultId, handle, actorInput) {
    user(actorInput);
    const investigation = this.#current(investigationId);
    const result = this.database.prepare(`SELECT result.search_run_id AS searchRunId, result.result_id AS resultId,
      result.url, result.url_digest AS urlDigest, result.result_digest AS resultDigest,
      result.handle_expires_at AS handleExpiresAt FROM internet_search_results AS result
      WHERE result.workspace_id = ? AND result.investigation_id = ? AND result.result_id = ?`)
      .get(this.workspaceId, investigationId, resultId);
    if (!result || typeof handle !== "string" || handle !== this.#handle(investigationId, result)
      || this.now().getTime() >= new Date(result.handleExpiresAt).getTime()) throw new InvestigationConflictError("search result handle is invalid or expired");
    let fetched;
    try { fetched = await this.fetchProxy.fetchSelected({ url: result.url }); }
    catch (error) { this.#event(investigationId, "fetch-failed", error?.category ?? "unavailable", { resultId }); throw error; }
    if (fetched.policyVersion !== this.fetchPolicyVersion || fetched.requestedUrl !== result.url) throw new InvestigationConflictError("fetch proxy scope mismatch");
    const fetchSnapshotId = sha(stableJson({ investigationId, resultId, snapshotDigest: fetched.snapshotDigest }));
    this.database.transaction(() => {
      this.database.prepare("INSERT OR IGNORE INTO internet_fetch_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)")
        .run(this.workspaceId, fetchSnapshotId, investigationId, result.searchRunId, resultId, fetched.requestedUrl,
          fetched.finalUrl, fetched.fetchedAt, fetched.policyVersion, fetched.statusCode, fetched.mimeType, fetched.title,
          fetched.extractedText, fetched.contentDigest, fetched.snapshotDigest, fetched.truncated ? 1 : 0,
          stableJson(fetched.diagnostics), stableJson(fetched.redirects));
      this.#event(investigationId, "fetch-succeeded", null, { resultId, fetchSnapshotId });
    })();
    return this.getFetch(fetchSnapshotId);
  }

  getFetch(fetchSnapshotId) {
    const row = this.database.prepare(`SELECT fetch_snapshot_id AS fetchSnapshotId, investigation_id AS investigationId,
      search_run_id AS searchRunId, result_id AS resultId, requested_url AS requestedUrl, final_url AS finalUrl,
      fetched_at AS fetchedAt, fetch_policy_version AS fetchPolicyVersion, status_code AS statusCode,
      mime_type AS mimeType, title, extracted_text AS extractedText, content_digest AS contentDigest,
      snapshot_digest AS snapshotDigest, truncated, diagnostics_json AS diagnosticsJson,
      redirects_json AS redirectsJson, untrusted
      FROM internet_fetch_snapshots WHERE workspace_id = ? AND fetch_snapshot_id = ?`).get(this.workspaceId, fetchSnapshotId);
    if (!row || sha(row.extractedText) !== row.contentDigest) throw new InvestigationConflictError("fetch snapshot not found or corrupted");
    const diagnostics = JSON.parse(row.diagnosticsJson);
    const redirects = JSON.parse(row.redirectsJson);
    const canonical = { requestedUrl: row.requestedUrl, finalUrl: row.finalUrl, statusCode: row.statusCode,
      mimeType: row.mimeType, title: row.title, extractedText: row.extractedText, truncated: row.truncated === 1,
      diagnostics, redirects, policyVersion: row.fetchPolicyVersion };
    if (sha(stableJson(canonical)) !== row.snapshotDigest) throw new InvestigationConflictError("fetch snapshot not found or corrupted");
    return Object.freeze({ ...row, truncated: row.truncated === 1, diagnostics: Object.freeze(diagnostics),
      redirects: Object.freeze(redirects), untrusted: row.untrusted === 1 });
  }

  #current(investigationId) {
    const investigation = this.get(investigationId);
    if (investigation.searchPolicyVersion !== this.searchPolicyVersion || investigation.fetchPolicyVersion !== this.fetchPolicyVersion
      || this.now().getTime() >= new Date(investigation.expiresAt).getTime()) throw new InvestigationConflictError("investigation is stale or expired");
    const workflow = this.database.prepare("SELECT source_revision_id AS sourceRevisionId, target_language AS targetLanguage, state FROM translation_workflows WHERE workspace_id = ? AND workflow_id = ?")
      .get(this.workspaceId, investigation.workflowId);
    if (!workflow || workflow.sourceRevisionId !== investigation.sourceRevisionId || workflow.targetLanguage !== investigation.targetLanguage
      || ["stale", "rejected", "exported"].includes(workflow.state)) throw new InvestigationConflictError("investigation is stale or expired");
    return investigation;
  }

  #handle(investigationId, result) {
    return createHmac("sha256", this.handleKey).update(stableJson({ workspaceId: this.workspaceId, investigationId,
      resultId: result.resultId, resultDigest: result.resultDigest, expiresAt: result.handleExpiresAt,
      policyVersion: this.fetchPolicyVersion })).digest("base64url");
  }

  #event(investigationId, action, category, details) {
    const canonical = { investigationId, action, category, details };
    this.database.prepare("INSERT OR IGNORE INTO internet_investigation_events VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(this.workspaceId, sha(stableJson(canonical)), investigationId, action, category, stableJson(details), this.now().toISOString());
  }
}
