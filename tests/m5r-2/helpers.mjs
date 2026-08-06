import { createHash, randomUUID } from "node:crypto";
import { ResearchBudgetService } from "../../src/research/budget-service.mjs";
import { ResearchCapabilityService } from "../../src/research/capability.mjs";
import { ResearchEvidenceService } from "../../src/research/evidence-service.mjs";
import { FakeResearchContentAdapter, FakeResearchModelAdapter, FakeResearchSearchAdapter } from "../../src/research/fake-adapters.mjs";
import { ResearchFoundationService } from "../../src/research/foundation-service.mjs";
import { ResearchRunService } from "../../src/research/run-service.mjs";
import { ResearchToolGateway } from "../../src/research/tool-gateway.mjs";
import { capture, enqueueEvidence, evidenceWorkspace } from "../m5-3/helpers.mjs";

export const sha = (value) => `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
export const user = Object.freeze({ type: "user", id: "m5r-2-user" });
export const model = Object.freeze({ type: "model", id: "m5r-2-gap-detector" });
export const system = Object.freeze({ type: "system", id: "m5r-2-control-plane" });

export async function researchWorkspace({ limits = {}, providerBudgets = {}, adapterOverrides = {}, searchProviderId = "fake-search",
  modelProviderId = "fake-research-model", questions = ["What is the authoritative product term?"],
  allowedLanguages = ["en", "zh-CN"], startMilliseconds = 0 } = {}) {
  const setup = await evidenceWorkspace();
  const bound = enqueueEvidence(setup, capture(setup), randomUUID());
  let milliseconds = startMilliseconds;
  const now = () => new Date(milliseconds);
  const foundation = new ResearchFoundationService(setup.fixture.database, setup.fixture.workspaceId, { now });
  const request = { schemaVersion: "1.0", requestId: randomUUID(), revisionId: randomUUID(), taskId: bound.task.task.task_id,
    workflowId: setup.workflow.workflowId, documentId: setup.workflow.documentId, sourceRevisionId: setup.workflow.sourceRevisionId,
    targetLanguage: setup.workflow.targetLanguage, segmentIds: [setup.workflow.segmentId], gapKinds: ["term"],
    questions, localEvidenceDigest: sha("local-evidence"), origin: model, createdAt: now().toISOString() };
  foundation.createRequest(request, model);
  foundation.submitRequest(request.requestId, 0, model);
  foundation.decideRequest(request.requestId, 1, "approved", user);
  const grantInput = { schemaVersion: "1.0", grantId: randomUUID(), requestId: request.requestId, requestRevisionId: request.revisionId,
    providers: [
      { capability: "search", providerId: searchProviderId, fallbackOrder: 0,
        budget: { maxSearchCalls: 12, maxContentUrls: 0, maxModelTokens: 0, maxCostMicrosUsd: 0, ...providerBudgets[searchProviderId] } },
      { capability: "extract", providerId: "fake-content", fallbackOrder: 0,
        budget: { maxSearchCalls: 0, maxContentUrls: 16, maxModelTokens: 0, maxCostMicrosUsd: 0, ...providerBudgets["fake-content"] } },
      { capability: "research-model", providerId: modelProviderId, fallbackOrder: 0,
        budget: { maxSearchCalls: 0, maxContentUrls: 0, maxModelTokens: 100_000, maxCostMicrosUsd: 0, ...providerBudgets[modelProviderId] } },
    ], limits: { maxRounds: 5, maxSearchCalls: 12, maxResultsPerSearch: 10, maxContentUrls: 16, maxDurationSeconds: 1_800,
      maxRuns: 2, maxModelTokens: 100_000, maxCostMicrosUsd: 0, ...limits }, allowedDomains: ["official.example", "independent.example"],
    allowedLanguages, approvedBy: user, approvedAt: now().toISOString(), expiresAt: new Date(milliseconds + 1_800_000).toISOString() };
  const issued = foundation.issueGrant(request.requestId, grantInput, user);
  const runs = new ResearchRunService(setup.fixture.database, setup.fixture.workspaceId, { now });
  const run = runs.create(issued.grant.grantId, sha("research-run"), system);
  runs.transition(run.runId, "running", { actor: system });
  const search = adapterOverrides.search ?? new FakeResearchSearchAdapter([
    { url: "https://official.example/reference", title: "Official terminology", description: "Official product terminology." },
    { url: "https://independent.example/reference", title: "Independent terminology", description: "Independent terminology reference." },
  ]);
  const content = adapterOverrides.content ?? new FakeResearchContentAdapter([
    { url: "https://official.example/reference", content: "Official guidance states that Workspace is the product term." },
    { url: "https://independent.example/reference", content: "Independent reference confirms that Workspace is the product term." },
  ]);
  const researchModel = adapterOverrides.model ?? new FakeResearchModelAdapter();
  const budgets = new ResearchBudgetService(setup.fixture.database, setup.fixture.workspaceId, { now });
  const evidence = new ResearchEvidenceService(setup.fixture.database, setup.fixture.workspaceId, { now });
  const capabilities = new ResearchCapabilityService(setup.fixture.database, setup.fixture.workspaceId, { key: Buffer.alloc(32, 9), now });
  const adapters = new Map([[searchProviderId, search], ["fake-content", content], [modelProviderId, researchModel]]);
  const gateway = new ResearchToolGateway(setup.fixture.database, setup.fixture.workspaceId, { capabilities, budgets, evidence, adapters, now });
  return { setup, bound, now, advance(amount) { milliseconds += amount; }, foundation, request, grant: issued.grant, runs,
    run: runs.get(run.runId), search, content, researchModel, budgets, evidence, capabilities, gateway,
    capability: capabilities.issue(run.runId), async close() { await setup.fixture.close(); } };
}

export function runnerTask(fixture, phase, observations = []) {
  return { schemaVersion: "research-runner-task-v1", grantId: fixture.grant.grantId, runId: fixture.run.runId, round: 1, phase,
    questions: fixture.request.questions, allowedProviders: fixture.grant.providers.map(({ capability, providerId }) => ({ capability, providerId })),
    observations, capability: { token: fixture.capability }, limits: { inputBytes: 1_048_576, outputBytes: 1_048_576, toolCalls: 8, runtimeMs: 5_000 } };
}
