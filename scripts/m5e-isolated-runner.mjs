import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableJson } from "../src/domain/contracts.mjs";
import { openWorkspaceDatabase } from "../src/db/connection.mjs";
import { DocumentImportService } from "../src/document/import-service.mjs";
import { WorkCopyService } from "../src/translation/work-copy-service.mjs";
import { FlowPlanService } from "../src/m5c/flow-plan-service.mjs";
import { LocalContextPlanner } from "../src/m5c/local-context-planner.mjs";
import { M5CPlannerExecutor } from "../src/m5c/planner-executor.mjs";
import { CandidateKnowledgeNeedService } from "../src/m5c/candidate-knowledge-need-service.mjs";
import { TemporaryContextService } from "../src/m5c/temporary-context-service.mjs";
import { M5CModelQAExecutor } from "../src/m5c/model-qa-executor.mjs";
import { KnowledgeFactService } from "../src/knowledge/fact-service.mjs";
import { FtsRetriever, activeFactSetDigest } from "../src/knowledge/fts-retriever.mjs";
import { M5EExperimentCoordinator, createM5EExperimentPlan } from "../src/m5e/experiment-coordinator.mjs";
import { buildKnowledgeNeedFunnel, candidateSetDigest } from "../src/m5e/knowledge-need-cluster.mjs";
import { observePlanKnowledgeNeeds } from "../src/m5e/observation-adapter.mjs";
import { probeAppliedKnowledgeReuse } from "../src/m5e/persistence-reuse-probe.mjs";

const USER = Object.freeze({ type: "user", id: "m5e-dry-run-owner" });
const SYSTEM = Object.freeze({ type: "system", id: "m5e-dry-run-control" });
const sha = (value) => `sha256:${createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex")}`;
const usage = (calls = 1) => ({ calls, inputTokens: 100 * calls, outputTokens: 50 * calls,
  costMicrosCny: 0, costMicrosUsd: 0, durationMs: 10 * calls });
const SOURCES = Object.freeze({ part1: "Nikon 3枚 lens is not 2群.", part2: "Nikon 400mm lens is not 3群." });
const PLANNER_CONFIG_DIGEST = sha({ provider: "fake-deepseek", model: "planner-fixture-v1", thinking: "disabled", maxOutputTokens: 65_536,
  malformedRetries: 1, referenceFamiliesInPrompt: false });

function audit(events, event, details = {}) { events.push(Object.freeze({ sequence: events.length + 1, event, ...details })); }

async function workspace(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  for (const directory of ["private/objects", "private/ledger", "derived", "staging", "dictionary", "style", "knowledge"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  const workspaceId = randomUUID(); const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId, now: () => new Date(0) });
  const workCopies = new WorkCopyService(database, workspaceId, { now: () => new Date(0) });
  return Object.freeze({ root, workspaceId, database, workCopies,
    imports: new DocumentImportService({ database, root, trustedWorkspaceId: workspaceId, now: () => new Date(0) }),
    close: async () => { database.close(); await rm(root, { recursive: true, force: true }); } });
}

async function fakeResearch(events, armId) {
  audit(events, "fake-search-completed", { armId, network: false });
  audit(events, "fake-fetch-unknown-outcome", { armId, network: false });
  audit(events, "fake-fetch-recovery-paused", { armId, automaticRetry: false });
  audit(events, "fake-fetch-recovery-authorized", { armId, actorType: "user" });
  audit(events, "fake-fetch-completed", { armId, network: false });
  return Object.freeze({ simulatedSearchCalls: 1, simulatedFetchAttempts: 2, recoveryPauses: 1 });
}

