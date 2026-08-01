import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseModelResponse } from "../../src/provider/model-response.mjs";
import { MachineCandidateService } from "../../src/translation/machine-candidate-service.mjs";
import { ReviewConflictError } from "../../src/translation/review-service.mjs";
import { createEditableWorkflow, seedWorkingCopies, workspace as documentWorkspace } from "../m3-4/helpers.mjs";
import { enqueueWithContext, orchestrator, responseFor, seedWorkflow, workspace } from "./helpers.mjs";

function complete(fixture, context, service) {
  const lease = service.leaseNext("worker", 1_000);
  const running = service.startProvider(lease.attempt_id, lease.version, "worker");
  const response = responseFor(context);
  const parsed = parseModelResponse(response, context);
  service.complete(lease.attempt_id, running.version, "worker", parsed.outputDigest);
  return { attemptId: lease.attempt_id, response, parsed };
}

test("completed outcomes become immutable provenance-bound candidates without changing the working copy", async () => {
  const fixture = await workspace();
  try {
    const workflow = seedWorkflow(fixture);
    const { context } = enqueueWithContext(fixture, workflow, "default");
    const tasks = orchestrator(fixture);
    const completed = complete(fixture, context, tasks);
    const machine = new MachineCandidateService(fixture.database, fixture.workspaceId, { now: fixture.clock.now });
    const attempt = fixture.database.prepare("SELECT * FROM translation_attempts WHERE attempt_id = ?").get(completed.attemptId);
    for (let index = 0; index < 100; index += 1) {
      assert.throws(() => fixture.database.transaction(() => {
        const candidateId = randomUUID();
        fixture.database.prepare("INSERT INTO translation_candidates VALUES (?, ?, ?, ?, ?, ?, ?, 'machine', ?, ?, ?)").run(
          fixture.workspaceId, candidateId, attempt.workflow_id, attempt.document_id, attempt.source_revision_id,
          attempt.target_language, attempt.segment_id, "forged", completed.parsed.outputDigest, new Date(0).toISOString(),
        );
        fixture.database.prepare("INSERT INTO machine_candidate_provenance VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'default', NULL, ?)").run(
          fixture.workspaceId, candidateId, attempt.task_id, attempt.attempt_id, attempt.workflow_id,
          attempt.source_revision_id, "ja", attempt.segment_id, attempt.provider_id, attempt.model_id,
          attempt.prompt_version, attempt.context_digest, attempt.request_digest, completed.parsed.outputDigest,
          new Date(0).toISOString(),
        );
      })(), /FOREIGN KEY/);
    }
    const candidate = machine.accept(completed.attemptId, completed.response);
    assert.equal(candidate.candidateId, completed.attemptId);
    assert.equal(candidate.sourceType, "machine");
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM working_copy_heads").get().total, 0);
    const provenance = machine.workCopies.getMachineProvenance(candidate.candidateId);
    assert.equal(provenance.contextDigest, context.contextDigest);
    assert.equal(provenance.outputDigest, completed.parsed.outputDigest);
    assert.equal(provenance.generationMode, "default");
    assert.throws(() => fixture.database.prepare("UPDATE translation_candidates SET text = 'tampered'").run(), /immutable/);
    assert.throws(() => fixture.database.prepare("DELETE FROM machine_candidate_provenance").run(), /immutable/);
    assert.throws(() => machine.accept(completed.attemptId, completed.response), /uniqueness conflict/);
  } finally { await fixture.close(); }
});

test("additional candidates require an explicit user command and never overwrite a selected head", async () => {
  const fixture = await workspace();
  try {
    const workflow = seedWorkflow(fixture);
    const firstSetup = enqueueWithContext(fixture, workflow, "first");
    const tasks = orchestrator(fixture);
    const first = complete(fixture, firstSetup.context, tasks);
    const machine = new MachineCandidateService(fixture.database, fixture.workspaceId, { now: fixture.clock.now });
    const firstCandidate = machine.accept(first.attemptId, first.response);
    const head = machine.workCopies.selectCandidate(workflow.workflowId, workflow.segmentId, firstCandidate.candidateId, null, { type: "user", id: "reviewer" });

    const secondSetup = enqueueWithContext(fixture, workflow, "second");
    const second = complete(fixture, secondSetup.context, tasks);
    assert.throws(() => machine.accept(second.attemptId, second.response, { generationMode: "user-requested", userCommandId: "append-1" }), /authorization/);
    machine.authorizeAdditionalCandidate(secondSetup.task.task.task_id, "append-1", secondSetup.task.task.request_digest, { type: "user", id: "reviewer" });
    const added = machine.accept(second.attemptId, second.response, { generationMode: "user-requested", userCommandId: "append-1" });
    assert.equal(added.sourceType, "machine");
    assert.equal(machine.workCopies.listCandidates(workflow.workflowId, workflow.segmentId).length, 2);
    assert.equal(machine.workCopies.getHead(workflow.workflowId, workflow.segmentId).headRevisionId, head.headRevisionId);
    assert.throws(() => machine.authorizeAdditionalCandidate(secondSetup.task.task.task_id, "append-2", secondSetup.task.task.request_digest, { type: "runner", id: "runner" }), /only a user/);
  } finally { await fixture.close(); }
});

test("mismatched or stale context never creates a selectable machine candidate", async () => {
  const fixture = await workspace();
  try {
    const workflow = seedWorkflow(fixture);
    const { context } = enqueueWithContext(fixture, workflow, "scope");
    const tasks = orchestrator(fixture);
    const completed = complete(fixture, context, tasks);
    const machine = new MachineCandidateService(fixture.database, fixture.workspaceId, { now: fixture.clock.now });
    for (let index = 0; index < 100; index += 1) {
      const response = structuredClone(completed.response);
      response.workflowId = randomUUID();
      assert.throws(() => machine.accept(completed.attemptId, response));
    }
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM translation_candidates WHERE source_type = 'machine'").get().total, 0);
  } finally { await fixture.close(); }
});

test("provider runner system and fixture actors cannot review or approve", async () => {
  for (const actorType of ["provider", "runner", "system", "fixture"]) {
    const fixture = await documentWorkspace(`lectoria-m4-4-review-${actorType}-`);
    try {
      const workflow = await createEditableWorkflow(fixture);
      seedWorkingCopies(fixture, workflow);
      const run = fixture.validation.run(workflow.workflowId);
      for (let index = 0; index < 100; index += 1) {
        assert.throws(() => fixture.reviews.humanReview(workflow.workflowId, run.validationRunId, 0, { type: actorType, id: actorType }), ReviewConflictError);
      }
      assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM domain_audit_events WHERE action = 'human-reviewed-rejected' AND actor_type = ? AND succeeded = 0").get(actorType).total, 100);
    } finally { await fixture.close(); }
  }
});
