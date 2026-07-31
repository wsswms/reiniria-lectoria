import { randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { ObjectStore } from "../storage/object-store.mjs";
import { alignRevisionSegments } from "./alignment.mjs";
import { normalizeDocument } from "./parser.mjs";

export class ReimportConflictError extends Error {
  constructor(message = "reimport conflict") {
    super(message);
    this.name = "ReimportConflictError";
    this.code = "REIMPORT_CONFLICT";
  }
}

function userActor(input) {
  if (!input || input.type !== "user" || typeof input.id !== "string" || input.id.length === 0) throw new TypeError("a user actor is required");
  return input;
}

export class ReimportService {
  constructor({ database, root, trustedWorkspaceId, now = () => new Date(), id = () => randomUUID(), inject = () => {}, normalize = normalizeDocument }) {
    this.database = database;
    this.root = root;
    this.workspaceId = trustedWorkspaceId;
    this.now = now;
    this.id = id;
    this.inject = inject;
    this.normalize = normalize;
    this.objects = new ObjectStore(root, database, trustedWorkspaceId, { now });
  }

  async prepare({ documentId, baseRevisionId, format, content, limits }) {
    const base = this.database.prepare(`
      SELECT i.parser_version AS parserVersion, i.raw_digest AS rawDigest
      FROM document_imports AS i
      JOIN import_confirmations AS confirmation
        ON confirmation.workspace_id = i.workspace_id AND confirmation.import_id = i.import_id
      WHERE i.workspace_id = ? AND i.document_id = ? AND i.source_revision_id = ?
    `).get(this.workspaceId, documentId, baseRevisionId);
    if (!base) throw new ReimportConflictError("base revision is not a confirmed import");
    const parsed = this.normalize(format, content, { limits });
    if (parsed.originalDigest === base.rawDigest && parsed.parserVersion === base.parserVersion) {
      throw new ReimportConflictError("content is identical to the base revision");
    }
    let rawObject = this.objects.findByDigest(parsed.originalDigest);
    if (!rawObject) rawObject = await this.objects.commit(parsed.originalBytes);
    const previous = this.database.prepare(`
      SELECT segment_id AS segmentId, kind, structural_path AS structuralPath,
             source_text AS sourceText, source_digest AS sourceDigest,
             protected_json AS protectedJson, ordinal
      FROM source_segment_versions
      WHERE workspace_id = ? AND document_id = ? AND source_revision_id = ?
      ORDER BY ordinal
    `).all(this.workspaceId, documentId, baseRevisionId);
    const alignment = alignRevisionSegments(previous, parsed.segments);
    const identity = {
      operationId: this.id(),
      newRevisionId: this.id(),
      importId: this.id(),
      newSegmentIds: parsed.segments.map(() => this.id()),
    };
    const timestamp = this.now().toISOString();
    try {
      this.database.transaction(() => {
        this.database.prepare(`
          INSERT INTO reimport_operations VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL
          )
        `).run(
          this.workspaceId, identity.operationId, documentId, baseRevisionId,
          identity.newRevisionId, identity.importId, parsed.format, rawObject.objectId,
          parsed.originalDigest, parsed.normalized, parsed.normalizedDigest,
          stableJson(parsed.projection), parsed.projectionDigest, parsed.parserVersion,
          parsed.sanitizerVersion, stableJson(parsed.diagnostics), timestamp,
        );
        parsed.segments.forEach((segment, ordinal) => {
          const match = alignment.aligned[ordinal];
          this.database.prepare(`
            INSERT INTO reimport_segment_candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            this.workspaceId, identity.operationId, documentId, ordinal,
            identity.newSegmentIds[ordinal], match.oldSegmentId ?? null,
            match.status, match.score ?? null, segment.kind, segment.structuralPath,
            segment.sourceText, segment.sourceDigest, segment.translatable ? 1 : 0,
            stableJson(segment.protected), stableJson(match.evidence),
          );
        });
        this.inject("before-prepare-commit", identity);
      })();
    } catch (error) {
      if (/UNIQUE constraint failed: reimport_operations\.workspace_id, reimport_operations\.document_id/.test(error.message)) {
        throw new ReimportConflictError("document already has a pending reimport");
      }
      throw error;
    }
    return this.get(identity.operationId);
  }

  confirmAlignment(operationId, expectedVersion, ordinal, confirmedSegmentId, actorInput) {
    const actor = userActor(actorInput);
    return this.database.transaction(() => {
      const operation = this.#pending(operationId);
      if (operation.version !== expectedVersion) throw new ReimportConflictError("reimport version conflict");
      const candidate = this.database.prepare(`
        SELECT alignment_status AS status
        FROM reimport_segment_candidates
        WHERE workspace_id = ? AND operation_id = ? AND ordinal = ?
      `).get(this.workspaceId, operationId, ordinal);
      if (!candidate || candidate.status !== "ambiguous") throw new ReimportConflictError("segment does not require confirmation");
      if (confirmedSegmentId !== null) {
        const old = this.database.prepare(`
          SELECT 1 FROM source_segment_versions
          WHERE workspace_id = ? AND document_id = ? AND source_revision_id = ? AND segment_id = ?
        `).get(this.workspaceId, operation.documentId, operation.baseRevisionId, confirmedSegmentId);
        if (!old) throw new ReimportConflictError("confirmed segment is outside the base revision");
        const reserved = this.database.prepare(`
          SELECT 1 FROM reimport_segment_candidates
          WHERE workspace_id = ? AND operation_id = ? AND ordinal <> ? AND suggested_segment_id = ?
          UNION ALL
          SELECT 1 FROM reimport_alignment_confirmations
          WHERE workspace_id = ? AND operation_id = ? AND ordinal <> ? AND confirmed_segment_id = ?
          LIMIT 1
        `).get(this.workspaceId, operationId, ordinal, confirmedSegmentId, this.workspaceId, operationId, ordinal, confirmedSegmentId);
        if (reserved) throw new ReimportConflictError("stable segment is already assigned");
      }
      const changed = this.database.prepare(`
        UPDATE reimport_operations SET version = version + 1
        WHERE workspace_id = ? AND operation_id = ? AND status = 'pending' AND version = ?
      `).run(this.workspaceId, operationId, expectedVersion).changes;
      if (changed !== 1) throw new ReimportConflictError("reimport version conflict");
      this.database.prepare("INSERT INTO reimport_alignment_confirmations VALUES (?, ?, ?, ?, ?, 'user', ?, ?)")
        .run(this.workspaceId, operationId, operation.documentId, ordinal, confirmedSegmentId, actor.id, this.now().toISOString());
      return this.get(operationId);
    })();
  }

  confirmSemanticUnchanged(operationId, expectedVersion, ordinal, actorInput) {
    const actor = userActor(actorInput);
    return this.database.transaction(() => {
      const operation = this.#pending(operationId);
      if (operation.version !== expectedVersion) throw new ReimportConflictError("reimport version conflict");
      const candidate = this.database.prepare(`
        SELECT alignment_status AS status
        FROM reimport_segment_candidates
        WHERE workspace_id = ? AND operation_id = ? AND ordinal = ?
      `).get(this.workspaceId, operationId, ordinal);
      if (!candidate || !["changed", "moved"].includes(candidate.status)) {
        throw new ReimportConflictError("segment is not eligible for semantic confirmation");
      }
      const changed = this.database.prepare(`
        UPDATE reimport_operations SET version = version + 1
        WHERE workspace_id = ? AND operation_id = ? AND status = 'pending' AND version = ?
      `).run(this.workspaceId, operationId, expectedVersion).changes;
      if (changed !== 1) throw new ReimportConflictError("reimport version conflict");
      this.database.prepare("INSERT INTO reimport_semantic_confirmations VALUES (?, ?, ?, ?, 'user', ?, ?)")
        .run(this.workspaceId, operationId, operation.documentId, ordinal, actor.id, this.now().toISOString());
      return this.get(operationId);
    })();
  }

  finalize(operationId, expectedVersion) {
    return this.database.transaction(() => {
      const operation = this.#pending(operationId);
      if (operation.version !== expectedVersion) throw new ReimportConflictError("reimport version conflict");
      const candidates = this.database.prepare(`
        SELECT candidate.*, confirmation.confirmed_segment_id AS confirmedSegmentId,
               confirmation.ordinal IS NOT NULL AS hasConfirmation,
               semantic.ordinal IS NOT NULL AS semanticUnchanged
        FROM reimport_segment_candidates AS candidate
        LEFT JOIN reimport_alignment_confirmations AS confirmation
          ON confirmation.workspace_id = candidate.workspace_id
         AND confirmation.operation_id = candidate.operation_id
         AND confirmation.ordinal = candidate.ordinal
        LEFT JOIN reimport_semantic_confirmations AS semantic
          ON semantic.workspace_id = candidate.workspace_id
         AND semantic.operation_id = candidate.operation_id
         AND semantic.ordinal = candidate.ordinal
        WHERE candidate.workspace_id = ? AND candidate.operation_id = ?
        ORDER BY candidate.ordinal
      `).all(this.workspaceId, operationId);
      if (candidates.some((candidate) => candidate.alignment_status === "ambiguous" && candidate.hasConfirmation !== 1)) {
        throw new ReimportConflictError("all ambiguous segments must be confirmed");
      }
      const resolved = candidates.map((candidate) => ({
        ...candidate,
        segmentId: candidate.alignment_status === "ambiguous"
          ? candidate.confirmedSegmentId ?? candidate.new_segment_id
          : candidate.suggested_segment_id ?? candidate.new_segment_id,
        finalStatus: candidate.alignment_status === "ambiguous"
          ? candidate.confirmedSegmentId ? "changed" : "inserted"
          : candidate.alignment_status,
      }));
      if (new Set(resolved.map((candidate) => candidate.segmentId)).size !== resolved.length) throw new ReimportConflictError("stable segment assigned more than once");

      const timestamp = this.now().toISOString();
      this.database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, operation.newRevisionId, operation.documentId, operation.rawDigest, operation.normalizedDigest, timestamp);
      this.database.prepare(`
        INSERT INTO document_imports VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(
        this.workspaceId, operation.importId, operation.documentId, operation.newRevisionId,
        operation.format, operation.rawObjectId, operation.rawDigest, operation.normalizedText,
        operation.normalizedDigest, operation.projectionJson, operation.projectionDigest,
        operation.parserVersion, operation.sanitizerVersion, timestamp,
      );

      for (const candidate of resolved) {
        this.database.prepare("INSERT OR IGNORE INTO document_segments VALUES (?, ?, ?, ?)")
          .run(this.workspaceId, operation.documentId, candidate.segmentId, timestamp);
        this.database.prepare("INSERT INTO source_segment_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(
            this.workspaceId, operation.documentId, operation.newRevisionId, candidate.segmentId,
            candidate.kind, candidate.structural_path, candidate.source_text, candidate.source_digest,
            candidate.ordinal, candidate.translatable, candidate.protected_json, candidate.finalStatus,
          );
      }
      const diagnostics = JSON.parse(operation.diagnosticsJson);
      diagnostics.forEach((finding, sequence) => {
        this.database.prepare("INSERT INTO import_diagnostics VALUES (?, ?, ?, ?, ?, ?)")
          .run(this.workspaceId, operation.importId, sequence, finding.code, stableJson(finding.path), String(finding.detail ?? ""));
      });

      const previous = new Map(this.database.prepare(`
        SELECT segment_id AS segmentId, source_digest AS sourceDigest,
               structural_path AS structuralPath, protected_json AS protectedJson
        FROM source_segment_versions
        WHERE workspace_id = ? AND source_revision_id = ?
      `).all(this.workspaceId, operation.baseRevisionId).map((row) => [row.segmentId, row]));
      const used = new Set();
      let staleRequired = false;
      for (const candidate of resolved) {
        const old = previous.get(candidate.segmentId);
        if (old) used.add(candidate.segmentId);
        let changeKind;
        if (!old) changeKind = "inserted";
        else if (operation.baseParserVersion !== operation.parserVersion) changeKind = "parser-changed";
        else if (old.sourceDigest !== candidate.source_digest || old.protectedJson !== candidate.protected_json) changeKind = "changed";
        else if (old.structuralPath !== candidate.structural_path) changeKind = "moved";
        if (changeKind) {
          const stale = changeKind !== "moved" || old?.structuralPath !== candidate.structural_path;
          staleRequired ||= stale;
          this.#impact(operation, candidate.segmentId, changeKind, stale, {
            ordinal: candidate.ordinal,
            semanticUnchangedConfirmed: candidate.semanticUnchanged === 1,
          });
        }
      }
      for (const old of previous.values()) if (!used.has(old.segmentId)) {
        staleRequired = true;
        this.#impact(operation, old.segmentId, "deleted", true, {});
      }

      if (staleRequired) {
        const workflows = this.database.prepare(`
          SELECT workflow_id AS workflowId, state FROM translation_workflows
          WHERE workspace_id = ? AND document_id = ? AND source_revision_id = ?
            AND state NOT IN ('stale', 'rejected')
        `).all(this.workspaceId, operation.documentId, operation.baseRevisionId);
        for (const workflow of workflows) {
          this.database.prepare(`
            UPDATE translation_workflows SET state = 'stale', version = version + 1, updated_at = ?
            WHERE workspace_id = ? AND workflow_id = ?
          `).run(timestamp, this.workspaceId, workflow.workflowId);
          this.database.prepare(`
            INSERT INTO domain_audit_events(workspace_id,event_id,entity_type,entity_id,action,actor_type,actor_id,succeeded,details_json,occurred_at)
            VALUES (?, ?, 'translation-workflow', ?, 'source-revision-stale', 'system', 'reimport', 1, ?, ?)
          `).run(this.workspaceId, this.id(), workflow.workflowId, stableJson({ fromRevisionId: operation.baseRevisionId, toRevisionId: operation.newRevisionId }), timestamp);
        }
      }
      const changed = this.database.prepare(`
        UPDATE reimport_operations SET status = 'finalized', version = version + 1, finalized_at = ?
        WHERE workspace_id = ? AND operation_id = ? AND status = 'pending' AND version = ?
      `).run(timestamp, this.workspaceId, operationId, expectedVersion).changes;
      if (changed !== 1) throw new ReimportConflictError("reimport version conflict");
      this.inject("before-finalize-commit", operation);
      return this.get(operationId);
    })();
  }

  get(operationId, _untrustedWorkspaceId = undefined) {
    const row = this.database.prepare(`
      SELECT operation_id AS operationId, document_id AS documentId,
             base_revision_id AS baseRevisionId, new_revision_id AS newRevisionId,
             import_id AS importId, status, version
      FROM reimport_operations WHERE workspace_id = ? AND operation_id = ?
    `).get(this.workspaceId, operationId);
    if (!row) throw new ReimportConflictError("reimport not found");
    const candidates = this.database.prepare(`
      SELECT ordinal, alignment_status AS status, suggested_segment_id AS suggestedSegmentId
      FROM reimport_segment_candidates WHERE workspace_id = ? AND operation_id = ? ORDER BY ordinal
    `).all(this.workspaceId, operationId);
    return Object.freeze({ ...row, candidates: Object.freeze(candidates.map(Object.freeze)) });
  }

  #pending(operationId) {
    const row = this.database.prepare(`
      SELECT operation_id AS operationId, document_id AS documentId,
             base_revision_id AS baseRevisionId, new_revision_id AS newRevisionId,
             import_id AS importId, format, raw_object_id AS rawObjectId,
             raw_digest AS rawDigest, normalized_text AS normalizedText,
             normalized_digest AS normalizedDigest, projection_json AS projectionJson,
             projection_digest AS projectionDigest, parser_version AS parserVersion,
             sanitizer_version AS sanitizerVersion, diagnostics_json AS diagnosticsJson,
             status, version,
             (SELECT parser_version FROM document_imports
              WHERE workspace_id = reimport_operations.workspace_id
                AND source_revision_id = reimport_operations.base_revision_id) AS baseParserVersion
      FROM reimport_operations
      WHERE workspace_id = ? AND operation_id = ? AND status = 'pending'
    `).get(this.workspaceId, operationId);
    if (!row) throw new ReimportConflictError("pending reimport not found");
    return row;
  }

  #impact(operation, segmentId, changeKind, staleRequired, details) {
    this.database.prepare("INSERT INTO source_revision_impacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        this.workspaceId, this.id(), operation.documentId, operation.baseRevisionId,
        operation.newRevisionId, segmentId, changeKind, staleRequired ? 1 : 0, stableJson(details),
      );
  }
}
