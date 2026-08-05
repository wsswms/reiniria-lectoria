import { stableJson } from "../domain/contracts.mjs";

export class PlanDependencyConflictError extends Error {
  constructor(message = "context plan dependency conflict") { super(message); this.name = "PlanDependencyConflictError"; this.code = "PLAN_DEPENDENCY_CONFLICT"; }
}

export class PlanDependencyService {
  constructor(database, trustedWorkspaceId, { now = () => new Date() } = {}) { this.database = database; this.workspaceId = trustedWorkspaceId; this.now = now; }

  evaluate(workflowId) {
    const head = this.database.prepare("SELECT plan_revision_id AS planRevisionId, state, version FROM translation_context_plan_heads WHERE workspace_id = ? AND workflow_id = ?")
      .get(this.workspaceId, workflowId);
    if (!head) throw new PlanDependencyConflictError("context plan not found");
    const items = this.database.prepare("SELECT item_id AS itemId, dependency_json AS dependencyJson FROM translation_context_plan_items WHERE workspace_id = ? AND plan_revision_id = ? ORDER BY item_id")
      .all(this.workspaceId, head.planRevisionId);
    const staleItemIds = []; const reasons = [];
    for (const row of items) {
      const dependencies = JSON.parse(row.dependencyJson);
      for (const source of dependencies.sourceSegments ?? []) {
        const current = this.database.prepare("SELECT source_digest AS digest FROM source_segment_versions WHERE workspace_id = ? AND segment_id = ? ORDER BY rowid DESC LIMIT 1")
          .get(this.workspaceId, source.segmentId);
        if (!current || current.digest !== source.digest) { staleItemIds.push(row.itemId); reasons.push({ itemId: row.itemId, type: "source-segment", id: source.segmentId }); break; }
      }
      if (staleItemIds.at(-1) === row.itemId) continue;
      for (const fact of dependencies.knowledge ?? []) {
        const current = this.database.prepare("SELECT revision_id AS revisionId FROM knowledge_fact_heads WHERE workspace_id = ? AND fact_id = ? AND state = 'active'")
          .get(this.workspaceId, fact.factId);
        if (!current || current.revisionId !== fact.revisionId) { staleItemIds.push(row.itemId); reasons.push({ itemId: row.itemId, type: "knowledge-fact", id: fact.factId }); break; }
      }
    }
    return Object.freeze({ workflowId, planRevisionId: head.planRevisionId, current: staleItemIds.length === 0,
      staleItemIds: Object.freeze([...new Set(staleItemIds)]), reasons: Object.freeze(reasons.map(Object.freeze)), digest: stableJson(reasons) });
  }

  markStale(workflowId, expectedVersion) {
    const evaluation = this.evaluate(workflowId); if (evaluation.current) return Object.freeze({ ...evaluation, changed: false });
    const changed = this.database.prepare("UPDATE translation_context_plan_heads SET state = 'stale', version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND version = ? AND state NOT IN ('canceled','rejected')")
      .run(this.now().toISOString(), this.workspaceId, workflowId, expectedVersion).changes;
    if (changed !== 1) throw new PlanDependencyConflictError("plan stale version conflict");
    this.database.prepare("UPDATE translation_flow_controls SET flow_state = 'planning', version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ? AND flow_state NOT IN ('closed','canceled','failed')")
      .run(this.now().toISOString(), this.workspaceId, workflowId);
    return Object.freeze({ ...evaluation, changed: true });
  }
}
