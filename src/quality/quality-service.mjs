import { createHash, randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { ValidationService, validateTranslationInput } from "../translation/validator.mjs";
import { WorkCopyService } from "../translation/work-copy-service.mjs";
import { QualityRuleRegistry } from "./rule-registry.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const severityOrder = Object.freeze({ error: 0, warning: 1, info: 2 });

export class QualityConflictError extends Error {
  constructor(message = "quality conflict") {
    super(message);
    this.name = "QualityConflictError";
    this.code = "QUALITY_CONFLICT";
  }
}

function contains(text, value) {
  return String(text).toLocaleLowerCase().includes(String(value).toLocaleLowerCase());
}

function normalizedFinding(rule, segment, subjectRevisionId, evidenceDigest, parameters) {
  return {
    severity: rule.severity, ruleId: rule.ruleId, ruleVersion: rule.ruleVersion,
    segmentId: segment?.segmentId ?? null, subjectRevisionId,
    factId: rule.factId ?? null, factRevisionId: rule.factRevisionId ?? null,
    evidenceDigest, parameters,
  };
}

export class QualityService {
  constructor(database, trustedWorkspaceId, {
    now = () => new Date(), id = () => randomUUID(), workCopies, validation, registry,
  } = {}) {
    this.database = database;
    this.workspaceId = trustedWorkspaceId;
    this.now = now;
    this.id = id;
    this.workCopies = workCopies ?? new WorkCopyService(database, trustedWorkspaceId, { now, id });
    this.validation = validation ?? new ValidationService(database, trustedWorkspaceId, { now, id, workCopies: this.workCopies });
    this.registry = registry ?? new QualityRuleRegistry(database, trustedWorkspaceId, {
      parserVersion: this.validation.parserVersion,
      validatorVersion: this.validation.validatorVersion,
    });
  }

  runCandidate(workflowId, segmentId, candidateId, { evidenceIds = [] } = {}) {
    const workflow = this.#workflow(workflowId);
    const segment = this.#segment(workflow, segmentId);
    const candidate = this.database.prepare(`
      SELECT candidate_id AS candidateId, text, text_digest AS textDigest
      FROM translation_candidates WHERE workspace_id = ? AND workflow_id = ? AND segment_id = ? AND candidate_id = ?
    `).get(this.workspaceId, workflowId, segmentId, candidateId);
    if (!candidate) throw new QualityConflictError("candidate not found");
    const snapshot = this.#snapshot(workflow);
    const evidenceDigest = this.#evidenceDigest(workflow, segmentId, evidenceIds);
    const translations = [{ workflowId, sourceRevisionId: workflow.sourceRevisionId, targetLanguage: workflow.targetLanguage,
      segmentId, structuralPath: segment.structuralPath, kind: segment.kind, text: candidate.text }];
    const builtin = validateTranslationInput({ workflow, sourceSegments: [segment], translations });
    const findings = this.#findings(snapshot, [segment], new Map([[segmentId, candidate.text]]),
      new Map([[segmentId, candidateId]]), evidenceDigest, builtin);
    return this.#storeRun({ workflow, segmentId, subjectType: "candidate", subjectId: candidateId,
      subjectDigest: candidate.textDigest, snapshot, evidenceDigest, validationRunId: null, findings });
  }

  runWorking(workflowId, { evidenceIds = [] } = {}) {
    const bundle = this.workCopies.getBundle(workflowId);
    if (bundle.segments.some((segment) => segment.headRevisionId === null)) throw new QualityConflictError("working copy is incomplete");
    const snapshot = this.#snapshot(bundle.workflow);
    const evidenceDigest = this.#evidenceDigest(bundle.workflow, null, evidenceIds);
    const validation = this.#currentValidation(workflowId, bundle.digest) ?? this.validation.run(workflowId);
    const revisions = new Map(bundle.segments.map((segment) => [segment.segmentId, segment.headRevisionId]));
    const texts = new Map(bundle.segments.map((segment) => [segment.segmentId, segment.text]));
    const builtin = validation.findings.map((item) => ({ severity: item.severity, code: item.code, segmentId: item.segmentId, details: item.details }));
    const findings = this.#findings(snapshot, bundle.segments, texts, revisions, evidenceDigest, builtin);
    return this.#storeRun({ workflow: bundle.workflow, segmentId: null, subjectType: "working-copy",
      subjectId: bundle.digest, subjectDigest: bundle.digest, snapshot, evidenceDigest,
      validationRunId: validation.validationRunId, findings, workingSegments: bundle.segments });
  }

  compare(workflowId, segmentId, candidateIds, { evidenceIds = [] } = {}) {
    if (!Array.isArray(candidateIds) || candidateIds.length < 2 || candidateIds.length > 20 || new Set(candidateIds).size !== candidateIds.length) {
      throw new TypeError("comparison requires 2 to 20 unique candidates");
    }
    const available = this.workCopies.listCandidates(workflowId, segmentId).map((item) => item.candidateId).sort();
    if (stableJson([...candidateIds].sort()) !== stableJson(available)) throw new QualityConflictError("comparison candidate set is incomplete or out of scope");
    const runs = candidateIds.map((candidateId) => this.runCandidate(workflowId, segmentId, candidateId, { evidenceIds }));
    const members = runs.map((run) => {
      const counts = { error: 0, warning: 0, info: 0 };
      for (const finding of run.findings) counts[finding.severity] += 1;
      return { candidateId: run.subjectId, qualityRunId: run.qualityRunId, ...counts,
        evidenceCoverage: evidenceIds.length > 0 ? 100 : 0 };
    }).sort((left, right) => left.error - right.error || left.warning - right.warning || left.info - right.info
      || right.evidenceCoverage - left.evidenceCoverage || left.candidateId.localeCompare(right.candidateId))
      .map((item, index) => ({ ...item, rank: index + 1 }));
    const first = runs[0];
    const identity = { workflowId, segmentId, ruleSnapshotId: first.ruleSnapshotId, members };
    const comparisonDigest = sha(stableJson(identity));
    const comparisonId = comparisonDigest;
    this.database.transaction(() => {
      this.database.prepare("INSERT OR IGNORE INTO candidate_comparisons VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, comparisonId, workflowId, segmentId, first.ruleSnapshotId, comparisonDigest, this.now().toISOString());
      for (const member of members) this.database.prepare("INSERT OR IGNORE INTO candidate_comparison_members VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, comparisonId, workflowId, segmentId, member.candidateId, member.qualityRunId,
          member.rank, member.error, member.warning, member.info, member.evidenceCoverage);
    })();
    return this.getComparison(comparisonId);
  }

  get(qualityRunId) {
    const run = this.database.prepare(`
      SELECT quality_run_id AS qualityRunId, workflow_id AS workflowId, segment_id AS segmentId,
             subject_type AS subjectType, subject_id AS subjectId, subject_digest AS subjectDigest,
             rule_snapshot_id AS ruleSnapshotId, validation_run_id AS validationRunId,
             evidence_digest AS evidenceDigest, summary_digest AS summaryDigest, created_at AS createdAt
      FROM quality_runs WHERE workspace_id = ? AND quality_run_id = ?
    `).get(this.workspaceId, qualityRunId);
    if (!run) throw new QualityConflictError("quality run not found");
    const findings = this.database.prepare(`
      SELECT finding_id AS findingId, severity, rule_id AS ruleId, rule_version AS ruleVersion,
             segment_id AS segmentId, subject_revision_id AS subjectRevisionId,
             fact_id AS factId, fact_revision_id AS factRevisionId, evidence_digest AS evidenceDigest,
             parameters_json AS parametersJson
      FROM quality_findings WHERE workspace_id = ? AND quality_run_id = ? ORDER BY ordinal
    `).all(this.workspaceId, qualityRunId).map((row) => Object.freeze({ ...row, parameters: JSON.parse(row.parametersJson) }));
    const status = this.currentStatus(run);
    return Object.freeze({ ...run, findings: Object.freeze(findings), current: status.current, staleReason: status.reason });
  }

  getComparison(comparisonId) {
    const row = this.database.prepare(`SELECT comparison_id AS comparisonId, workflow_id AS workflowId,
      segment_id AS segmentId, rule_snapshot_id AS ruleSnapshotId, comparison_digest AS comparisonDigest,
      created_at AS createdAt FROM candidate_comparisons WHERE workspace_id = ? AND comparison_id = ?`)
      .get(this.workspaceId, comparisonId);
    if (!row) throw new QualityConflictError("comparison not found");
    const members = this.database.prepare(`SELECT candidate_id AS candidateId, quality_run_id AS qualityRunId,
      rank, error_count AS errorCount, warning_count AS warningCount, info_count AS infoCount,
      evidence_coverage AS evidenceCoverage FROM candidate_comparison_members
      WHERE workspace_id = ? AND comparison_id = ? ORDER BY rank`)
      .all(this.workspaceId, comparisonId).map((member) => Object.freeze(member));
    const available = this.workCopies.listCandidates(row.workflowId, row.segmentId).map((item) => item.candidateId).sort();
    const memberIds = members.map((member) => member.candidateId).sort();
    return Object.freeze({ ...row, members: Object.freeze(members),
      current: stableJson(available) === stableJson(memberIds) && members.every((member) => this.currentStatus(member.qualityRunId).current) });
  }

  confirmWarning(workflowId, qualityRunId, findingId, actor) {
    if (!actor || actor.type !== "user" || typeof actor.id !== "string" || actor.id.length === 0) {
      throw new QualityConflictError("only a user can confirm a quality warning");
    }
    const run = this.get(qualityRunId);
    if (run.workflowId !== workflowId || !run.current) throw new QualityConflictError("quality run is stale or out of scope");
    if (!run.findings.some((item) => item.findingId === findingId && item.severity === "warning")) throw new QualityConflictError("quality warning not found");
    try {
      this.database.prepare("INSERT INTO quality_warning_confirmations VALUES (?, ?, ?, ?, ?, 'user', ?, ?)")
        .run(this.workspaceId, this.id(), workflowId, qualityRunId, findingId, actor.id, this.now().toISOString());
    } catch (error) {
      if (error?.code?.startsWith("SQLITE_CONSTRAINT")) throw new QualityConflictError("quality warning confirmation conflict");
      throw error;
    }
    return this.get(qualityRunId);
  }

  assertEligible(workflowId, qualityRunId) {
    const run = this.get(qualityRunId);
    if (run.workflowId !== workflowId || run.subjectType !== "working-copy" || !run.current) throw new QualityConflictError("quality run is stale or out of scope");
    if (run.findings.some((item) => item.severity === "error")) throw new QualityConflictError("quality errors block review");
    const confirmed = new Set(this.database.prepare("SELECT finding_id AS findingId FROM quality_warning_confirmations WHERE workspace_id = ? AND quality_run_id = ?")
      .all(this.workspaceId, qualityRunId).map((row) => row.findingId));
    if (run.findings.some((item) => item.severity === "warning" && !confirmed.has(item.findingId))) throw new QualityConflictError("unconfirmed quality warnings block review");
    return run;
  }

  currentStatus(runOrId) {
    const run = typeof runOrId === "string" ? this.database.prepare(`SELECT quality_run_id AS qualityRunId,
      workflow_id AS workflowId, segment_id AS segmentId, subject_type AS subjectType, subject_id AS subjectId,
      subject_digest AS subjectDigest, rule_snapshot_id AS ruleSnapshotId, validation_run_id AS validationRunId
      FROM quality_runs WHERE workspace_id = ? AND quality_run_id = ?`).get(this.workspaceId, runOrId) : runOrId;
    if (!run) return Object.freeze({ current: false, reason: "missing" });
    let workflow;
    try { workflow = this.#workflow(run.workflowId); } catch { return Object.freeze({ current: false, reason: "workflow" }); }
    const currentSnapshot = this.registry.build(workflow);
    if (currentSnapshot.ruleSnapshotId !== run.ruleSnapshotId) return Object.freeze({ current: false, reason: "rule-or-fact" });
    if (run.subjectType === "candidate") {
      const candidate = this.database.prepare("SELECT text_digest AS textDigest FROM translation_candidates WHERE workspace_id = ? AND workflow_id = ? AND segment_id = ? AND candidate_id = ?")
        .get(this.workspaceId, run.workflowId, run.segmentId, run.subjectId);
      if (!candidate || candidate.textDigest !== run.subjectDigest) return Object.freeze({ current: false, reason: "candidate" });
    } else {
      try {
        if (this.workCopies.getBundle(run.workflowId).digest !== run.subjectDigest) return Object.freeze({ current: false, reason: "working-copy" });
        if (!this.validation.isCurrent(run.validationRunId)) return Object.freeze({ current: false, reason: "validator" });
      } catch { return Object.freeze({ current: false, reason: "working-copy" }); }
    }
    return Object.freeze({ current: true, reason: null });
  }

  #snapshot(workflow) {
    const snapshot = this.registry.build(workflow);
    this.database.prepare("INSERT OR IGNORE INTO quality_rule_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.workspaceId, snapshot.ruleSnapshotId, snapshot.registryVersion, snapshot.rulesDigest,
        snapshot.factHeadsDigest, snapshot.parserVersion, snapshot.validatorVersion, stableJson(snapshot.rules), this.now().toISOString());
    return snapshot;
  }

  #findings(snapshot, segments, texts, revisions, evidenceDigest, builtinFindings) {
    const byCode = new Map(snapshot.rules.filter((rule) => rule.validatorCode).map((rule) => [rule.validatorCode, rule]));
    const output = [];
    for (const item of builtinFindings) {
      const protectionFailure = item.code?.startsWith("PROTECTED_") || item.code?.startsWith("PROTECTION_") || item.code === "FORGED_PROTECTION_TOKEN";
      const rule = byCode.get(item.code) ?? byCode.get(protectionFailure ? "PROTECTED_VALUE_MISMATCH" : item.code);
      if (rule) output.push(normalizedFinding(rule, segments.find((segment) => segment.segmentId === item.segmentId),
        revisions.get(item.segmentId) ?? [...revisions.values()][0], evidenceDigest, { validatorCode: item.code, ...item.details }));
    }
    for (const segment of segments) {
      const text = texts.get(segment.segmentId);
      const revision = revisions.get(segment.segmentId);
      for (const rule of snapshot.rules.filter((candidate) => !candidate.validatorCode)) {
        if (rule.kind === "term-consistency") continue;
        if (rule.kind.startsWith("term-") && !rule.sourceTerms.some((term) => contains(segment.sourceText, term))) continue;
        if (rule.kind === "term-preferred" && !rule.values.some((value) => contains(text, value))) {
          output.push(normalizedFinding(rule, segment, revision, evidenceDigest, { expectedAny: rule.values }));
        } else if (rule.kind === "term-forbidden") {
          const matched = rule.values.filter((value) => contains(text, value));
          if (matched.length > 0) output.push(normalizedFinding(rule, segment, revision, evidenceDigest, { matched }));
        } else if (rule.kind === "style-required") {
          const missing = rule.values.filter((value) => !contains(text, value));
          if (missing.length > 0) output.push(normalizedFinding(rule, segment, revision, evidenceDigest, { missing }));
        } else if (rule.kind === "style-forbidden") {
          const matched = rule.values.filter((value) => contains(text, value));
          if (matched.length > 0) output.push(normalizedFinding(rule, segment, revision, evidenceDigest, { matched }));
        }
      }
    }
    for (const rule of snapshot.rules.filter((candidate) => candidate.kind === "term-consistency")) {
      const occurrences = segments.filter((segment) => rule.sourceTerms.some((term) => contains(segment.sourceText, term)))
        .map((segment) => ({ segmentId: segment.segmentId, matched: rule.values.filter((value) => contains(texts.get(segment.segmentId), value)) }))
        .filter((item) => item.matched.length > 0);
      const chosen = new Set(occurrences.flatMap((item) => item.matched));
      if (chosen.size > 1) output.push(normalizedFinding(rule, null, [...revisions.values()][0], evidenceDigest, { occurrences }));
    }
    return output.sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity]
      || left.ruleId.localeCompare(right.ruleId) || String(left.segmentId).localeCompare(String(right.segmentId))
      || stableJson(left.parameters).localeCompare(stableJson(right.parameters)));
  }

  #storeRun({ workflow, segmentId, subjectType, subjectId, subjectDigest, snapshot, evidenceDigest,
    validationRunId, findings, workingSegments = [] }) {
    const normalized = findings.map((finding, ordinal) => ({ ...finding, ordinal,
      findingId: sha(stableJson({ subjectType, subjectId, ordinal, ...finding })) }));
    const summary = normalized.map(({ findingId, ...finding }) => finding);
    const summaryDigest = sha(stableJson(summary));
    const identity = { workflowId: workflow.workflowId, segmentId, subjectType, subjectId, subjectDigest,
      ruleSnapshotId: snapshot.ruleSnapshotId, validationRunId, evidenceDigest, summaryDigest };
    const qualityRunId = sha(stableJson(identity));
    this.database.transaction(() => {
      this.database.prepare("INSERT OR IGNORE INTO quality_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, qualityRunId, workflow.workflowId, workflow.documentId, workflow.sourceRevisionId,
          workflow.targetLanguage, segmentId, subjectType, subjectId, subjectDigest, snapshot.ruleSnapshotId,
          validationRunId, evidenceDigest, summaryDigest, this.now().toISOString());
      if (subjectType === "candidate") this.database.prepare("INSERT OR IGNORE INTO quality_run_candidates VALUES (?, ?, ?, ?, ?)")
        .run(this.workspaceId, qualityRunId, workflow.workflowId, segmentId, subjectId);
      else for (const segment of workingSegments) this.database.prepare("INSERT OR IGNORE INTO quality_run_working_revisions VALUES (?, ?, ?, ?, ?)")
        .run(this.workspaceId, qualityRunId, workflow.workflowId, segment.segmentId, segment.headRevisionId);
      for (const finding of normalized) this.database.prepare("INSERT OR IGNORE INTO quality_findings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, qualityRunId, finding.findingId, finding.ordinal, finding.severity, finding.ruleId,
          finding.ruleVersion, finding.segmentId, finding.subjectRevisionId, finding.factId, finding.factRevisionId,
          finding.evidenceDigest, stableJson(finding.parameters));
    })();
    return this.get(qualityRunId);
  }

  #workflow(workflowId) {
    const row = this.database.prepare(`SELECT workflow_id AS workflowId, document_id AS documentId,
      source_revision_id AS sourceRevisionId, target_language AS targetLanguage, state, version
      FROM translation_workflows WHERE workspace_id = ? AND workflow_id = ?`).get(this.workspaceId, workflowId);
    if (!row) throw new QualityConflictError("workflow not found");
    return row;
  }

  #currentValidation(workflowId, workingCopyDigest) {
    const rows = this.database.prepare(`SELECT validation_run_id AS validationRunId FROM validation_runs
      WHERE workspace_id = ? AND workflow_id = ? AND working_copy_digest = ?
      ORDER BY created_at, validation_run_id`).all(this.workspaceId, workflowId, workingCopyDigest);
    for (const row of rows) {
      const run = this.validation.get(row.validationRunId);
      if (run.current) return run;
    }
    return null;
  }

  #segment(workflow, segmentId) {
    const row = this.database.prepare(`SELECT segment_id AS segmentId, kind, structural_path AS structuralPath,
      source_text AS sourceText, protected_json AS protectedJson FROM source_segment_versions
      WHERE workspace_id = ? AND source_revision_id = ? AND segment_id = ?`).get(this.workspaceId, workflow.sourceRevisionId, segmentId);
    if (!row) throw new QualityConflictError("segment not found");
    return { ...row, protected: JSON.parse(row.protectedJson) };
  }

  #evidenceDigest(workflow, segmentId, evidenceIds) {
    if (!Array.isArray(evidenceIds) || evidenceIds.length > 20 || new Set(evidenceIds).size !== evidenceIds.length) throw new TypeError("evidenceIds must be bounded and unique");
    const rows = [];
    for (const evidenceId of [...evidenceIds].sort()) {
      const row = this.database.prepare(`SELECT evidence_id AS evidenceId, evidence_digest AS evidenceDigest,
        workflow_id AS workflowId, segment_id AS segmentId FROM knowledge_evidence_snapshots
        WHERE workspace_id = ? AND evidence_id = ?`).get(this.workspaceId, evidenceId);
      if (!row || row.workflowId !== workflow.workflowId || (segmentId && row.segmentId !== segmentId)) throw new QualityConflictError("evidence scope mismatch");
      rows.push({ evidenceId: row.evidenceId, evidenceDigest: row.evidenceDigest });
    }
    return sha(stableJson(rows));
  }
}
