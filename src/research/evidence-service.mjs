import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { ResearchConflictError } from "./foundation-service.mjs";
import { researchCitationContract, researchClaimContract, researchReportContract, researchSourceContract } from "./contracts.mjs";

const hex = (value) => createHash("sha256").update(value).digest("hex");
const sha = (value) => `sha256:${hex(value)}`;
function uuid(value) {
  const hash = hex(value);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function exact(input, keys, name) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key))) throw new TypeError(`${name} is invalid`);
}

export class ResearchEvidenceService {
  constructor(database, workspaceId, { now = () => new Date() } = {}) { this.database = database; this.workspaceId = workspaceId; this.now = now; }

  addSource(runId, queryId, input) {
    exact(input, ["canonicalUrl", "tier", "lineage", "artifactType", "artifactId"], "source input");
    if ((input.artifactType === "provider-content-snapshot" && input.lineage !== "provider-processed")
      || (input.artifactType === "fetch-snapshot" && input.lineage !== "direct")
      || (input.artifactType === "search-result" && input.lineage !== "search-snippet")) throw new ResearchConflictError("source lineage does not match its artifact class");
    const artifact = this.#artifact(runId, queryId, input.artifactType, input.artifactId);
    if (new URL(input.canonicalUrl).toString() !== artifact.url) throw new ResearchConflictError("source URL does not match its artifact");
    const sourceClusterId = uuid(stableJson({ exactContentDigest: artifact.contentDigest }));
    const sourceId = uuid(stableJson({ runId, queryId, artifactType: input.artifactType, artifactId: input.artifactId, sourceClusterId }));
    const source = researchSourceContract({ schemaVersion: "1.0", sourceId, runId, queryId, canonicalUrl: artifact.url,
      urlDigest: sha(artifact.url), sourceClusterId, tier: input.tier, lineage: input.lineage,
      artifactType: input.artifactType, artifactId: input.artifactId, artifactDigest: artifact.artifactDigest, retrievedAt: this.now().toISOString() });
    try {
      this.database.prepare("INSERT OR IGNORE INTO research_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, source.sourceId, runId, queryId, source.canonicalUrl, source.urlDigest, source.sourceClusterId,
          source.tier, source.lineage, source.artifactType, source.artifactId, source.artifactDigest, source.retrievedAt);
    } catch { throw new ResearchConflictError("source lineage or scope is invalid"); }
    return this.getSource(sourceId);
  }

  cite(sourceId, input) {
    exact(input, ["quote", "locator"], "citation input");
    const source = this.getSource(sourceId);
    const artifact = this.#artifact(source.runId, source.queryId, source.artifactType, source.artifactId);
    exact(input.locator, ["start", "end"], "citation locator");
    if (!Number.isInteger(input.locator.start) || !Number.isInteger(input.locator.end) || input.locator.start < 0 || input.locator.end <= input.locator.start || input.locator.end > artifact.content.length) throw new ResearchConflictError("citation locator is outside the artifact");
    if (artifact.content.slice(input.locator.start, input.locator.end) !== input.quote) throw new ResearchConflictError("citation quote does not match the artifact");
    const citationId = uuid(stableJson({ sourceId, quote: input.quote, locator: input.locator }));
    const citation = researchCitationContract({ schemaVersion: "1.0", citationId, sourceId, quote: input.quote,
      quoteDigest: sha(input.quote), locator: input.locator, verified: true });
    this.database.prepare("INSERT OR IGNORE INTO research_citations VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)")
      .run(this.workspaceId, citationId, source.runId, sourceId, citation.quote, citation.quoteDigest, stableJson(citation.locator), this.now().toISOString());
    return this.getCitation(citationId);
  }

