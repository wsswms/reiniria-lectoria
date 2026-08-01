import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stableJson } from "../../src/domain/contracts.mjs";
import { EvidenceService } from "../../src/knowledge/evidence-service.mjs";
import { buildContextManifest } from "../../src/provider/prompt-context.mjs";
import { enqueueInput, orchestrator, seedWorkflow } from "../m4-3/helpers.mjs";
import { actor, capture, enqueueEvidence, evidenceWorkspace } from "./helpers.mjs";

test("evidence capture and context are deterministic, immutable, bounded and revision-traceable", async () => {
  const setup = await evidenceWorkspace();
  try {
    const snapshots = Array.from({ length: 20 }, () => capture(setup));
    assert.equal(new Set(snapshots.map((item) => item.evidenceId)).size, 1);
    assert.equal(new Set(snapshots.map((item) => stableJson(item))).size, 1);
    const snapshot = snapshots[0];
    assert.equal(snapshot.hits.length, 2);
    for (const hit of snapshot.hits) {
      const head = setup.fixture.database.prepare("SELECT revision_id FROM knowledge_fact_heads WHERE workspace_id = ? AND fact_id = ? AND state = 'active'")
        .get(setup.fixture.workspaceId, hit.factId);
      assert.equal(head.revision_id, hit.revisionId);
    }
    const contexts = Array.from({ length: 20 }, () => buildContextManifest(setup.fixture.database, setup.fixture.workspaceId, {
      workflowId: setup.workflow.workflowId, segmentIds: [setup.workflow.segmentId], evidenceIds: [snapshot.evidenceId],
    }));
    assert.equal(new Set(contexts.map((item) => item.contextDigest)).size, 1);
    assert.equal(contexts[0].manifest.evidence[0].untrusted, true);
    assert.deepEqual(contexts[0].manifest.permissions.tools, ["segment.read", "candidate.submit", "lookup_terms", "search_knowledge"]);
    assert.throws(() => setup.fixture.database.prepare("UPDATE knowledge_evidence_snapshots SET query_json = '{}'").run(), /immutable/);
    assert.throws(() => setup.fixture.database.prepare("DELETE FROM knowledge_evidence_hits").run(), /immutable/);
    assert.throws(() => capture(setup, { workspaceId: randomUUID() }), /unknown field/);
    assert.throws(() => capture(setup, { topK: 21 }), /topK/);
    for (let repeat = 0; repeat < 100; repeat += 1) {
      assert.throws(() => capture(setup, { query: "x".repeat(513) }), /query/);
      assert.throws(() => capture(setup, { topK: 21 }), /topK/);
      assert.throws(() => buildContextManifest(setup.fixture.database, setup.fixture.workspaceId, {
        workflowId: setup.workflow.workflowId, segmentIds: [setup.workflow.segmentId],
        evidenceIds: Array.from({ length: 9 }, () => randomUUID()),
      }), /bounded/);
    }
  } finally { await setup.fixture.close(); }
});

test("attempt binding is exact and database foreign keys reject cross-scope references", async () => {
  const first = await evidenceWorkspace();
  const second = await evidenceWorkspace();
  try {
    const bound = enqueueEvidence(first);
    const other = capture(first, { query: "workspace backup" });
    assert.deepEqual(first.evidence.evidenceIdsForAttempt(bound.attemptId), [bound.snapshot.evidenceId]);
    assert.throws(() => first.evidence.bindAttempt(randomUUID(), [bound.snapshot.evidenceId]), /attempt not found/);
    assert.throws(() => first.evidence.evidenceIdsForAttempt(randomUUID()), /attempt not found/);
    for (let repeat = 0; repeat < 200; repeat += 1) {
      assert.throws(() => second.evidence.get(bound.snapshot.evidenceId), /not found/);
      assert.throws(() => second.evidence.bindAttempt(bound.attemptId, [bound.snapshot.evidenceId]), /attempt not found/);
      assert.throws(() => first.fixture.database.prepare("INSERT INTO attempt_evidence_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(first.fixture.workspaceId, bound.attemptId, randomUUID(), first.workflow.workflowId,
          first.workflow.sourceRevisionId, first.workflow.targetLanguage, first.workflow.segmentId,
          other.evidenceId, other.evidenceDigest), /FOREIGN KEY/);
    }
    assert.throws(() => first.fixture.database.prepare("DELETE FROM attempt_evidence_bindings").run(), /immutable/);
  } finally { await first.fixture.close(); await second.fixture.close(); }
});

