import { randomUUID } from "node:crypto";
import { KnowledgeFactService } from "../../src/knowledge/fact-service.mjs";
import { FtsRetriever } from "../../src/knowledge/fts-retriever.mjs";
import { EvidenceService } from "../../src/knowledge/evidence-service.mjs";
import { buildContextManifest } from "../../src/provider/prompt-context.mjs";
import { enqueueInput, orchestrator, seedWorkflow } from "../m4-3/helpers.mjs";
import { knowledgeInput, termInput, workspace as baseWorkspace } from "../m5-1/helpers.mjs";

export const actor = Object.freeze({ type: "fixture", id: "m5-3" });

export async function evidenceWorkspace({ policyVersion } = {}) {
  const fixture = await baseWorkspace();
  fixture.clock = { now: () => new Date(0), advance() {} };
  const workflow = seedWorkflow(fixture, { targetLanguage: "zh-CN", sourceText: "Use workspace backup safely." });
  const facts = new KnowledgeFactService(fixture.root, fixture.database, fixture.workspaceId, { now: fixture.clock.now });
  const term = termInput({
    language: "zh-CN", scope: { targetLanguages: ["zh-CN"], tags: [], documentIds: [workflow.documentId] },
    content: { term: "workspace", preferredTranslations: [{ language: "zh-CN", text: "工作区" }], forbiddenTranslations: [], variants: [], note: "Use the fixed product term." },
  });
  const knowledge = knowledgeInput({
    language: "zh-CN", scope: { targetLanguages: ["zh-CN"], tags: [], documentIds: [workflow.documentId] },
    content: { title: "workspace backup", body: "A complete workspace backup is atomic and scoped.", tags: ["backup"], source: "public-fixture" },
  });
  await facts.create(term, actor);
  await facts.create(knowledge, actor);
  const retriever = new FtsRetriever(fixture.root, fixture.database, fixture.workspaceId, { now: fixture.clock.now });
  await retriever.rebuild();
  const evidence = new EvidenceService(fixture.database, fixture.workspaceId, retriever, {
    now: fixture.clock.now, ...(policyVersion ? { policyVersion } : {}),
  });
  return { fixture, workflow, facts, retriever, evidence, term, knowledge };
}

export function capture(setup, overrides = {}) {
  return setup.evidence.capture({
    workflowId: setup.workflow.workflowId, segmentId: setup.workflow.segmentId,
    query: "workspace", kinds: ["term", "knowledge"], tags: [], topK: 5,
    ...overrides,
  });
}

export function enqueueEvidence(setup, snapshot = capture(setup), suffix = randomUUID()) {
  const context = buildContextManifest(setup.fixture.database, setup.fixture.workspaceId, {
    workflowId: setup.workflow.workflowId, segmentIds: [setup.workflow.segmentId],
    evidenceIds: [snapshot.evidenceId],
  });
  const task = orchestrator(setup.fixture).enqueue(enqueueInput(setup.workflow, suffix, {
    promptVersion: context.manifest.promptVersion, contextDigest: context.contextDigest,
  }));
  const attemptId = task.attempts[0].attempt_id;
  setup.evidence.bindAttempt(attemptId, [snapshot.evidenceId]);
  return { context, task, attemptId, snapshot };
}