  claim(runId, input) {
    exact(input, ["text", "citationIds", "inference", "disputed", "insufficient", "narrowOfficial"], "claim input");
    if (!Array.isArray(input.citationIds)) throw new TypeError("citationIds must be an array");
    const citations = input.citationIds.map((citationId) => this.getCitation(citationId));
    if (citations.some((item) => item.runId !== runId)) throw new ResearchConflictError("claim citation scope mismatch");
    const sources = citations.map((item) => this.getSource(item.sourceId));
    const clusters = new Set(sources.map((item) => item.sourceClusterId));
    const hasStrong = sources.some((item) => ["S1", "S2"].includes(item.tier));
    let supportLevel = "C0";
    if (input.disputed) supportLevel = "CD";
    else if (input.insufficient || citations.length === 0) supportLevel = "C0";
    else if (input.inference) supportLevel = "C1";
    else if (input.narrowOfficial && sources.length === 1 && sources[0].tier === "S1") supportLevel = "C2";
    else if (clusters.size >= 2 && hasStrong) supportLevel = sources.every((item) => ["S1", "S2"].includes(item.tier)) ? "C3" : "C2";
    else supportLevel = "C1";
    const claimId = uuid(stableJson({ runId, text: input.text, citationIds: [...input.citationIds].sort(), inference: input.inference, supportLevel }));
    const claim = researchClaimContract({ schemaVersion: "1.0", claimId, runId, text: input.text, claimDigest: sha(input.text),
      supportLevel, citationIds: input.citationIds, inference: input.inference });
    this.database.transaction(() => {
      this.database.prepare("INSERT OR IGNORE INTO research_claims VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, claimId, runId, claim.text, claim.claimDigest, claim.supportLevel, claim.inference ? 1 : 0, this.now().toISOString());
      const insert = this.database.prepare("INSERT OR IGNORE INTO research_claim_citations VALUES (?, ?, ?, ?)");
      for (const citationId of claim.citationIds) insert.run(this.workspaceId, runId, claimId, citationId);
    })();
    return this.getClaim(claimId);
  }

  report(runId, input) {
    exact(input, ["questionAnswers", "claimIds", "usage"], "report input");
    const claims = input.claimIds.map((claimId) => this.getClaim(claimId));
    if (claims.some((item) => item.runId !== runId)) throw new ResearchConflictError("report claim scope mismatch");
    const levels = new Set(claims.map((item) => item.supportLevel));
    const outcome = levels.has("CD") || levels.has("CI") ? "disputed"
      : claims.length === 0 || [...levels].every((item) => ["C0", "C1"].includes(item)) ? "insufficient"
        : [...levels].some((item) => ["C0", "C1"].includes(item)) ? "partial" : "supported";
    const stopReason = outcome === "disputed" ? "material-source-conflict" : outcome === "insufficient" ? "insufficient-verifiable-evidence"
      : outcome === "partial" ? "partial-questions-answered" : "questions-answered";
    const identity = { runId, outcome, stopReason, questionAnswers: input.questionAnswers, claimIds: [...input.claimIds].sort(), usage: input.usage };
    const reportId = uuid(stableJson(identity));
    const report = researchReportContract({ schemaVersion: "1.0", reportId, ...identity, reportDigest: sha(stableJson(identity)), createdAt: this.now().toISOString() });
    const existing = this.database.prepare("SELECT report_digest AS reportDigest FROM research_reports WHERE workspace_id = ? AND run_id = ?").get(this.workspaceId, runId);
    if (existing && existing.reportDigest !== report.reportDigest) throw new ResearchConflictError("run already has a different report");
    this.database.transaction(() => {
      this.database.prepare("INSERT OR IGNORE INTO research_reports VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, reportId, runId, report.outcome, report.stopReason, stableJson(report), report.reportDigest, report.createdAt);
      const insert = this.database.prepare("INSERT OR IGNORE INTO research_report_claims VALUES (?, ?, ?, ?, ?)");
      report.claimIds.forEach((claimId, ordinal) => insert.run(this.workspaceId, runId, reportId, claimId, ordinal));
    })();
    return this.getReport(reportId);
  }

  getSource(sourceId) {
    const row = this.database.prepare(`SELECT source_id AS sourceId, run_id AS runId, query_id AS queryId, canonical_url AS canonicalUrl,
      url_digest AS urlDigest, source_cluster_id AS sourceClusterId, tier, lineage, artifact_type AS artifactType,
      artifact_id AS artifactId, artifact_digest AS artifactDigest, retrieved_at AS retrievedAt FROM research_sources
      WHERE workspace_id = ? AND source_id = ?`).get(this.workspaceId, sourceId);
    if (!row) throw new ResearchConflictError("research source not found");
    return Object.freeze(row);
  }

  getCitation(citationId) {
    const row = this.database.prepare(`SELECT citation_id AS citationId, run_id AS runId, source_id AS sourceId, quote_text AS quote,
      quote_digest AS quoteDigest, locator_json AS locatorJson, verified, created_at AS createdAt FROM research_citations
      WHERE workspace_id = ? AND citation_id = ?`).get(this.workspaceId, citationId);
    if (!row) throw new ResearchConflictError("research citation not found");
    return Object.freeze({ ...row, locator: Object.freeze(JSON.parse(row.locatorJson)), verified: row.verified === 1 });
  }

  getClaim(claimId) {
    const row = this.database.prepare(`SELECT claim_id AS claimId, run_id AS runId, claim_text AS text, claim_digest AS claimDigest,
      support_level AS supportLevel, inference, created_at AS createdAt FROM research_claims WHERE workspace_id = ? AND claim_id = ?`)
      .get(this.workspaceId, claimId);
    if (!row) throw new ResearchConflictError("research claim not found");
    const citationIds = this.database.prepare("SELECT citation_id AS citationId FROM research_claim_citations WHERE workspace_id = ? AND claim_id = ? ORDER BY citation_id")
      .all(this.workspaceId, claimId).map((item) => item.citationId);
    return Object.freeze({ ...row, inference: row.inference === 1, citationIds: Object.freeze(citationIds) });
  }

  getReport(reportId) {
    const row = this.database.prepare("SELECT report_json AS reportJson FROM research_reports WHERE workspace_id = ? AND report_id = ?")
      .get(this.workspaceId, reportId);
    if (!row) throw new ResearchConflictError("research report not found");
    return researchReportContract(JSON.parse(row.reportJson));
  }

  #artifact(runId, queryId, type, id) {
    if (type === "provider-content-snapshot") {
      const row = this.database.prepare(`SELECT canonical_url AS url, content_text AS content, content_digest AS contentDigest,
        snapshot_digest AS artifactDigest, lineage FROM provider_content_snapshots WHERE workspace_id = ? AND run_id = ? AND query_id = ? AND snapshot_id = ?`)
        .get(this.workspaceId, runId, queryId, id);
      if (!row || row.lineage !== "provider-processed" || sha(row.content) !== row.contentDigest) throw new ResearchConflictError("provider artifact is unavailable or corrupted");
      return row;
    }
    if (type === "fetch-snapshot") {
      const row = this.database.prepare(`SELECT final_url AS url, extracted_text AS content, content_digest AS contentDigest,
        snapshot_digest AS artifactDigest FROM internet_fetch_snapshots snapshot
        JOIN internet_investigations investigation ON investigation.workspace_id = snapshot.workspace_id AND investigation.investigation_id = snapshot.investigation_id
        JOIN research_runs run ON run.workspace_id = snapshot.workspace_id AND run.run_id = ?
        JOIN research_grants grant_record ON grant_record.workspace_id = run.workspace_id AND grant_record.grant_id = run.grant_id
        JOIN research_requests request ON request.workspace_id = grant_record.workspace_id AND request.request_id = grant_record.request_id
        WHERE snapshot.workspace_id = ? AND snapshot.fetch_snapshot_id = ? AND investigation.workflow_id = request.workflow_id
          AND investigation.source_revision_id = request.source_revision_id AND investigation.target_language = request.target_language
          AND EXISTS (SELECT 1 FROM research_request_segments segment WHERE segment.workspace_id = request.workspace_id
            AND segment.request_id = request.request_id AND segment.segment_id = investigation.segment_id)`)
        .get(runId, this.workspaceId, id);
      if (!row || sha(row.content) !== row.contentDigest) throw new ResearchConflictError("fetch artifact is unavailable or corrupted");
      return row;
    }
    if (type === "search-result") {
      const row = this.database.prepare(`SELECT url, title || char(10) || description AS content, result_digest AS artifactDigest
        FROM web_search_artifact_results WHERE workspace_id = ? AND result_id = ?`).get(this.workspaceId, id);
      if (!row) throw new ResearchConflictError("search artifact is unavailable");
      return { ...row, contentDigest: sha(row.content) };
    }
    throw new ResearchConflictError("artifact type is unsupported");
  }
}
