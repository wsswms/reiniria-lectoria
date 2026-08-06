import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { ResearchConflictError } from "./foundation-service.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
function uuid(value) {
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

const KEYS = Object.freeze(["requestedUrl", "finalUrl", "statusCode", "mimeType", "title", "extractedText", "truncated",
  "diagnostics", "redirects", "policyVersion", "fetchedAt", "contentDigest", "snapshotDigest", "untrusted"]);

function https(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`${name} is invalid`); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || url.href.length > 4096) throw new TypeError(`${name} is invalid`);
  url.hash = "";
  return url.href;
}

function normalized(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !KEYS.includes(key))
    || KEYS.some((key) => !(key in input))) throw new TypeError("direct fetch snapshot is invalid");
  const requestedUrl = https(input.requestedUrl, "requestedUrl");
  const finalUrl = https(input.finalUrl, "finalUrl");
  if (!Number.isInteger(input.statusCode) || input.statusCode < 200 || input.statusCode > 299
    || !new Set(["text/html", "text/plain"]).has(input.mimeType)
    || typeof input.title !== "string" || input.title.length > 2048
    || typeof input.extractedText !== "string" || input.extractedText.length < 1 || input.extractedText.length > 262_144
    || typeof input.truncated !== "boolean" || !Array.isArray(input.diagnostics) || !Array.isArray(input.redirects)
    || typeof input.policyVersion !== "string" || input.policyVersion.length < 1 || input.policyVersion.length > 128
    || typeof input.fetchedAt !== "string" || Number.isNaN(Date.parse(input.fetchedAt)) || input.untrusted !== true) {
    throw new TypeError("direct fetch snapshot is invalid");
  }
  const canonical = { requestedUrl, finalUrl, statusCode: input.statusCode, mimeType: input.mimeType, title: input.title,
    extractedText: input.extractedText, truncated: input.truncated, diagnostics: input.diagnostics, redirects: input.redirects,
    policyVersion: input.policyVersion };
  if (input.contentDigest !== sha(input.extractedText) || input.snapshotDigest !== sha(stableJson(canonical))) {
    throw new ResearchConflictError("direct fetch snapshot digest mismatch");
  }
  return Object.freeze({ ...canonical, fetchedAt: new Date(input.fetchedAt).toISOString(), contentDigest: input.contentDigest,
    snapshotDigest: input.snapshotDigest, untrusted: true });
}

export class DirectResearchFetchSnapshotService {
  constructor(database, workspaceId) { this.database = database; this.workspaceId = workspaceId; }

  persist(runId, queryId, input) {
    const value = normalized(input);
    const snapshotId = uuid(stableJson({ workspaceId: this.workspaceId, runId, queryId, snapshotDigest: value.snapshotDigest }));
    try {
      this.database.prepare(`INSERT OR IGNORE INTO research_direct_fetch_snapshots VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
        .run(this.workspaceId, snapshotId, runId, queryId, value.requestedUrl, value.finalUrl, value.fetchedAt, value.policyVersion,
          value.statusCode, value.mimeType, value.title, value.extractedText, value.contentDigest, value.snapshotDigest,
          value.truncated ? 1 : 0, stableJson(value.diagnostics), stableJson(value.redirects));
    } catch { throw new ResearchConflictError("direct fetch snapshot scope is invalid"); }
    return this.get(snapshotId);
  }

  get(snapshotId) {
    const row = this.database.prepare(`SELECT snapshot_id AS snapshotId, run_id AS runId, query_id AS queryId,
      requested_url AS requestedUrl, final_url AS finalUrl, fetched_at AS fetchedAt, fetch_policy_version AS policyVersion,
      status_code AS statusCode, mime_type AS mimeType, title, extracted_text AS extractedText,
      content_digest AS contentDigest, snapshot_digest AS snapshotDigest, truncated, diagnostics_json AS diagnosticsJson,
      redirects_json AS redirectsJson, untrusted FROM research_direct_fetch_snapshots WHERE workspace_id = ? AND snapshot_id = ?`)
      .get(this.workspaceId, snapshotId);
    if (!row || sha(row.extractedText) !== row.contentDigest) throw new ResearchConflictError("direct fetch snapshot not found or corrupted");
    const canonical = { requestedUrl: row.requestedUrl, finalUrl: row.finalUrl, statusCode: row.statusCode,
      mimeType: row.mimeType, title: row.title, extractedText: row.extractedText, truncated: row.truncated === 1,
      diagnostics: JSON.parse(row.diagnosticsJson), redirects: JSON.parse(row.redirectsJson), policyVersion: row.policyVersion };
    if (sha(stableJson(canonical)) !== row.snapshotDigest) throw new ResearchConflictError("direct fetch snapshot not found or corrupted");
    return Object.freeze({ snapshotId: row.snapshotId, runId: row.runId, queryId: row.queryId, requestedUrl: row.requestedUrl,
      finalUrl: row.finalUrl, fetchedAt: row.fetchedAt, policyVersion: row.policyVersion, statusCode: row.statusCode,
      mimeType: row.mimeType, title: row.title, extractedText: row.extractedText, contentDigest: row.contentDigest,
      snapshotDigest: row.snapshotDigest, truncated: row.truncated === 1, diagnostics: Object.freeze(canonical.diagnostics),
      redirects: Object.freeze(canonical.redirects), untrusted: row.untrusted === 1, lineage: "direct" });
  }
}
