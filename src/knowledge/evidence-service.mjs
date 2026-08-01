import { createHash, randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { knowledgeHitContract } from "./contracts.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const EVIDENCE_POLICY_VERSION = "knowledge-evidence-policy-v1";

function exactKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("evidence request must be an object");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError("evidence request contains an unknown field");
}

function snapshotView(row, hits) {
  return Object.freeze({
    evidenceId: row.evidenceId, evidenceDigest: row.evidenceDigest,
    workflowId: row.workflowId, documentId: row.documentId,
    sourceRevisionId: row.sourceRevisionId, targetLanguage: row.targetLanguage,
    segmentId: row.segmentId, query: JSON.parse(row.queryJson), filters: JSON.parse(row.filtersJson),
    retrieverVersion: row.retrieverVersion, queryPolicyVersion: row.queryPolicyVersion,
    indexDigest: row.indexDigest,
    createdAt: row.createdAt, hits: Object.freeze(hits.map((hit) => Object.freeze(hit))),
  });
}

export class EvidenceService {
  constructor(database, trustedWorkspaceId, retriever, {
    now = () => new Date(), id = () => randomUUID(), policyVersion = EVIDENCE_POLICY_VERSION,
  } = {}) {
    const rows = database.prepare("SELECT workspace_id AS workspaceId FROM workspace_meta").all();
    if (rows.length !== 1 || rows[0].workspaceId !== trustedWorkspaceId) throw new Error("workspace identity mismatch");
    if (!retriever || typeof retriever.search !== "function" || typeof retriever.manifest !== "function") throw new TypeError("retriever is required");
    this.database = database;
    this.workspaceId = trustedWorkspaceId;
    this.retriever = retriever;
    this.now = now;
    this.id = id;
    if (typeof policyVersion !== "string" || policyVersion.length === 0 || policyVersion.length > 128) throw new TypeError("evidence policyVersion is invalid");
    this.policyVersion = policyVersion;
  }

