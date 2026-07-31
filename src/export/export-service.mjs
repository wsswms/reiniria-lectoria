import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeCanonicalPackage } from "../domain/canonical.mjs";
import { stableJson } from "../domain/contracts.mjs";
import { stageAtomicDirectory } from "../storage/staging.mjs";
import { ValidationService } from "../translation/validator.mjs";
import { WorkCopyService } from "../translation/work-copy-service.mjs";
import { serializeOrdinaryDocument, verifyOrdinaryDocument } from "./serializer.mjs";

export class ExportConflictError extends Error {
  constructor(message = "export conflict") {
    super(message);
    this.name = "ExportConflictError";
    this.code = "EXPORT_CONFLICT";
  }
}

const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function deterministicUuid(value) {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ["8", "9", "a", "b"][parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function filename(format) {
  return { canonical: "translation.canonical.json", markdown: "translation.md", html: "translation.html", text: "translation.txt" }[format];
}

export class ExportService {
  constructor({ database, root, trustedWorkspaceId, now = () => new Date(), id = () => randomUUID(), inject = () => {}, workCopies, validation }) {
    this.database = database;
    this.root = root;
    this.workspaceId = trustedWorkspaceId;
    this.now = now;
    this.id = id;
    this.inject = inject;
    this.workCopies = workCopies ?? new WorkCopyService(database, trustedWorkspaceId, { now, id });
    this.validation = validation ?? new ValidationService(database, trustedWorkspaceId, { now, id, workCopies: this.workCopies });
  }

  async export(workflowId, validationRunId, format) {
    if (!new Set(["canonical", "markdown", "html", "text"]).has(format)) throw new TypeError("unsupported export format");
    const workflow = this.#workflow(workflowId);
    const run = this.validation.get(validationRunId);
    if (run.workflowId !== workflowId || !run.current) throw new ExportConflictError("validation run is missing or stale");
    const pendingReimport = this.database.prepare("SELECT 1 FROM reimport_operations WHERE workspace_id = ? AND document_id = ? AND status = 'pending'")
      .get(this.workspaceId, workflow.documentId);
    if (pendingReimport) throw new ExportConflictError("pending reimport must be resolved before export");
    const existing = this.#existing(workflowId, validationRunId, format);
    if (existing && workflow.state === "exported") return this.#verifyExisting(existing);
    if (!["approved-for-export", "exported"].includes(workflow.state)) throw new ExportConflictError("workflow is not approved for export");
    if (run.findings.some((item) => item.severity === "error")) throw new ExportConflictError("validation errors block export");
    const confirmedWarnings = new Set(this.database.prepare(`
      SELECT json_extract(details_json, '$.findingId') AS findingId FROM review_events
      WHERE workspace_id = ? AND workflow_id = ? AND validation_run_id = ? AND action = 'warning-confirmed'
    `).all(this.workspaceId, workflowId, validationRunId).map((row) => row.findingId));
    if (run.findings.some((item) => item.severity === "warning" && !confirmedWarnings.has(item.findingId))) throw new ExportConflictError("unconfirmed warnings block export");
    const approved = this.database.prepare(`
      SELECT 1 FROM review_events WHERE workspace_id = ? AND workflow_id = ?
        AND validation_run_id = ? AND action = 'approved-for-export'
    `).get(this.workspaceId, workflowId, validationRunId);
    if (!approved) throw new ExportConflictError("approval does not match the validation run");

    const source = this.database.prepare(`
      SELECT document.title, revision.original_digest AS originalDigest,
             import.format, import.normalized_text AS normalizedSource
      FROM translation_workflows AS workflow
      JOIN documents AS document ON document.workspace_id = workflow.workspace_id AND document.document_id = workflow.document_id
      JOIN source_revisions AS revision ON revision.workspace_id = workflow.workspace_id AND revision.source_revision_id = workflow.source_revision_id
      JOIN document_imports AS import ON import.workspace_id = workflow.workspace_id AND import.source_revision_id = workflow.source_revision_id
      JOIN import_confirmations AS confirmation ON confirmation.workspace_id = import.workspace_id AND confirmation.import_id = import.import_id
      WHERE workflow.workspace_id = ? AND workflow.workflow_id = ?
    `).get(this.workspaceId, workflowId);
    if (!source) throw new ExportConflictError("source import is not confirmed");
    if (format !== "canonical" && format !== source.format) throw new ExportConflictError("ordinary export must use the source format");
    const bundle = this.workCopies.getBundle(workflowId);
    if (bundle.segments.some((segment) => segment.headRevisionId === null)) throw new ExportConflictError("working copy is incomplete");
    let content;
    if (format === "canonical") {
      const packageValue = {
        schema_version: "1.0",
        package_type: "translation_bundle",
        package_id: deterministicUuid(`${workflowId}\n${validationRunId}`),
        created_at: run.createdAt,
        origin: { adapter: "reiniria-lectoria", source_digest: source.originalDigest },
        document: {
          title: source.title,
          source_language: "und",
          metadata: { source_revision_id: workflow.sourceRevisionId, target_language: workflow.targetLanguage },
          segments: bundle.segments.map((segment) => ({
            segment_ref: segment.segmentId, order: segment.ordinal, kind: segment.kind,
            source: segment.sourceText, protected: segment.protected,
            target: { language: workflow.targetLanguage, text: segment.text, review_status: "approved-for-export" },
          })),
        },
      };
      content = Buffer.from(encodeCanonicalPackage(packageValue));
    } else {
      content = serializeOrdinaryDocument(format, source.normalizedSource, bundle.segments);
      verifyOrdinaryDocument(format, content, bundle.segments);
    }
    const contentDigest = digest(content);
    const manifestBase = {
      format: "reiniria-export-v1", artifact_format: format,
      workflow_id: workflowId, source_revision_id: workflow.sourceRevisionId,
      target_language: workflow.targetLanguage, validation_run_id: validationRunId,
      working_copy_digest: bundle.digest, content_digest: contentDigest,
      filename: filename(format),
    };
    const manifestDigest = digest(Buffer.from(stableJson(manifestBase)));
    const manifest = Buffer.from(`${stableJson({ ...manifestBase, manifest_digest: manifestDigest })}\n`);
    const relativeDirectory = `exports/${manifestDigest.slice(7)}`;
    await stageAtomicDirectory(this.root, relativeDirectory, { [filename(format)]: content, "manifest.json": manifest }, { inject: this.inject });
    this.inject("after-export-stage");

    const exportId = this.id();
    try {
      this.database.transaction(() => {
        this.database.prepare("INSERT OR IGNORE INTO export_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
          this.workspaceId, exportId, workflowId, validationRunId, contentDigest,
          manifestDigest, `staging/${relativeDirectory}`, this.now().toISOString(),
        );
        const record = this.database.prepare("SELECT export_id AS exportId FROM export_records WHERE workspace_id = ? AND workflow_id = ? AND validation_run_id = ? AND content_digest = ? AND manifest_digest = ?")
          .get(this.workspaceId, workflowId, validationRunId, contentDigest, manifestDigest);
        this.database.prepare("INSERT OR IGNORE INTO export_artifact_metadata VALUES (?, ?, ?, ?)")
          .run(this.workspaceId, record.exportId, format, filename(format));
        if (workflow.state === "approved-for-export") {
          const changed = this.database.prepare("UPDATE translation_workflows SET state = 'exported', version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND state = 'approved-for-export' AND version = ?")
            .run(this.now().toISOString(), this.workspaceId, workflowId, workflow.version).changes;
          if (changed !== 1) throw new ExportConflictError("workflow export version conflict");
        }
        this.inject("before-export-commit");
      })();
    } catch (error) {
      if (error?.code?.startsWith("SQLITE_CONSTRAINT")) throw new ExportConflictError("export record conflict");
      throw error;
    }
    return this.#verifyExisting(this.#existing(workflowId, validationRunId, format));
  }

  #existing(workflowId, validationRunId, format) {
    return this.database.prepare(`
      SELECT record.export_id AS exportId, record.content_digest AS contentDigest,
             record.manifest_digest AS manifestDigest, record.relative_path AS relativePath,
             metadata.format, metadata.filename
      FROM export_records AS record
      JOIN export_artifact_metadata AS metadata
        ON metadata.workspace_id = record.workspace_id AND metadata.export_id = record.export_id
      WHERE record.workspace_id = ? AND record.workflow_id = ?
        AND record.validation_run_id = ? AND metadata.format = ?
      ORDER BY record.created_at, record.export_id LIMIT 1
    `).get(this.workspaceId, workflowId, validationRunId, format);
  }

  async #verifyExisting(record) {
    if (!record) throw new ExportConflictError("export record not found");
    const content = await readFile(join(this.root, record.relativePath, record.filename)).catch(() => null);
    const manifest = await readFile(join(this.root, record.relativePath, "manifest.json")).catch(() => null);
    if (!content || digest(content) !== record.contentDigest || !manifest) throw new ExportConflictError("export artifact is missing or corrupted");
    const parsed = JSON.parse(manifest.toString("utf8"));
    if (parsed.manifest_digest !== record.manifestDigest || digest(Buffer.from(stableJson(Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "manifest_digest"))))) !== record.manifestDigest) {
      throw new ExportConflictError("export manifest is corrupted");
    }
    return Object.freeze({ ...record, content: Buffer.from(content), manifest: Object.freeze(parsed) });
  }

  #workflow(workflowId) {
    const row = this.database.prepare("SELECT workflow_id AS workflowId, document_id AS documentId, source_revision_id AS sourceRevisionId, target_language AS targetLanguage, state, version FROM translation_workflows WHERE workspace_id = ? AND workflow_id = ?")
      .get(this.workspaceId, workflowId);
    if (!row) throw new ExportConflictError("workflow not found");
    return row;
  }
}
