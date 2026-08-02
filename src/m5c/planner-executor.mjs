import { randomUUID } from "node:crypto";
import { budgetUsageContract, contentDigest } from "./contracts.mjs";
import { FlowPlanService } from "./flow-plan-service.mjs";
import { TranslationFlowBudgetService } from "./flow-budget-service.mjs";

export class M5CPlannerExecutor {
  constructor(database, trustedWorkspaceId, { invokePlanner, now = () => new Date(), id = () => randomUUID(), plans = null, budgets = null } = {}) {
    if (typeof invokePlanner !== "function") throw new TypeError("invokePlanner is required");
    this.database = database; this.workspaceId = trustedWorkspaceId; this.invokePlanner = invokePlanner;
    this.id = id;
    this.plans = plans ?? new FlowPlanService(database, trustedWorkspaceId, { now });
    this.budgets = budgets ?? new TranslationFlowBudgetService(database, trustedWorkspaceId, { now });
  }

  async execute(workflowId, { providerId, modelId, idempotencyKey, estimatedUsage }) {
    for (const [value, name] of [[providerId, "providerId"], [modelId, "modelId"], [idempotencyKey, "idempotencyKey"]])
      if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} is required`);
    const current = this.plans.get(workflowId);
    if (!current.flow.plannerEnabled) return Object.freeze({ status: "local-only", plan: current });
    if (current.planHead.state !== "draft") throw new TypeError("planner assistance requires the current draft Plan");
    const request = Object.freeze({ schemaVersion: "m5c-planner-request-v1", workflowId,
      documentId: current.workflow.documentId, sourceRevisionId: current.workflow.sourceRevisionId, targetLanguage: current.workflow.targetLanguage,
      localPlanDigest: contentDigest(current.plan), localItems: current.plan.items });
    const reservationId = `planner:${idempotencyKey}`;
    this.budgets.reserve(workflowId, "planner", reservationId, budgetUsageContract(estimatedUsage), { providerId, modelId, requestDigest: contentDigest(request) });
    let response;
    try { response = await this.invokePlanner(request, { providerId, modelId }); }
    catch (error) {
      if (error?.category === "unknown-outcome") this.budgets.unknown(workflowId, reservationId, { providerId, modelId });
      else this.budgets.release(workflowId, reservationId, { providerId, modelId, category: error?.category ?? "provider" });
      return Object.freeze({ status: "fallback-local", category: error?.category ?? "provider", plan: current });
    }
    if (!response || !Array.isArray(response.items) || !response.researchScope || !response.qaProfile || typeof response.responseId !== "string") {
      this.budgets.release(workflowId, reservationId, { providerId, modelId, category: "malformed-response" });
      return Object.freeze({ status: "fallback-local", category: "malformed-response", plan: current });
    }
    const items = response.items.map((item) => ({ ...item, itemId: this.id() }));
    const revised = this.plans.revisePlan(workflowId, current.planHead.version, { plannerMode: "model-assisted", items,
      researchScope: response.researchScope, qaProfile: response.qaProfile }, { type: "model", id: `${providerId}:${modelId}` });
    this.budgets.settle(workflowId, reservationId, budgetUsageContract(response.usage), { responseId: response.responseId, planRevisionId: revised.plan.planRevisionId });
    return Object.freeze({ status: "model-assisted", plan: revised });
  }
}