  capture(input) {
    exactKeys(input, ["workflowId", "segmentId", "query", "kinds", "tags", "topK"]);
    if (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 20) throw new TypeError("evidence topK is invalid");
    if (typeof input.query !== "string" || [...input.query].length < 1 || [...input.query].length > 512) throw new TypeError("evidence query is invalid");
    const workflow = this.database.prepare(`
      SELECT w.workflow_id AS workflowId, w.document_id AS documentId,
             w.source_revision_id AS sourceRevisionId, w.target_language AS targetLanguage
      FROM translation_workflows w
      JOIN source_segment_versions s ON s.workspace_id = w.workspace_id
        AND s.source_revision_id = w.source_revision_id AND s.segment_id = ?
      WHERE w.workspace_id = ? AND w.workflow_id = ? AND w.state NOT IN ('stale', 'rejected', 'exported')
    `).get(input.segmentId, this.workspaceId, input.workflowId);
    if (!workflow) throw new Error("evidence workflow scope mismatch");
    const request = Object.freeze({
      query: input.query, language: workflow.targetLanguage, kinds: input.kinds,
      tags: input.tags ?? [], documentIds: [workflow.documentId], topK: input.topK,
    });
    const beforeManifest = this.retriever.manifest();
    const rawHits = this.retriever.search(request);
    if (!Array.isArray(rawHits) || rawHits.length > input.topK) throw new Error("retriever returned an invalid hit set");
    const hits = rawHits.map(knowledgeHitContract);
    const totalSnippetBytes = hits.reduce((sum, hit) => sum + Buffer.byteLength(hit.snippet), 0);
    if (totalSnippetBytes > 64 * 1024) throw new RangeError("evidence snippets exceed byte limit");
    const manifest = this.retriever.manifest();
    if (stableJson(beforeManifest) !== stableJson(manifest)) throw new Error("knowledge index changed during evidence capture");
    if (hits.some((hit, index) => hit.rank !== index + 1 || hit.retrieverVersion !== manifest.retrieverVersion)) {
      throw new Error("retriever returned an inconsistent hit set");
    }
    const query = Object.freeze({ text: request.query, language: request.language });
    const filters = Object.freeze({ kinds: request.kinds, tags: request.tags, documentIds: request.documentIds, topK: request.topK });
    const canonical = Object.freeze({
      schemaVersion: "knowledge-evidence-v1",
      workflowId: workflow.workflowId, documentId: workflow.documentId,
      sourceRevisionId: workflow.sourceRevisionId, targetLanguage: workflow.targetLanguage,
      segmentId: input.segmentId, query, filters,
      retrieverVersion: manifest.retrieverVersion, queryPolicyVersion: this.policyVersion,
      indexDigest: manifest.factSetDigest,
      hits: hits.map((hit) => ({ ...hit, snippetDigest: sha(hit.snippet) })),
    });
    const evidenceDigest = sha(stableJson(canonical));
    const existing = this.database.prepare("SELECT evidence_id AS evidenceId FROM knowledge_evidence_snapshots WHERE workspace_id = ? AND evidence_digest = ?")
      .get(this.workspaceId, evidenceDigest);
    if (existing) return this.get(existing.evidenceId);
    const evidenceId = this.id();
    const timestamp = this.now().toISOString();
    try {
      this.database.transaction(() => {
        this.database.prepare(`
          INSERT INTO knowledge_evidence_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          this.workspaceId, evidenceId, workflow.workflowId, workflow.documentId,
          workflow.sourceRevisionId, workflow.targetLanguage, input.segmentId,
          stableJson(query), stableJson(filters), manifest.retrieverVersion, this.policyVersion,
          manifest.factSetDigest, evidenceDigest, timestamp,
        );
        const insert = this.database.prepare("INSERT INTO knowledge_evidence_hits VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        for (const hit of canonical.hits) insert.run(
          this.workspaceId, evidenceId, hit.rank, hit.factId, hit.revisionId, hit.kind, hit.language,
          hit.matchedField, hit.snippet, hit.snippetDigest, hit.contentDigest, hit.score,
        );
      })();
    } catch (error) {
      const raced = this.database.prepare("SELECT evidence_id AS evidenceId FROM knowledge_evidence_snapshots WHERE workspace_id = ? AND evidence_digest = ?")
        .get(this.workspaceId, evidenceDigest);
      if (raced) return this.get(raced.evidenceId);
      throw error;
    }
    return this.get(evidenceId);
  }

  get(evidenceId) {
    const row = this.database.prepare(`
      SELECT evidence_id AS evidenceId, evidence_digest AS evidenceDigest,
             workflow_id AS workflowId, document_id AS documentId,
             source_revision_id AS sourceRevisionId, target_language AS targetLanguage,
             segment_id AS segmentId, query_json AS queryJson, filters_json AS filtersJson,
             retriever_version AS retrieverVersion, query_policy_version AS queryPolicyVersion,
             index_digest AS indexDigest, created_at AS createdAt
      FROM knowledge_evidence_snapshots WHERE workspace_id = ? AND evidence_id = ?
    `).get(this.workspaceId, evidenceId);
    if (!row) throw new Error("evidence snapshot not found");
    const hits = this.database.prepare(`
      SELECT rank, fact_id AS factId, revision_id AS revisionId, kind, language,
             matched_field AS matchedField, snippet, snippet_digest AS snippetDigest,
             content_digest AS contentDigest, score
      FROM knowledge_evidence_hits WHERE workspace_id = ? AND evidence_id = ? ORDER BY rank
    `).all(this.workspaceId, evidenceId);
    if (hits.some((hit) => sha(hit.snippet) !== hit.snippetDigest)) throw new Error("evidence snapshot integrity failed");
    const canonical = {
      schemaVersion: "knowledge-evidence-v1",
      workflowId: row.workflowId, documentId: row.documentId,
      sourceRevisionId: row.sourceRevisionId, targetLanguage: row.targetLanguage,
      segmentId: row.segmentId, query: JSON.parse(row.queryJson), filters: JSON.parse(row.filtersJson),
      retrieverVersion: row.retrieverVersion, queryPolicyVersion: row.queryPolicyVersion,
      indexDigest: row.indexDigest,
      hits: hits.map((hit) => ({ ...hit, retrieverVersion: row.retrieverVersion })),
    };
    if (sha(stableJson(canonical)) !== row.evidenceDigest) throw new Error("evidence snapshot integrity failed");
    return snapshotView(row, hits);
  }

  currentStatus(evidenceId) {
    const snapshot = this.get(evidenceId);
    const workflow = this.database.prepare(`
      SELECT source_revision_id AS sourceRevisionId, target_language AS targetLanguage, state
      FROM translation_workflows WHERE workspace_id = ? AND workflow_id = ?
    `).get(this.workspaceId, snapshot.workflowId);
    if (!workflow || workflow.sourceRevisionId !== snapshot.sourceRevisionId || workflow.targetLanguage !== snapshot.targetLanguage
      || ["stale", "rejected", "exported"].includes(workflow.state)) return Object.freeze({ current: false, reason: "workflow" });
    let manifest;
    try { manifest = this.retriever.manifest(); } catch { return Object.freeze({ current: false, reason: "index" }); }
    if (manifest.retrieverVersion !== snapshot.retrieverVersion || manifest.factSetDigest !== snapshot.indexDigest) return Object.freeze({ current: false, reason: "index" });
    if (snapshot.queryPolicyVersion !== this.policyVersion) return Object.freeze({ current: false, reason: "policy" });
    for (const hit of snapshot.hits) {
      const current = this.database.prepare(`
        SELECT 1 FROM knowledge_fact_heads
        WHERE workspace_id = ? AND fact_id = ? AND revision_id = ? AND state = 'active'
      `).get(this.workspaceId, hit.factId, hit.revisionId);
      if (!current) return Object.freeze({ current: false, reason: "fact" });
    }
    return Object.freeze({ current: true, reason: null });
  }

  assertCurrent(evidenceId) {
    const status = this.currentStatus(evidenceId);
    if (!status.current) throw Object.assign(new Error("evidence snapshot is stale"), { category: "policy", retryable: false });
    return this.get(evidenceId);
  }

  bindAttempt(attemptId, evidenceIds) {
    if (!Array.isArray(evidenceIds) || evidenceIds.length === 0 || evidenceIds.length > 8 || new Set(evidenceIds).size !== evidenceIds.length) {
      throw new TypeError("evidenceIds must be a bounded unique array");
    }
    const attempt = this.database.prepare(`
      SELECT attempt_id AS attemptId, task_id AS taskId, workflow_id AS workflowId,
             source_revision_id AS sourceRevisionId, target_language AS targetLanguage, segment_id AS segmentId
      FROM translation_attempts WHERE workspace_id = ? AND attempt_id = ?
    `).get(this.workspaceId, attemptId);
    if (!attempt) throw new Error("attempt not found");
    this.database.transaction(() => {
      for (const evidenceId of evidenceIds) {
        const evidence = this.assertCurrent(evidenceId);
        if (evidence.workflowId !== attempt.workflowId || evidence.sourceRevisionId !== attempt.sourceRevisionId
          || evidence.targetLanguage !== attempt.targetLanguage || evidence.segmentId !== attempt.segmentId) throw new Error("attempt evidence scope mismatch");
        this.database.prepare("INSERT OR IGNORE INTO attempt_evidence_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(this.workspaceId, attempt.attemptId, attempt.taskId, attempt.workflowId, attempt.sourceRevisionId,
            attempt.targetLanguage, attempt.segmentId, evidence.evidenceId, evidence.evidenceDigest);
      }
    })();
    return this.evidenceIdsForAttempt(attemptId);
  }

  evidenceIdsForAttempt(attemptId) {
    const attempt = this.database.prepare("SELECT 1 FROM translation_attempts WHERE workspace_id = ? AND attempt_id = ?")
      .get(this.workspaceId, attemptId);
    if (!attempt) throw new Error("attempt not found");
    return Object.freeze(this.database.prepare(`
      SELECT binding.evidence_id AS evidenceId FROM attempt_evidence_bindings binding
      JOIN knowledge_evidence_snapshots snapshot ON snapshot.workspace_id = binding.workspace_id
        AND snapshot.evidence_id = binding.evidence_id
      WHERE binding.workspace_id = ? AND binding.attempt_id = ?
      ORDER BY snapshot.evidence_digest, binding.evidence_id
    `).all(this.workspaceId, attemptId).map((row) => row.evidenceId));
  }
}
