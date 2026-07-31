import { randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { ObjectStore } from "../storage/object-store.mjs";
import { normalizeDocument } from "./parser.mjs";

export class ImportConflictError extends Error {
  constructor(message = "document import conflict") {
    super(message);
    this.name = "ImportConflictError";
    this.code = "IMPORT_CONFLICT";
  }
}

function userActor(input) {
  if (!input || input.type !== "user" || typeof input.id !== "string" || input.id.length === 0) throw new TypeError("a user actor is required");
  return input;
}

export class DocumentImportService {
  constructor({ database, root, trustedWorkspaceId, now = () => new Date(), id = () => randomUUID(), inject = () => {} }) {
    this.database = database;
    this.root = root;
    this.workspaceId = trustedWorkspaceId;
    this.now = now;
    this.id = id;
    this.inject = inject;
    this.objects = new ObjectStore(root, database, trustedWorkspaceId, { now, inject: (point, context) => inject(`object:${point}`, context) });
  }

  async import({ format, content, title = "Untitled", limits }) {
    if (typeof title !== "string" || title.trim().length === 0) throw new TypeError("title is required");
    const parsed = normalizeDocument(format, content, { limits });
    this.inject("after-normalize", parsed);
    let rawObject = this.objects.findByDigest(parsed.originalDigest);
    if (!rawObject) rawObject = await this.objects.commit(parsed.originalBytes);
    this.inject("after-snapshot", rawObject);

    const identity = {
      importId: this.id(),
      documentId: this.id(),
      sourceRevisionId: this.id(),
      segmentIds: parsed.segments.map(() => this.id()),
    };
    const timestamp = this.now().toISOString();
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)")
        .run(this.workspaceId, identity.documentId, title.trim(), timestamp);
      this.database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, identity.sourceRevisionId, identity.documentId, parsed.originalDigest, parsed.normalizedDigest, timestamp);
      this.database.prepare(`
        INSERT INTO document_imports VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        this.workspaceId, identity.importId, identity.documentId, identity.sourceRevisionId,
        parsed.format, rawObject.objectId, parsed.originalDigest, parsed.normalized,
        parsed.normalizedDigest, stableJson(parsed.projection), parsed.projectionDigest,
        parsed.parserVersion, parsed.sanitizerVersion, 1, timestamp,
      );
      this.inject("after-import-record", identity);
      parsed.segments.forEach((segment, index) => {
        const segmentId = identity.segmentIds[index];
        this.database.prepare("INSERT INTO document_segments VALUES (?, ?, ?, ?)")
          .run(this.workspaceId, identity.documentId, segmentId, timestamp);
        this.database.prepare("INSERT INTO source_segment_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(
            this.workspaceId, identity.documentId, identity.sourceRevisionId, segmentId,
            segment.kind, segment.structuralPath, segment.sourceText, segment.sourceDigest,
            segment.ordinal, segment.translatable ? 1 : 0, stableJson(segment.protected), "initial",
          );
        this.inject("after-segment", { ...identity, index });
      });
      parsed.diagnostics.forEach((finding, sequence) => {
        this.database.prepare("INSERT INTO import_diagnostics VALUES (?, ?, ?, ?, ?, ?)")
          .run(this.workspaceId, identity.importId, sequence, finding.code, stableJson(finding.path), String(finding.detail ?? ""));
      });
      this.inject("before-import-commit", identity);
    })();
    return this.get(identity.importId);
  }

  confirm(importId, actorInput) {
    const actor = userActor(actorInput);
    const current = this.get(importId);
    if (current.confirmed) throw new ImportConflictError("document import is already confirmed");
    this.database.prepare("INSERT INTO import_confirmations VALUES (?, ?, 'user', ?, ?)")
      .run(this.workspaceId, importId, actor.id, this.now().toISOString());
    return this.get(importId);
  }

  get(importId, _untrustedWorkspaceId = undefined) {
    const row = this.database.prepare(`
      SELECT i.import_id AS importId, i.document_id AS documentId,
             i.source_revision_id AS sourceRevisionId, i.format,
             i.raw_digest AS rawDigest, i.normalized_digest AS normalizedDigest,
             i.projection_digest AS projectionDigest,
             i.requires_confirmation AS requiresConfirmation,
             c.confirmed_at AS confirmedAt
      FROM document_imports AS i
      LEFT JOIN import_confirmations AS c
        ON c.workspace_id = i.workspace_id AND c.import_id = i.import_id
      WHERE i.workspace_id = ? AND i.import_id = ?
    `).get(this.workspaceId, importId);
    if (!row) throw new ImportConflictError("document import not found");
    const diagnostics = this.database.prepare(`
      SELECT sequence, code, path_json AS pathJson, detail
      FROM import_diagnostics WHERE workspace_id = ? AND import_id = ? ORDER BY sequence
    `).all(this.workspaceId, importId).map((finding) => Object.freeze({ ...finding, path: JSON.parse(finding.pathJson) }));
    return Object.freeze({
      ...row,
      requiresConfirmation: row.requiresConfirmation === 1,
      confirmed: row.confirmedAt !== null,
      diagnostics: Object.freeze(diagnostics),
    });
  }
}
