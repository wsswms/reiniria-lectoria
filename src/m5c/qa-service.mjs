import { randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { WorkCopyService } from "../translation/work-copy-service.mjs";
import { contentDigest } from "./contracts.mjs";
import { TranslationFlowBudgetService } from "./flow-budget-service.mjs";

export const M5C_QA_RULES_VERSION = "m5c-qa-rules-v1";

export class M5CQAConflictError extends Error {
  constructor(message = "M5C QA conflict") { super(message); this.name = "M5CQAConflictError"; this.code = "M5C_QA_CONFLICT"; }
}

const LAYERS = new Set(["invariant", "heuristic", "model"]);
const SCOPES = new Set(["full", "diff", "deterministic-final"]);
const DIGITS = Object.freeze({ "0": ["0", "０", "零", "〇"], "1": ["1", "１", "一", "壹"], "2": ["2", "２", "二", "两", "兩", "弐"], "3": ["3", "３", "三", "叁", "参"], "4": ["4", "４", "四", "肆"], "5": ["5", "５", "五", "伍"], "6": ["6", "６", "六", "陆", "陸"], "7": ["7", "７", "七", "柒"], "8": ["8", "８", "八", "捌"], "9": ["9", "９", "九", "玖"], "10": ["10", "１０", "十", "拾"] });
const numberTokens = (text) => [...text.normalize("NFKC").matchAll(/\d+(?:[.,]\d+)?/gu)].map((match) => match[0]);
const hasEquivalent = (target, token) => target.normalize("NFKC").includes(token) || (DIGITS[token] ?? []).some((value) => target.includes(value));
const negation = (text) => /(?:\bnot\b|\bnever\b|\bwithout\b|ない|なく|ません|ではない|不是|并非|没有|不会|不能|无)/iu.test(text);
const causal = (text) => /(?:because|therefore|caus(?:e|es|ed)|prevent(?:s|ed)?|ため|ので|従って|原因|由于|因此|导致|防止)/iu.test(text);

function canonicalNumber(token) {
  const digit = token.normalize("NFKC").match(/\d+(?:[.,]\d+)?/u)?.[0]; if (digit) return digit;
  const value = token.match(/[零〇一二两兩三四五六七八九十]+/u)?.[0];
  if (!value) return null; const direct = { 零: "0", 〇: "0", 一: "1", 二: "2", 两: "2", 兩: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9", 十: "10" };
  return direct[value] ?? null;
}

function measurementCategory(token) {
  if (/枚|片/u.test(token)) return "flat-count";
  if (/組|组|群/u.test(token)) return "group-count";
  if (/個|个/u.test(token)) return "generic-count";
  if (/mm|cm|km|kg|mg|hz|mah|fps|%|°c|°f/iu.test(token)) return token.replace(/[\d\s.,]/gu, "").toLowerCase();
  return null;
}

function measurementTokens(text) { return [...text.matchAll(/(?:\d+(?:[.,]\d+)?|[零〇一二两兩三四五六七八九十]+)\s*(?:mm|cm|km|kg|mg|Hz|mAh|fps|%|°C|°F|枚|片|組|组|群|個|个)/giu)].map((match) => match[0]); }

export function detectM5CQAIssues(segments) {
  const findings = [];
  for (const segment of segments) {
    for (const token of numberTokens(segment.sourceText)) if (!hasEquivalent(segment.text, token)) findings.push({ layer: "invariant", severity: "error", code: "number-missing", segmentId: segment.segmentId, details: { token }, blocking: true });
    const sourceMeasurements = measurementTokens(segment.sourceText); const targetMeasurements = measurementTokens(segment.text);
    for (const token of sourceMeasurements) {
      const number = canonicalNumber(token); const sourceCategory = measurementCategory(token);
      const matching = targetMeasurements.filter((candidate) => canonicalNumber(candidate) === number);
      if (matching.length && !matching.some((candidate) => measurementCategory(candidate) === sourceCategory)) findings.push({ layer: "invariant", severity: "error", code: "measurement-category-changed", segmentId: segment.segmentId, details: { source: token, target: matching }, blocking: true });
    }
    if (negation(segment.sourceText) !== negation(segment.text)) findings.push({ layer: "heuristic", severity: "warning", code: "negation-mismatch", segmentId: segment.segmentId, details: {}, blocking: false });
    if (causal(segment.sourceText) !== causal(segment.text)) findings.push({ layer: "heuristic", severity: "warning", code: "causal-marker-mismatch", segmentId: segment.segmentId, details: {}, blocking: false });
  }
  return Object.freeze(findings.map((item) => Object.freeze({ ...item, details: Object.freeze(item.details) })));
}

function actor(input) {
  if (!input || input.type !== "user" || typeof input.id !== "string" || input.id.length === 0) throw new M5CQAConflictError("only a user can decide a QA finding"); return input;
}

export class M5CQAService {
  constructor(database, trustedWorkspaceId, { id = () => randomUUID(), now = () => new Date(), workCopies = null, budgets = null } = {}) {
    this.database = database; this.workspaceId = trustedWorkspaceId; this.id = id; this.now = now;
    this.workCopies = workCopies ?? new WorkCopyService(database, trustedWorkspaceId, { id, now });
    this.budgets = budgets ?? new TranslationFlowBudgetService(database, trustedWorkspaceId, { id, now });
  }

  run(workflowId, { layers = ["invariant", "heuristic"], scope = "full", segmentIds = null, modelFindings = [], model = {} } = {}) {
    if (!Array.isArray(layers) || layers.length === 0 || new Set(layers).size !== layers.length || layers.some((layer) => !LAYERS.has(layer))) throw new TypeError("QA layers are invalid");
    if (!SCOPES.has(scope)) throw new TypeError("QA scope is invalid");
    if (scope === "deterministic-final" && (layers.length !== 1 || layers[0] !== "invariant")) throw new TypeError("deterministic-final scope only permits invariant QA");
    const flow = this.database.prepare("SELECT qa_cycles AS qaCycles FROM translation_flow_controls WHERE workspace_id = ? AND workflow_id = ?")
      .get(this.workspaceId, workflowId); if (!flow) throw new M5CQAConflictError("M5C flow not found");
    const policy = this.budgets.get(workflowId).policy; if (flow.qaCycles >= policy.maxQaCycles) throw new M5CQAConflictError("QA cycle stop line reached");
    const workflow = this.database.prepare("SELECT source_revision_id AS sourceRevisionId FROM translation_workflows WHERE workspace_id = ? AND workflow_id = ?")
      .get(this.workspaceId, workflowId);
    const plan = this.database.prepare("SELECT plan_revision_id AS planRevisionId, state FROM translation_context_plan_heads WHERE workspace_id = ? AND workflow_id = ?")
      .get(this.workspaceId, workflowId); const context = this.database.prepare("SELECT context_revision_id AS contextRevisionId, state FROM temporary_context_heads WHERE workspace_id = ? AND workflow_id = ?")
      .get(this.workspaceId, workflowId);
    if (!plan || plan.state !== "approved" || !context || context.state !== "approved") throw new M5CQAConflictError("approved Plan and Context are required");
    const bundle = this.workCopies.getBundle(workflowId); if (bundle.segments.some((segment) => !segment.headRevisionId)) throw new M5CQAConflictError("target revision is incomplete");
    const included = segmentIds === null ? bundle.segments : bundle.segments.filter((segment) => segmentIds.includes(segment.segmentId));
    if (!included.length || (segmentIds && included.length !== new Set(segmentIds).size)) throw new M5CQAConflictError("QA segment scope mismatch");
    const targetRevisionId = this.#targetRevision(workflowId, bundle); const findings = [];
    if (layers.includes("invariant")) findings.push(...this.#invariants(included));
    if (layers.includes("heuristic")) findings.push(...this.#heuristics(included));
    if (layers.includes("model")) findings.push(...this.#modelFindings(included, modelFindings));
    const qaRunId = this.id(); const timestamp = this.now().toISOString();
    const core = { qaRunId, workflowId, sourceRevisionId: workflow.sourceRevisionId, targetRevisionId, planRevisionId: plan.planRevisionId,
      contextRevisionId: context.contextRevisionId, status: "completed", scope, layers, rulesVersion: M5C_QA_RULES_VERSION, model, findings };
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO m5c_qa_runs VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, qaRunId, workflowId, workflow.sourceRevisionId, targetRevisionId, plan.planRevisionId, context.contextRevisionId,
          scope, stableJson(layers), M5C_QA_RULES_VERSION, stableJson(model), contentDigest(core), timestamp);
      for (const finding of findings) this.database.prepare("INSERT INTO m5c_qa_findings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, finding.findingId, qaRunId, workflowId, finding.layer, finding.severity, finding.code, finding.segmentId,
          finding.blocking ? 1 : 0, stableJson(finding.details), contentDigest(finding));
      for (const segment of included) this.database.prepare("INSERT INTO m5c_qa_dependencies VALUES (?, ?, ?, 'segment-revision', ?, ?, ?)")
        .run(this.workspaceId, qaRunId, workflowId, segment.headRevisionId, segment.textDigest, segment.segmentId);
      const contextItems = this.database.prepare("SELECT context_item_id AS itemId, content_digest AS digest FROM temporary_context_items WHERE workspace_id = ? AND context_revision_id = ?")
        .all(this.workspaceId, context.contextRevisionId);
      for (const item of contextItems) this.database.prepare("INSERT INTO m5c_qa_dependencies VALUES (?, ?, ?, 'context-item', ?, ?, NULL)")
        .run(this.workspaceId, qaRunId, workflowId, item.itemId, item.digest);
      this.database.prepare("UPDATE translation_flow_controls SET flow_state = 'qa', qa_cycles = qa_cycles + 1, version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ?")
        .run(timestamp, this.workspaceId, workflowId);
    }).immediate();
    return this.get(qaRunId);
  }

  decideFinding(qaRunId, findingId, decision, actorInput) {
    const by = actor(actorInput); if (!new Set(["continue-research", "add-guidance", "accept-issue", "retranslate", "resolved"]).has(decision)) throw new TypeError("invalid QA decision");
    const run = this.get(qaRunId); const finding = run.findings.find((item) => item.findingId === findingId); if (!finding) throw new M5CQAConflictError("QA finding not found");
    if (!run.current) throw new M5CQAConflictError("stale QA finding cannot be decided");
    if (finding.layer === "invariant" && finding.severity === "error" && decision === "accept-issue") throw new M5CQAConflictError("blocking invariant cannot be accepted");
    try { this.database.prepare("INSERT INTO m5c_qa_finding_decisions VALUES (?, ?, ?, ?, ?, 'user', ?, ?)")
      .run(this.workspaceId, this.id(), qaRunId, findingId, decision, by.id, this.now().toISOString()); }
    catch { throw new M5CQAConflictError("QA finding already decided"); }
    return this.get(qaRunId);
  }

  assertEligible(workflowId, qaRunId) {
    const run = this.get(qaRunId); if (run.workflowId !== workflowId || !run.current || run.status !== "completed") throw new M5CQAConflictError("current completed final QA is required");
    if (!run.layers.includes("invariant")) throw new M5CQAConflictError("deterministic invariant QA is required");
    const decisions = new Map(run.decisions.map((item) => [item.findingId, item.decision]));
    for (const finding of run.findings) {
      const decision = decisions.get(finding.findingId);
      if (finding.layer === "invariant" && finding.severity === "error" && decision !== "resolved") throw new M5CQAConflictError("blocking invariant remains unresolved");
      if (finding.severity === "error" && !["resolved", "accept-issue"].includes(decision)) throw new M5CQAConflictError("QA error remains unresolved");
      if (finding.severity === "warning" && !["resolved", "accept-issue"].includes(decision)) throw new M5CQAConflictError("QA warning remains undecided");
    }
    return run;
  }

  get(qaRunId) {
    const row = this.database.prepare("SELECT qa_run_id AS qaRunId, workflow_id AS workflowId, source_revision_id AS sourceRevisionId, target_revision_id AS targetRevisionId, plan_revision_id AS planRevisionId, context_revision_id AS contextRevisionId, status, scope, layers_json AS layersJson, rules_version AS rulesVersion, model_json AS modelJson, run_digest AS runDigest, created_at AS createdAt FROM m5c_qa_runs WHERE workspace_id = ? AND qa_run_id = ?")
      .get(this.workspaceId, qaRunId); if (!row) throw new M5CQAConflictError("QA run not found");
    const findings = this.database.prepare("SELECT finding_id AS findingId, layer, severity, code, segment_id AS segmentId, blocking, details_json AS detailsJson FROM m5c_qa_findings WHERE workspace_id = ? AND qa_run_id = ? ORDER BY finding_id")
      .all(this.workspaceId, qaRunId).map((item) => Object.freeze({ ...item, blocking: item.blocking === 1, details: JSON.parse(item.detailsJson) }));
    const decisions = this.database.prepare("SELECT finding_id AS findingId, decision, actor_id AS actorId, decided_at AS decidedAt FROM m5c_qa_finding_decisions WHERE workspace_id = ? AND qa_run_id = ? ORDER BY decision_id")
      .all(this.workspaceId, qaRunId).map(Object.freeze);
    const stale = this.database.prepare("SELECT count(*) AS count FROM m5c_qa_stale_events WHERE workspace_id = ? AND qa_run_id = ?").get(this.workspaceId, qaRunId).count > 0;
    const bundle = this.workCopies.getBundle(row.workflowId); const target = this.database.prepare("SELECT working_copy_digest AS digest FROM target_revision_snapshots WHERE workspace_id = ? AND target_revision_id = ?")
      .get(this.workspaceId, row.targetRevisionId); const heads = this.database.prepare("SELECT plan_revision_id AS planRevisionId FROM translation_context_plan_heads WHERE workspace_id = ? AND workflow_id = ? AND state = 'approved'")
      .get(this.workspaceId, row.workflowId); const context = this.database.prepare("SELECT context_revision_id AS contextRevisionId FROM temporary_context_heads WHERE workspace_id = ? AND workflow_id = ? AND state = 'approved'")
      .get(this.workspaceId, row.workflowId);
    return Object.freeze({ ...row, layers: Object.freeze(JSON.parse(row.layersJson)), model: Object.freeze(JSON.parse(row.modelJson)),
      findings: Object.freeze(findings), decisions: Object.freeze(decisions), current: !stale && target?.digest === bundle.digest
        && heads?.planRevisionId === row.planRevisionId && context?.contextRevisionId === row.contextRevisionId });
  }

  #targetRevision(workflowId, bundle) {
    const existing = this.database.prepare("SELECT target_revision_id AS targetRevisionId FROM target_revision_snapshots WHERE workspace_id = ? AND workflow_id = ? AND working_copy_digest = ?")
      .get(this.workspaceId, workflowId, bundle.digest); if (existing) return existing.targetRevisionId;
    const parent = this.database.prepare("SELECT target_revision_id AS targetRevisionId FROM target_revision_snapshots WHERE workspace_id = ? AND workflow_id = ? ORDER BY created_at DESC, target_revision_id DESC LIMIT 1")
      .get(this.workspaceId, workflowId)?.targetRevisionId ?? null; const targetRevisionId = this.id(); const timestamp = this.now().toISOString();
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO target_revision_snapshots VALUES (?, ?, ?, ?, ?, ?)").run(this.workspaceId, targetRevisionId, workflowId, bundle.digest, parent, timestamp);
      for (const segment of bundle.segments) this.database.prepare("INSERT INTO target_revision_segments VALUES (?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, targetRevisionId, workflowId, segment.segmentId, segment.headRevisionId, segment.textDigest);
    })(); return targetRevisionId;
  }

  #finding(layer, severity, code, segmentId, details, blocking = false) { return Object.freeze({ findingId: this.id(), layer, severity, code, segmentId, details: Object.freeze(details), blocking }); }

  #invariants(segments) {
    return detectM5CQAIssues(segments).filter((item) => item.layer === "invariant")
      .map((item) => this.#finding(item.layer, item.severity, item.code, item.segmentId, item.details, item.blocking));
  }

  #heuristics(segments) {
    return detectM5CQAIssues(segments).filter((item) => item.layer === "heuristic")
      .map((item) => this.#finding(item.layer, item.severity, item.code, item.segmentId, item.details, item.blocking));
  }

  #modelFindings(segments, input) {
    if (!Array.isArray(input) || input.length > 256) throw new TypeError("modelFindings must be bounded"); const allowed = new Set(segments.map((segment) => segment.segmentId));
    return input.map((item) => {
      if (!item || !allowed.has(item.segmentId) || !["error", "warning", "info"].includes(item.severity) || typeof item.code !== "string" || !item.details || typeof item.details !== "object") throw new TypeError("model finding is invalid");
      return this.#finding("model", item.severity, item.code, item.segmentId, item.details, item.severity === "error");
    });
  }
}