test("fact, index, policy and workflow changes make old evidence stale", async () => {
  const factSetup = await evidenceWorkspace();
  const policySetup = await evidenceWorkspace();
  const workflowSetup = await evidenceWorkspace();
  try {
    const factSnapshot = capture(factSetup);
    factSetup.facts.setActive(factSetup.knowledge.factId, 0, false, actor);
    assert.deepEqual(factSetup.evidence.currentStatus(factSnapshot.evidenceId), { current: false, reason: "fact" });
    await factSetup.retriever.rebuild();
    assert.deepEqual(factSetup.evidence.currentStatus(factSnapshot.evidenceId), { current: false, reason: "index" });

    const policySnapshot = capture(policySetup);
    const changedPolicy = new EvidenceService(policySetup.fixture.database, policySetup.fixture.workspaceId, policySetup.retriever, { policyVersion: "knowledge-evidence-policy-v2" });
    assert.deepEqual(changedPolicy.currentStatus(policySnapshot.evidenceId), { current: false, reason: "policy" });

    const workflowSnapshot = capture(workflowSetup);
    workflowSetup.fixture.database.prepare("UPDATE translation_workflows SET state = 'stale', version = version + 1, updated_at = ? WHERE workspace_id = ? AND workflow_id = ?")
      .run(new Date(1).toISOString(), workflowSetup.fixture.workspaceId, workflowSetup.workflow.workflowId);
    assert.deepEqual(workflowSetup.evidence.currentStatus(workflowSnapshot.evidenceId), { current: false, reason: "workflow" });
    assert.throws(() => workflowSetup.evidence.assertCurrent(workflowSnapshot.evidenceId), /stale/);
  } finally { await factSetup.fixture.close(); await policySetup.fixture.close(); await workflowSetup.fixture.close(); }
});

test("workspace workflow task attempt revision and language reference attacks fail in service and database", async () => {
  const setup = await evidenceWorkspace();
  try {
    const first = enqueueEvidence(setup);
    const otherWorkflow = seedWorkflow(setup.fixture, { targetLanguage: "ja", sourceText: "別の文書" });
    const otherEvidence = setup.evidence.capture({ workflowId: otherWorkflow.workflowId, segmentId: otherWorkflow.segmentId,
      query: "workspace", kinds: ["term", "knowledge"], tags: [], topK: 5 });
    const otherContext = buildContextManifest(setup.fixture.database, setup.fixture.workspaceId, {
      workflowId: otherWorkflow.workflowId, segmentIds: [otherWorkflow.segmentId], evidenceIds: [otherEvidence.evidenceId],
    });
    const otherTask = orchestrator(setup.fixture).enqueue(enqueueInput(otherWorkflow, "m5-3-other", {
      promptVersion: otherContext.manifest.promptVersion, contextDigest: otherContext.contextDigest,
    }));
    const otherAttemptId = otherTask.attempts[0].attempt_id;
    setup.evidence.bindAttempt(otherAttemptId, [otherEvidence.evidenceId]);
    const term = setup.facts.get(setup.term.factId);
    const knowledge = setup.facts.get(setup.knowledge.factId);

    for (let repeat = 0; repeat < 200; repeat += 1) {
      assert.throws(() => buildContextManifest(setup.fixture.database, setup.fixture.workspaceId, {
        workflowId: otherWorkflow.workflowId, segmentIds: [otherWorkflow.segmentId], evidenceIds: [first.snapshot.evidenceId],
      }), /scope mismatch/);
      assert.throws(() => setup.evidence.bindAttempt(otherAttemptId, [first.snapshot.evidenceId]), /scope mismatch/);
      assert.throws(() => setup.evidence.get(randomUUID()), /not found/);
      assert.throws(() => setup.fixture.database.prepare("INSERT INTO attempt_evidence_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(setup.fixture.workspaceId, first.attemptId, first.task.task.task_id, setup.workflow.workflowId,
          setup.workflow.sourceRevisionId, setup.workflow.targetLanguage, setup.workflow.segmentId,
          otherEvidence.evidenceId, otherEvidence.evidenceDigest), /FOREIGN KEY/);
      assert.throws(() => setup.fixture.database.prepare("INSERT INTO knowledge_evidence_hits VALUES (?, ?, 1, ?, ?, 'term', 'zh-CN', 'title', 'x', ?, ?, 0)")
        .run(setup.fixture.workspaceId, otherEvidence.evidenceId, term.source.factId, knowledge.revision.revisionId,
          `sha256:${"1".repeat(64)}`, term.revision.contentDigest), /FOREIGN KEY/);
      assert.throws(() => setup.fixture.database.prepare("INSERT INTO knowledge_evidence_hits VALUES (?, ?, 1, ?, ?, 'term', 'ja', 'title', 'x', ?, ?, 0)")
        .run(setup.fixture.workspaceId, otherEvidence.evidenceId, term.source.factId, term.revision.revisionId,
          `sha256:${"1".repeat(64)}`, term.revision.contentDigest), /FOREIGN KEY/);
      assert.throws(() => setup.fixture.database.prepare("INSERT INTO knowledge_evidence_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), randomUUID(), setup.workflow.workflowId, setup.workflow.documentId,
          setup.workflow.sourceRevisionId, setup.workflow.targetLanguage, setup.workflow.segmentId,
          stableJson({ text: "workspace", language: setup.workflow.targetLanguage }),
          stableJson({ kinds: ["term"], tags: [], documentIds: [setup.workflow.documentId], topK: 1 }),
          "fts-v1", "policy-v1", `sha256:${"2".repeat(64)}`, `sha256:${"3".repeat(64)}`, new Date(0).toISOString()), /FOREIGN KEY/);
    }
  } finally { await setup.fixture.close(); }
});