async function executeArm({ armId, article, fixture = null, retriever = null, knowledgeSnapshotDigest, retrievalBindings = [] }) {
  const ownedFixture = fixture === null; const activeFixture = fixture ?? await workspace(`lectoria-m5e-${armId.toLowerCase()}-`); const events = [];
  try {
    const imported = await activeFixture.imports.import({ format: "text", content: SOURCES[article], title: `M5E ${article}` });
    activeFixture.imports.confirm(imported.importId, USER); const workflowId = randomUUID();
    const plans = new FlowPlanService(activeFixture.database, activeFixture.workspaceId, {
      planner: new LocalContextPlanner(activeFixture.database, activeFixture.workspaceId, { retriever }),
    });
    plans.create({ workflowId, documentId: imported.documentId, sourceRevisionId: imported.sourceRevisionId,
      targetLanguage: "zh-CN" }, USER);
    const planner = new M5CPlannerExecutor(activeFixture.database, activeFixture.workspaceId, { plans, invokePlanner: async (request) => {
      audit(events, "planner-attempt", { armId, attempt: 1, outcome: "malformed", network: false });
      audit(events, "planner-safe-malformed-retry", { armId, retry: 1 });
      audit(events, "planner-attempt", { armId, attempt: 2, outcome: "completed", network: false });
      return { items: request.localItems, researchScope: { suggestedItemIndexes: [], approvedItemIds: [] },
        qaProfile: { invariant: true, heuristic: true, model: true, finalRevisionRequired: true },
        responseId: `fake-planner-${armId}`, usage: usage(2) };
    } });
    const planned = await planner.execute(workflowId, { providerId: "fake-deepseek", modelId: "planner-fixture-v1",
      idempotencyKey: `${armId}:planner`, estimatedUsage: usage(2) });
    if (planned.status !== "model-assisted") throw new Error("offline Planner dry-run failed");
    let current = plans.submitPlan(workflowId, planned.plan.planHead.version, SYSTEM);
    current = plans.decidePlan(workflowId, current.planHead.version, "approved", USER);
    const needs = new CandidateKnowledgeNeedService(activeFixture.database, activeFixture.workspaceId, { plans });
    for (const need of needs.capturePlan(workflowId)) needs.decide(need.needId, "proceed-with-risk", { dryRun: true }, USER);
    const contexts = new TemporaryContextService(activeFixture.database, activeFixture.workspaceId);
    let context = contexts.assemble(workflowId, {}, SYSTEM); context = contexts.decide(workflowId, context.head.version, "approved", USER);
    const segmentRows = activeFixture.database.prepare(`SELECT segment_id AS segmentId, source_text AS sourceText FROM source_segment_versions
      WHERE workspace_id = ? AND source_revision_id = ? AND translatable = 1 ORDER BY ordinal`).all(activeFixture.workspaceId, imported.sourceRevisionId);
    for (const segment of segmentRows) {
      audit(events, "fake-translation-attempt", { armId, segmentId: segment.segmentId, network: false });
      const candidate = activeFixture.workCopies.addCandidate(workflowId, segment.segmentId, segment.sourceText, { type: "fixture", id: "fake-translation" });
      activeFixture.workCopies.selectCandidate(workflowId, segment.segmentId, candidate.candidateId, null, USER);
    }
    const qa = new M5CModelQAExecutor(activeFixture.database, activeFixture.workspaceId, { workCopies: activeFixture.workCopies,
      invokeModelQa: async () => { audit(events, "fake-qa-attempt", { armId, thinking: "enabled", network: false });
        return { findings: [], responseId: `fake-qa-${armId}`, usage: usage(1) }; } });
    const qaResult = await qa.execute(workflowId, { providerId: "fake-deepseek", modelId: "qa-fixture-v1", qaMode: "enabled",
      idempotencyKey: `${armId}:qa`, estimatedUsage: usage(1) });
    const research = ["E1", "E2"].includes(armId) ? await fakeResearch(events, armId) : Object.freeze({ simulatedSearchCalls: 0, simulatedFetchAttempts: 0, recoveryPauses: 0 });
    const observations = observePlanKnowledgeNeeds(planned.plan.plan); const funnel = buildKnowledgeNeedFunnel(observations);
    const result = Object.freeze({ armId, sourceDigest: sha(SOURCES[article]), candidateSetDigest: candidateSetDigest(funnel),
      plannerConfigDigest: PLANNER_CONFIG_DIGEST, referenceFamiliesInjected: false, funnelDigest: funnel.mappingDigest,
      auditDigest: sha(events), qualityArtifactDigest: sha(qaResult.run.findings.map(({ code, severity }) => ({ code, severity }))),
      providerAttempts: 2 + segmentRows.length + 1, braveCalls: 0, fetchUrls: [], knowledgeSnapshotDigest,
      retrievalBindings, events: Object.freeze(events), research, workflowId, funnelCounts: funnel.counts });
    return Object.freeze({ result, fixture: activeFixture, ownedFixture });
  } catch (error) {
    if (ownedFixture) await activeFixture.close(); throw error;
  }
}

