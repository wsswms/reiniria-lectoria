import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { stableJson } from "../domain/contracts.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export const RESEARCH_CACHE_CATALOG = Object.freeze([
  { artifactType: "web-search-artifacts", relativeLocation: "table:web_search_artifact_results", purpose: "Retain normalized Search discovery evidence", source: "authorized Search adapters",
    sensitivity: "untrusted-public", backupRelation: "included", rebuildable: false, cleanupRecommendation: "retain with the ResearchReport; remove only through a future audited retention migration" },
  { artifactType: "provider-content-snapshots", relativeLocation: "table:provider_content_snapshots", purpose: "Retain bounded third-party processed content for citation verification", source: "authorized Extract adapters",
    sensitivity: "untrusted-public", backupRelation: "included", rebuildable: false, cleanupRecommendation: "retain with dependent citations; review when the workspace is archived" },
  { artifactType: "restricted-fetch-snapshots", relativeLocation: "table:internet_fetch_snapshots", purpose: "Retain bounded direct Web evidence", source: "Restricted Fetch proxy",
    sensitivity: "untrusted-public", backupRelation: "included", rebuildable: false, cleanupRecommendation: "retain with proposals and citations; review when the workspace is archived" },
  { artifactType: "research-reports", relativeLocation: "table:research_reports", purpose: "Retain immutable synthesized research outcomes", source: "Research control plane",
    sensitivity: "private-derived", backupRelation: "included", rebuildable: false, cleanupRecommendation: "retain as an audit fact while dependent proposals exist" },
  { artifactType: "proposal-research-bindings", relativeLocation: "table:knowledge_proposal_research_evidence", purpose: "Retain Claim and Citation bindings for each proposal revision", source: "ResearchProposalBridge",
    sensitivity: "private-derived", backupRelation: "included", rebuildable: false, cleanupRecommendation: "retain with proposal decision and application history" },
  { artifactType: "knowledge-fts-index", relativeLocation: "derived/knowledge-index.sqlite3", purpose: "Accelerate local deterministic knowledge retrieval", source: "active knowledge fact revisions",
    sensitivity: "private-derived", backupRelation: "excluded", rebuildable: true, cleanupRecommendation: "delete whenever stale or before backup; rebuild from active facts" },
].map((item) => Object.freeze(item)));

const TABLE_SIZE = Object.freeze({
  "web-search-artifacts": "SELECT count(*) AS count, coalesce(sum(length(CAST(url AS BLOB)) + length(CAST(title AS BLOB)) + length(CAST(description AS BLOB)) + length(CAST(result_digest AS BLOB))), 0) AS bytes FROM web_search_artifact_results WHERE workspace_id = ?",
  "provider-content-snapshots": "SELECT count(*) AS count, coalesce(sum(length(CAST(content_text AS BLOB)) + length(CAST(content_digest AS BLOB)) + length(CAST(snapshot_digest AS BLOB))), 0) AS bytes FROM provider_content_snapshots WHERE workspace_id = ?",
  "restricted-fetch-snapshots": "SELECT count(*) AS count, coalesce(sum(length(CAST(extracted_text AS BLOB)) + length(CAST(content_digest AS BLOB)) + length(CAST(snapshot_digest AS BLOB))), 0) AS bytes FROM internet_fetch_snapshots WHERE workspace_id = ?",
  "research-reports": "SELECT count(*) AS count, coalesce(sum(length(CAST(report_json AS BLOB)) + length(CAST(report_digest AS BLOB))), 0) AS bytes FROM research_reports WHERE workspace_id = ?",
  "proposal-research-bindings": "SELECT count(*) AS count, coalesce(sum(length(CAST(proposal_revision_id AS BLOB)) + length(CAST(report_id AS BLOB)) + length(CAST(claim_id AS BLOB)) + length(CAST(citation_id AS BLOB))), 0) AS bytes FROM knowledge_proposal_research_evidence WHERE workspace_id = ?",
});

export class ResearchCacheInventoryService {
  constructor(root, database, workspaceId, { now = () => new Date(), id = randomUUID } = {}) {
    this.root = root; this.database = database; this.workspaceId = workspaceId; this.now = now; this.id = id;
  }

  async recordCurrent() {
    const entries = [];
    for (const catalog of RESEARCH_CACHE_CATALOG) {
      let count = 0; let byteLength = 0;
      if (TABLE_SIZE[catalog.artifactType]) {
        const row = this.database.prepare(TABLE_SIZE[catalog.artifactType]).get(this.workspaceId); count = row.count; byteLength = row.bytes;
      } else {
        const info = await lstat(join(this.root, catalog.relativeLocation)).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
        if (info) { if (!info.isFile() || info.isSymbolicLink()) throw new Error("cache inventory path is unsafe"); count = 1; byteLength = info.size; }
      }
      const artifactId = sha(stableJson({ artifactType: catalog.artifactType, count, byteLength }));
      const existing = this.database.prepare(`SELECT inventory_id AS inventoryId FROM research_cache_inventory_entries
        WHERE workspace_id = ? AND artifact_type = ? AND artifact_id = ?`).get(this.workspaceId, catalog.artifactType, artifactId);
      if (!existing) this.database.prepare("INSERT INTO research_cache_inventory_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, this.id(), catalog.artifactType, artifactId, catalog.relativeLocation, byteLength, catalog.sensitivity,
          catalog.backupRelation, catalog.rebuildable ? 1 : 0, catalog.cleanupRecommendation, this.now().toISOString());
      entries.push(Object.freeze({ ...catalog, artifactId, itemCount: count, byteLength }));
    }
    return Object.freeze({ schemaVersion: "research-cache-inventory-v1", workspaceId: this.workspaceId,
      coverage: entries.length / RESEARCH_CACHE_CATALOG.length, entries: Object.freeze(entries), recordedAt: this.now().toISOString() });
  }

  listRecorded() {
    return Object.freeze(this.database.prepare(`SELECT inventory_id AS inventoryId, artifact_type AS artifactType,
      artifact_id AS artifactId, relative_location AS relativeLocation, byte_length AS byteLength, sensitivity,
      backup_relation AS backupRelation, rebuildable, cleanup_recommendation AS cleanupRecommendation, recorded_at AS recordedAt
      FROM research_cache_inventory_entries WHERE workspace_id = ? ORDER BY artifact_type, recorded_at`).all(this.workspaceId)
      .map((row) => Object.freeze({ ...row, rebuildable: row.rebuildable === 1 })));
  }
}
