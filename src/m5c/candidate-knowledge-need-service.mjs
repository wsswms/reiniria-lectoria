import { randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { candidateKnowledgeNeedContract } from "../provider/contracts.mjs";
import { contentDigest } from "./contracts.mjs";
import { FlowPlanService } from "./flow-plan-service.mjs";
import { M5CResearchBridgeService } from "./research-bridge-service.mjs";

export class CandidateKnowledgeNeedConflictError extends Error {
  constructor(message = "candidate knowledge need conflict") { super(message); this.name = "CandidateKnowledgeNeedConflictError"; this.code = "CANDIDATE_KNOWLEDGE_NEED_CONFLICT"; }
}

function actor(input, type) {
  if (!input || input.type !== type || typeof input.id !== "string" || input.id.length === 0) throw new CandidateKnowledgeNeedConflictError("actor is not authorized");
  return input;
}

export class CandidateKnowledgeNeedService {
  constructor(database, trustedWorkspaceId, { id = () => randomUUID(), now = () => new Date(), plans = null, research = null } = {}) {
    this.database = database; this.workspaceId = trustedWorkspaceId; this.id = id; this.now = now;
    this.plans = plans ?? new FlowPlanService(database, trustedWorkspaceId, { id, now });
    this.research = research ?? new M5CResearchBridgeService(database, trustedWorkspaceId, { id, now });
  }

  captureTranslation(attemptId, needs) {
    const scope = this.database.prepare(`SELECT attempt.workflow_id AS workflowId, attempt.source_revision_id AS sourceRevisionId,
      attempt.segment_id AS segmentId, binding.plan_revision_id AS planRevisionId, binding.context_revision_id AS contextRevisionId,
      revision.context_digest AS contextDigest FROM translation_attempts attempt JOIN m5c_translation_attempt_bindings binding
      ON binding.workspace_id = attempt.workspace_id AND binding.attempt_id = attempt.attempt_id JOIN temporary_context_revisions revision
      ON revision.workspace_id = binding.workspace_id AND revision.context_revision_id = binding.context_revision_id
      WHERE attempt.workspace_id = ? AND attempt.attempt_id = ?`).get(this.workspaceId, attemptId);
    if (!scope) throw new CandidateKnowledgeNeedConflictError("bound translation attempt is required");
    const allowed = new Set([scope.segmentId]);
    if (!Array.isArray(needs) || needs.length > 8) throw new TypeError("translation knowledge needs must be bounded");
    return Object.freeze(needs.map((need) => this.#insert({ ...scope, attemptId, originType: "translation-attempt", originId: attemptId },
      candidateKnowledgeNeedContract(need, allowed))));
  }

  capturePlan(workflowId) {
    const current = this.plans.get(workflowId);
    if (current.planHead.state !== "approved") throw new CandidateKnowledgeNeedConflictError("approved current Plan is required");
    const context = this.database.prepare(`SELECT revision.context_revision_id AS contextRevisionId, revision.context_digest AS contextDigest
      FROM temporary_context_heads head JOIN temporary_context_revisions revision ON revision.workspace_id = head.workspace_id
      AND revision.context_revision_id = head.context_revision_id WHERE head.workspace_id = ? AND head.workflow_id = ? AND head.state = 'approved'`)
      .get(this.workspaceId, workflowId) ?? { contextRevisionId: null, contextDigest: contentDigest({ planRevisionId: current.plan.planRevisionId }) };
    const items = current.plan.items.filter((item) => ["critical", "high"].includes(item.impact)
      && ["partially-covered", "conflicted", "stale", "uncovered"].includes(item.coverage) && item.segmentIds.length > 0);
    const grouped = new Map(); const impactRank = { critical: 2, high: 1 };
    for (const item of items) {
      const kind = item.kind === "style" ? "fact" : item.kind; const key = `${kind}:${stableJson(item.content)}`;
      const prior = grouped.get(key); const relatedSegmentIds = [...new Set([...(prior?.relatedSegmentIds ?? []), ...item.segmentIds])];
      grouped.set(key, { item, kind, impact: !prior || impactRank[item.impact] > impactRank[prior.impact] ? item.impact : prior.impact,
        relatedSegmentIds });
    }
    return Object.freeze([...grouped.values()].flatMap(({ item, kind, impact, relatedSegmentIds }) => {
      const output = [];
      for (let offset = 0; offset < relatedSegmentIds.length; offset += 16) {
        const boundedSegments = relatedSegmentIds.slice(offset, offset + 16);
        output.push(this.#insert({ workflowId, sourceRevisionId: current.workflow.sourceRevisionId, segmentId: boundedSegments[0], attemptId: null,
          planRevisionId: current.plan.planRevisionId, ...context, originType: "plan-item", originId: item.itemId }, { kind, impact,
          question: `What evidence resolves this translation ${item.kind} uncertainty: ${stableJson(item.content)}`.slice(0, 512),
          relatedSegmentIds: boundedSegments }));
      }
      return output;
    }));
  }

  assertCurrentPlanDispositionComplete(workflowId) {
    const current = this.plans.get(workflowId);
    const pending = this.database.prepare(`SELECT count(*) AS count FROM candidate_knowledge_needs need
      LEFT JOIN candidate_knowledge_need_decisions decision ON decision.workspace_id = need.workspace_id AND decision.need_id = need.need_id
      WHERE need.workspace_id = ? AND need.workflow_id = ? AND need.plan_revision_id = ? AND decision.need_id IS NULL`)
      .get(this.workspaceId, workflowId, current.plan.planRevisionId).count;
    if (pending > 0) throw new CandidateKnowledgeNeedConflictError("current Plan knowledge needs require user disposition");
    return Object.freeze({ workflowId, planRevisionId: current.plan.planRevisionId, pending: 0 });
  }

  decide(needId, decision, details, actorInput) {
    const by = actor(actorInput, "user"); if (!["research", "guidance", "proceed-with-risk"].includes(decision)
      || !details || typeof details !== "object" || Array.isArray(details)) throw new TypeError("knowledge need decision is invalid");
    this.get(needId); const timestamp = this.now().toISOString();
    try { this.database.prepare("INSERT INTO candidate_knowledge_need_decisions VALUES (?, ?, ?, ?, ?, 'user', ?, ?)")
      .run(this.workspaceId, this.id(), needId, decision, stableJson(details), by.id, timestamp); }
    catch { throw new CandidateKnowledgeNeedConflictError("knowledge need is already decided"); }
    return this.get(needId);
  }

  promoteResearchNeed(needId, actorInput = { type: "system", id: "knowledge-need-plan-promoter" }) {
    const by = actor(actorInput, "system"); const currentNeed = this.get(needId);
    if (currentNeed.decision?.decision !== "research") throw new CandidateKnowledgeNeedConflictError("user research decision is required");
    const prior = this.database.prepare("SELECT plan_revision_id AS planRevisionId, plan_item_id AS planItemId FROM candidate_knowledge_need_plan_bindings WHERE workspace_id = ? AND need_id = ?")
      .get(this.workspaceId, needId); if (prior) return Object.freeze({ ...currentNeed, planBinding: Object.freeze(prior) });
    const plan = this.plans.get(currentNeed.workflowId); const planItemId = this.id();
    const revised = this.plans.reviseApprovedForKnowledgeNeed(currentNeed.workflowId, plan.planHead.version, { itemId: planItemId,
      kind: currentNeed.kind, coverage: "uncovered", instructionType: "warning-only", impact: currentNeed.impact,
      segmentIds: currentNeed.relatedSegmentIds, dependencies: { candidateKnowledgeNeedId: needId },
      content: { question: currentNeed.question, origin: "translation-knowledge-need" } }, by);
    this.database.prepare("INSERT INTO candidate_knowledge_need_plan_bindings VALUES (?, ?, ?, ?, ?)")
      .run(this.workspaceId, needId, revised.plan.planRevisionId, planItemId, this.now().toISOString());
    return Object.freeze({ ...this.get(needId), planBinding: Object.freeze({ planRevisionId: revised.plan.planRevisionId, planItemId }) });
  }

  createResearchRequest(needId, actorInput = { type: "system", id: "knowledge-need-research-bridge" }) {
    const by = actor(actorInput, "system"); const need = this.get(needId);
    if (need.decision?.decision !== "research" || !need.planBinding) throw new CandidateKnowledgeNeedConflictError("promoted user research decision is required");
    const current = this.plans.get(need.workflowId);
    if (current.planHead.state !== "approved" || current.plan.planRevisionId !== need.planBinding.planRevisionId)
      throw new CandidateKnowledgeNeedConflictError("revised knowledge need Plan must be approved");
    const prior = this.database.prepare("SELECT request_id AS requestId FROM candidate_knowledge_need_research_bindings WHERE workspace_id = ? AND need_id = ?")
      .get(this.workspaceId, needId); if (prior) return this.research.get(prior.requestId);
    const request = this.research.propose(need.workflowId, { originType: "plan-item", originId: need.planBinding.planItemId,
      questions: [need.question], gapKinds: [need.kind] }, by);
    this.database.prepare("INSERT INTO candidate_knowledge_need_research_bindings VALUES (?, ?, ?, ?)")
      .run(this.workspaceId, needId, request.binding.requestId, this.now().toISOString());
    return request;
  }

  list(workflowId) {
    return Object.freeze(this.database.prepare("SELECT need_id AS needId FROM candidate_knowledge_needs WHERE workspace_id = ? AND workflow_id = ? ORDER BY created_at, need_id")
      .all(this.workspaceId, workflowId).map(({ needId }) => this.get(needId)));
  }

  get(needId) {
    const row = this.database.prepare(`SELECT need_id AS needId, workflow_id AS workflowId, source_revision_id AS sourceRevisionId,
      segment_id AS segmentId, attempt_id AS attemptId, plan_revision_id AS planRevisionId, context_revision_id AS contextRevisionId,
      context_digest AS contextDigest, origin_type AS originType, origin_id AS originId, kind, impact, question,
      question_digest AS questionDigest, related_segment_ids_json AS relatedSegmentIdsJson, created_at AS createdAt
      FROM candidate_knowledge_needs WHERE workspace_id = ? AND need_id = ?`).get(this.workspaceId, needId);
    if (!row) throw new CandidateKnowledgeNeedConflictError("candidate knowledge need not found");
    const decision = this.database.prepare("SELECT decision_id AS decisionId, decision, details_json AS detailsJson, actor_id AS actorId, decided_at AS decidedAt FROM candidate_knowledge_need_decisions WHERE workspace_id = ? AND need_id = ?")
      .get(this.workspaceId, needId); const planBinding = this.database.prepare("SELECT plan_revision_id AS planRevisionId, plan_item_id AS planItemId FROM candidate_knowledge_need_plan_bindings WHERE workspace_id = ? AND need_id = ?")
      .get(this.workspaceId, needId) ?? null; const research = this.database.prepare("SELECT request_id AS requestId FROM candidate_knowledge_need_research_bindings WHERE workspace_id = ? AND need_id = ?")
      .get(this.workspaceId, needId) ?? null;
    return Object.freeze({ ...row, relatedSegmentIds: Object.freeze(JSON.parse(row.relatedSegmentIdsJson)),
      decision: decision ? Object.freeze({ ...decision, details: Object.freeze(JSON.parse(decision.detailsJson)) }) : null,
      planBinding: planBinding && Object.freeze(planBinding), research: research && Object.freeze(research) });
  }

  #insert(scope, need) {
    const questionDigest = contentDigest({ kind: need.kind, question: need.question.trim().toLowerCase(), relatedSegmentIds: [...need.relatedSegmentIds].sort() });
    const prior = this.database.prepare("SELECT need_id AS needId FROM candidate_knowledge_needs WHERE workspace_id = ? AND workflow_id = ? AND plan_revision_id = ? AND context_digest = ? AND question_digest = ?")
      .get(this.workspaceId, scope.workflowId, scope.planRevisionId, scope.contextDigest, questionDigest);
    if (prior) return this.get(prior.needId); const needId = this.id();
    this.database.prepare("INSERT INTO candidate_knowledge_needs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.workspaceId, needId, scope.workflowId, scope.sourceRevisionId, scope.segmentId, scope.attemptId, scope.planRevisionId,
        scope.contextRevisionId, scope.contextDigest, scope.originType, scope.originId, need.kind, need.impact, need.question,
        questionDigest, stableJson(need.relatedSegmentIds), this.now().toISOString());
    return this.get(needId);
  }
}