async function executeDryRun() {
  const digestFixture = await workspace("lectoria-m5e-cold-digest-"); let warmFixture = null;
  try {
    const coldFactSetDigest = activeFactSetDigest(digestFixture.database, digestFixture.workspaceId);
    const plan = createM5EExperimentPlan({ part1SourceDigest: sha(SOURCES.part1), part2SourceDigest: sha(SOURCES.part2),
      plannerConfigDigest: PLANNER_CONFIG_DIGEST, referenceFamilySetDigest: sha("synthetic-reference-family-set"), coldFactSetDigest });
    const coordinator = new M5EExperimentCoordinator(plan, { now: () => new Date(0) }); const summaries = [];
    let executed = await executeArm({ armId: "C1", article: "part1", knowledgeSnapshotDigest: coldFactSetDigest });
    coordinator.completeArm(executed.result); summaries.push(executed.result); await executed.fixture.close();
    executed = await executeArm({ armId: "E1", article: "part1", knowledgeSnapshotDigest: coldFactSetDigest });
    coordinator.completeArm(executed.result); summaries.push(executed.result); warmFixture = executed.fixture;
    const checkpointPauseObserved = coordinator.next().action === "await-user-knowledge-approval";
    if (!checkpointPauseObserved) throw new Error("Part1 user checkpoint was not observed");
    const facts = new KnowledgeFactService(warmFixture.root, warmFixture.database, warmFixture.workspaceId, { now: () => new Date(0) });
    const source = { schemaVersion: "1.0", factId: randomUUID(), revisionId: randomUUID(), kind: "term", language: "zh-CN",
      scope: { targetLanguages: ["zh-CN"], tags: [], documentIds: [] }, content: {
      term: "Nikon", preferredTranslations: [{ language: "zh-CN", text: "尼康" }], forbiddenTranslations: [], variants: ["ニコン"], note: "M5E dry-run shared term",
    } };
    await facts.create(source, USER); const retriever = new FtsRetriever(warmFixture.root, warmFixture.database, warmFixture.workspaceId, { now: () => new Date(0) });
    const manifest = await retriever.rebuild(); const application = { clusterId: "shared-nikon", proposalId: "dry-proposal-1", factId: source.factId,
      revisionId: source.revisionId, contentDigest: facts.get(source.factId).revision.contentDigest, retrievalQuery: "Nikon", factKind: "term", applied: true };
    coordinator.recordPart1KnowledgeCheckpoint({ warmFactSetDigest: manifest.factSetDigest, applications: [application] }, USER);
    executed = await executeArm({ armId: "C2", article: "part2", knowledgeSnapshotDigest: coldFactSetDigest });
    coordinator.completeArm(executed.result); summaries.push(executed.result); await executed.fixture.close();
    const probe = probeAppliedKnowledgeReuse({ clusters: [{ clusterId: "shared-nikon" }], applications: [application], retriever,
      expectedFactSetDigest: manifest.factSetDigest, language: "zh-CN", targetLanguage: "zh-CN" });
    executed = await executeArm({ armId: "E2", article: "part2", fixture: warmFixture, retriever,
      knowledgeSnapshotDigest: manifest.factSetDigest, retrievalBindings: probe.bindings });
    coordinator.completeArm(executed.result); summaries.push(executed.result);
    const manifestResult = coordinator.manifest();
    const passed = manifestResult.next.action === "complete" && checkpointPauseObserved && probe.bindings.length === 1 && probe.misses.length === 0;
    return Object.freeze({ schemaVersion: "m5e-isolated-runner-dry-run-v1", status: passed ? "passed" : "failed",
      networkCalls: 0, checkpointPauseObserved, plannerRerunCount: summaries.length,
      plannerCandidateSetDigests: summaries.map((item) => ({ armId: item.armId, candidateSetDigest: item.candidateSetDigest })),
      fakeRecoveryPauses: summaries.reduce((sum, item) => sum + item.research.recoveryPauses, 0),
      exactPart2RetrievalBindings: probe.bindings.length, lineageMisses: probe.misses.length,
      providerAttempts: summaries.reduce((sum, item) => sum + item.providerAttempts, 0),
      simulatedSearchCalls: summaries.reduce((sum, item) => sum + item.research.simulatedSearchCalls, 0),
      simulatedFetchAttempts: summaries.reduce((sum, item) => sum + item.research.simulatedFetchAttempts, 0),
      manifestDigest: manifestResult.manifestDigest });
  } finally { await warmFixture?.close(); await digestFixture.close(); }
}

if (process.env.M5E_RUNNER_MODE !== "dry-run") throw new Error("M5E isolated runner requires M5E_RUNNER_MODE=dry-run");
const result = await executeDryRun(); process.stdout.write(`${JSON.stringify(result)}\n`);
