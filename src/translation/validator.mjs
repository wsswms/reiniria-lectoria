import { randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { PARSER_VERSION, validateProtectedText } from "../document/parser.mjs";
import { WorkCopyConflictError, WorkCopyService } from "./work-copy-service.mjs";

export const VALIDATOR_VERSION = "lectoria-validator-v1";

export class ValidationConflictError extends Error {
  constructor(message = "validation conflict") {
    super(message);
    this.name = "ValidationConflictError";
    this.code = "VALIDATION_CONFLICT";
  }
}

function values(text, pattern) {
  return [...String(text).toLowerCase().matchAll(pattern)].map((match) => match[0]).sort();
}

function missingValues(source, target, pattern) {
  const available = values(target, pattern);
  return values(source, pattern).filter((value) => {
    const index = available.indexOf(value);
    if (index < 0) return true;
    available.splice(index, 1);
    return false;
  });
}

function finding(severity, code, segmentId = null, details = {}) {
  return Object.freeze({ severity, code, segmentId, details: Object.freeze(details) });
}

export function validateTranslationInput({ workflow, sourceSegments, translations }) {
  const findings = [];
  const expected = new Map(sourceSegments.map((segment) => [segment.segmentId, segment]));
  const seen = new Set();
  for (const translation of translations) {
    const segmentId = translation.segmentId;
    if (seen.has(segmentId)) {
      findings.push(finding("error", "DUPLICATE_SEGMENT", segmentId));
      continue;
    }
    seen.add(segmentId);
    const source = expected.get(segmentId);
    if (!source) {
      findings.push(finding("error", "UNKNOWN_SEGMENT", segmentId));
      continue;
    }
    if (translation.workflowId !== workflow.workflowId) findings.push(finding("error", "WORKFLOW_MISMATCH", segmentId));
    if (translation.sourceRevisionId !== workflow.sourceRevisionId) findings.push(finding("error", "SOURCE_REVISION_MISMATCH", segmentId));
    if (translation.targetLanguage !== workflow.targetLanguage) findings.push(finding("error", "TARGET_LANGUAGE_MISMATCH", segmentId));
    if (translation.structuralPath !== source.structuralPath || translation.kind !== source.kind) findings.push(finding("error", "STRUCTURE_MISMATCH", segmentId));
    if (typeof translation.text !== "string" || translation.text.trim().length === 0) {
      findings.push(finding("error", "EMPTY_TARGET", segmentId));
      continue;
    }
    try {
      validateProtectedText(translation.text, source.protected);
    } catch (error) {
      findings.push(finding("error", error.code ?? "PROTECTED_VALUE_MISMATCH", segmentId));
    }
    const missingDates = missingValues(source.sourceText, translation.text, /\b\d{4}-\d{2}-\d{2}\b/g);
    if (missingDates.length > 0) findings.push(finding("warning", "DATE_VALUE_CHANGED", segmentId, { missing: missingDates }));
    const missingUnits = missingValues(source.sourceText, translation.text, /\b\d+(?:[.,]\d+)?\s*(?:kg|g|km|cm|mm|°c|%|usd|eur)\b/g);
    if (missingUnits.length > 0) findings.push(finding("warning", "UNIT_VALUE_CHANGED", segmentId, { missing: missingUnits }));
    const missingNumbers = missingValues(source.sourceText, translation.text, /\b\d+(?:[.,]\d+)?\b/g);
    if (missingNumbers.length > 0) findings.push(finding("warning", "NUMBER_VALUE_CHANGED", segmentId, { missing: missingNumbers }));
    if (translation.text === source.sourceText) findings.push(finding("info", "TARGET_EQUALS_SOURCE", segmentId));
  }
  for (const source of sourceSegments) if (!seen.has(source.segmentId)) findings.push(finding("error", "MISSING_SEGMENT", source.segmentId));
  return Object.freeze(findings);
}

export class ValidationService {
  constructor(database, trustedWorkspaceId, {
    now = () => new Date(), id = () => randomUUID(), workCopies,
    parserVersion = PARSER_VERSION, validatorVersion = VALIDATOR_VERSION,
  } = {}) {
    this.database = database;
    this.workspaceId = trustedWorkspaceId;
    this.now = now;
    this.id = id;
    this.parserVersion = parserVersion;
    this.validatorVersion = validatorVersion;
    this.workCopies = workCopies ?? new WorkCopyService(database, trustedWorkspaceId, { now, id });
  }

  run(workflowId) {
    const bundle = this.workCopies.getBundle(workflowId);
    const parserVersion = this.#parserFingerprint(bundle.workflow.sourceRevisionId);
    const translations = bundle.segments
      .filter((segment) => segment.headRevisionId !== null)
      .map((segment) => ({
        workflowId,
        sourceRevisionId: bundle.workflow.sourceRevisionId,
        targetLanguage: bundle.workflow.targetLanguage,
        segmentId: segment.segmentId,
        structuralPath: segment.structuralPath,
        kind: segment.kind,
        text: segment.text,
      }));
    const findings = validateTranslationInput({ workflow: bundle.workflow, sourceSegments: bundle.segments, translations });
    const validationRunId = this.id();
    const timestamp = this.now().toISOString();
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO validation_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        this.workspaceId, validationRunId, workflowId, bundle.workflow.documentId,
        bundle.workflow.sourceRevisionId, bundle.workflow.targetLanguage,
        bundle.digest, parserVersion, this.validatorVersion, timestamp,
      );
      findings.forEach((item) => {
        this.database.prepare("INSERT INTO validation_findings VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          this.workspaceId, validationRunId, this.id(), item.severity,
          item.code, item.segmentId, stableJson(item.details),
        );
      });
    })();
    return this.get(validationRunId);
  }

  get(validationRunId, _untrustedWorkspaceId = undefined) {
    const run = this.database.prepare(`
      SELECT validation_run_id AS validationRunId, workflow_id AS workflowId,
             source_revision_id AS sourceRevisionId, target_language AS targetLanguage,
             working_copy_digest AS workingCopyDigest, parser_version AS parserVersion,
             validator_version AS validatorVersion, created_at AS createdAt
      FROM validation_runs WHERE workspace_id = ? AND validation_run_id = ?
    `).get(this.workspaceId, validationRunId);
    if (!run) throw new ValidationConflictError("validation run not found");
    const findings = this.database.prepare(`
      SELECT finding_id AS findingId, severity, code, segment_id AS segmentId,
             details_json AS detailsJson
      FROM validation_findings
      WHERE workspace_id = ? AND validation_run_id = ?
      ORDER BY severity, code, coalesce(segment_id, ''), finding_id
    `).all(this.workspaceId, validationRunId).map((row) => Object.freeze({ ...row, details: JSON.parse(row.detailsJson) }));
    return Object.freeze({ ...run, findings: Object.freeze(findings), current: this.isCurrent(run) });
  }

  isCurrent(runOrId) {
    const run = typeof runOrId === "string"
      ? this.database.prepare("SELECT validation_run_id AS validationRunId, workflow_id AS workflowId, source_revision_id AS sourceRevisionId, working_copy_digest AS workingCopyDigest, parser_version AS parserVersion, validator_version AS validatorVersion FROM validation_runs WHERE workspace_id = ? AND validation_run_id = ?").get(this.workspaceId, runOrId)
      : runOrId;
    if (!run) return false;
    try {
      const bundle = this.workCopies.getBundle(run.workflowId);
      return run.sourceRevisionId === bundle.workflow.sourceRevisionId
        && run.workingCopyDigest === bundle.digest
        && run.parserVersion === this.#parserFingerprint(run.sourceRevisionId)
        && run.validatorVersion === this.validatorVersion;
    } catch (error) {
      if (error instanceof WorkCopyConflictError) return false;
      throw error;
    }
  }

  #parserFingerprint(sourceRevisionId) {
    const row = this.database.prepare("SELECT parser_version AS parserVersion FROM document_imports WHERE workspace_id = ? AND source_revision_id = ?")
      .get(this.workspaceId, sourceRevisionId);
    if (!row) throw new ValidationConflictError("source parser version not found");
    return `${row.parserVersion}|runtime:${this.parserVersion}`;
  }
}
