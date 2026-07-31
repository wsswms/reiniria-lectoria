import assert from "node:assert/strict";
import test from "node:test";
import { ReviewConflictError, ReviewService } from "../../src/translation/review-service.mjs";
import { ValidationService } from "../../src/translation/validator.mjs";
import { WorkCopyConflictError, WorkCopyService } from "../../src/translation/work-copy-service.mjs";
import { createEditableWorkflow, seedWorkingCopies, workspace } from "./helpers.mjs";

test("candidates are immutable and every selection or edit appends explicit history", async () => {
  const fixture = await workspace("lectoria-m3-4-candidate-");
  try {
    const workflow = await createEditableWorkflow(fixture);
    const segment = workflow.segments[0];
    const first = fixture.workCopies.addCandidate(workflow.workflowId, segment.segmentId, "Premier", { type: "user", id: "writer" });
    assert.deepEqual(fixture.workCopies.listCandidates(workflow.workflowId, segment.segmentId).map((item) => item.candidateId), [first.candidateId]);
    assert.throws(() => fixture.database.prepare("UPDATE translation_candidates SET text = 'tampered'").run(), /immutable/);
    assert.throws(() => fixture.database.prepare("DELETE FROM translation_candidates").run(), /immutable/);
    const selected = fixture.workCopies.selectCandidate(workflow.workflowId, segment.segmentId, first.candidateId, null, { type: "user", id: "writer" });
    assert.throws(() => fixture.database.prepare("UPDATE working_copy_heads SET version = version + 2 WHERE workflow_id = ?").run(workflow.workflowId), /invalid working copy head update/);
    assert.throws(() => fixture.database.prepare("DELETE FROM working_copy_heads WHERE workflow_id = ?").run(workflow.workflowId), /immutable/);
    const edited = fixture.workCopies.edit(workflow.workflowId, segment.segmentId, selected.version, "Premier édité", { type: "user", id: "writer" });
    const second = fixture.workCopies.addCandidate(workflow.workflowId, segment.segmentId, "Deuxième", { type: "fixture", id: "fixture" });
    const reselected = fixture.workCopies.selectCandidate(workflow.workflowId, segment.segmentId, second.candidateId, edited.version, { type: "user", id: "writer" });
    assert.equal(reselected.version, 2);
    assert.equal(reselected.parentRevisionId, edited.headRevisionId);
    assert.equal(reselected.sourceCandidateId, second.candidateId);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM working_copy_revisions WHERE workflow_id = ? AND segment_id = ?").get(workflow.workflowId, segment.segmentId).total, 3);
    assert.equal(fixture.workCopies.getCandidate(first.candidateId).text, "Premier");
  } finally { await fixture.close(); }
});

test("one hundred same-version edits permit one writer with matching history and audit", async () => {
  const fixture = await workspace("lectoria-m3-4-edit-race-");
  try {
    const workflow = await createEditableWorkflow(fixture);
    const [head] = seedWorkingCopies(fixture, workflow);
    const segmentId = workflow.segments[0].segmentId;
    const attempts = await Promise.all(Array.from({ length: 100 }, async (_, index) => {
      try {
        const result = fixture.workCopies.edit(workflow.workflowId, segmentId, head.version, `Version ${index}`, { type: "user", id: `writer-${index}` });
        return { status: "success", result };
      } catch (error) {
        assert.ok(error instanceof WorkCopyConflictError);
        return { status: "conflict" };
      }
    }));
    const successes = attempts.filter((item) => item.status === "success");
    assert.equal(successes.length, 1);
    assert.equal(attempts.filter((item) => item.status === "conflict").length, 99);
    const current = fixture.workCopies.getHead(workflow.workflowId, segmentId);
    assert.equal(current.headRevisionId, successes[0].result.headRevisionId);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM working_copy_revisions WHERE workflow_id = ? AND segment_id = ?").get(workflow.workflowId, segmentId).total, 2);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM domain_audit_events WHERE entity_id = ? AND action = 'working-copy-edited' AND succeeded = 1").get(workflow.workflowId).total, 1);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM domain_audit_events WHERE entity_id = ? AND action = 'working-copy-edited-conflict' AND succeeded = 0").get(workflow.workflowId).total, 99);
  } finally { await fixture.close(); }
});

test("validation warnings require confirmation and only users can review or approve", async () => {
  const fixture = await workspace("lectoria-m3-4-review-");
  try {
    const workflow = await createEditableWorkflow(fixture);
    seedWorkingCopies(fixture, workflow, (segment) => {
      const markers = segment.protected.map((item) => item.marker).join(" ");
      return markers ? `Texte traduit ${markers}` : `Texte traduit ${segment.ordinal}`;
    });
    const run = fixture.validation.run(workflow.workflowId);
    assert.equal(run.current, true);
    assert.equal(run.findings.some((item) => item.severity === "error"), false);
    const warnings = run.findings.filter((item) => item.severity === "warning");
    assert.ok(warnings.length >= 3);
    assert.throws(() => fixture.database.prepare("UPDATE validation_runs SET validator_version = 'tampered'").run(), /immutable/);
    assert.throws(() => fixture.reviews.humanReview(workflow.workflowId, run.validationRunId, 0, { type: "user", id: "reviewer" }), /warnings/);
    for (const warning of warnings) fixture.reviews.confirmWarning(workflow.workflowId, run.validationRunId, warning.findingId, { type: "user", id: "reviewer" });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const by = { type: attempt % 2 === 0 ? "system" : "fixture", id: `non-user-${attempt}` };
      assert.throws(() => fixture.reviews.humanReview(workflow.workflowId, run.validationRunId, 0, by), ReviewConflictError);
    }
    const reviewed = fixture.reviews.humanReview(workflow.workflowId, run.validationRunId, 0, { type: "user", id: "reviewer" });
    assert.equal(reviewed.state, "human-reviewed");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const by = { type: attempt % 2 === 0 ? "system" : "fixture", id: `non-user-${attempt}` };
      assert.throws(() => fixture.reviews.approve(workflow.workflowId, run.validationRunId, 1, by), ReviewConflictError);
    }
    const approved = fixture.reviews.approve(workflow.workflowId, run.validationRunId, 1, { type: "user", id: "approver" });
    assert.equal(approved.state, "approved-for-export");
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM domain_audit_events WHERE entity_id = ? AND succeeded = 0 AND action IN ('human-reviewed-rejected', 'approved-for-export-rejected')").get(workflow.workflowId).total, 200);
    const candidate = fixture.workCopies.listCandidates(workflow.workflowId, workflow.segments[0].segmentId)[0];
    assert.throws(() => fixture.workCopies.selectCandidate(workflow.workflowId, workflow.segments[0].segmentId, candidate.candidateId, 0, { type: "user", id: "writer" }), /reviewed or terminal/);
  } finally { await fixture.close(); }
});

test("errors and stale validation runs block review after any head, parser or rule change", async () => {
  const fixture = await workspace("lectoria-m3-4-stale-");
  try {
    const workflow = await createEditableWorkflow(fixture);
    const heads = seedWorkingCopies(fixture, workflow);
    const validRun = fixture.validation.run(workflow.workflowId);
    fixture.workCopies.edit(workflow.workflowId, workflow.segments[0].segmentId, heads[0].version, "", { type: "user", id: "writer" });
    assert.equal(fixture.validation.get(validRun.validationRunId).current, false);
    assert.throws(() => fixture.reviews.humanReview(workflow.workflowId, validRun.validationRunId, 0, { type: "user", id: "reviewer" }), /stale/);
    const invalidRun = fixture.validation.run(workflow.workflowId);
    assert.ok(invalidRun.findings.some((item) => item.severity === "error" && item.code === "EMPTY_TARGET"));
    assert.throws(() => fixture.reviews.humanReview(workflow.workflowId, invalidRun.validationRunId, 0, { type: "user", id: "reviewer" }), /errors/);
    const parserChanged = new ValidationService(fixture.database, fixture.workspaceId, { workCopies: fixture.workCopies, parserVersion: "lectoria-parser-v2-test" });
    const rulesChanged = new ValidationService(fixture.database, fixture.workspaceId, { workCopies: fixture.workCopies, validatorVersion: "lectoria-validator-v2-test" });
    assert.equal(parserChanged.isCurrent(invalidRun.validationRunId), false);
    assert.equal(rulesChanged.isCurrent(invalidRun.validationRunId), false);
  } finally { await fixture.close(); }
});

test("candidate, head, validation and review resources never cross workspace scope", async () => {
  const first = await workspace("lectoria-m3-4-scope-a-");
  const second = await workspace("lectoria-m3-4-scope-b-");
  try {
    const workflow = await createEditableWorkflow(first);
    const heads = seedWorkingCopies(first, workflow);
    const candidate = first.workCopies.listCandidates(workflow.workflowId, workflow.segments[0].segmentId)[0];
    const run = first.validation.run(workflow.workflowId);
    first.reviews.humanReview(workflow.workflowId, run.validationRunId, 0, { type: "user", id: "reviewer" });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      assert.throws(() => second.workCopies.getCandidate(candidate.candidateId, first.workspaceId), WorkCopyConflictError);
      assert.throws(() => second.workCopies.getHead(workflow.workflowId, heads[0].segmentId, first.workspaceId), WorkCopyConflictError);
      assert.throws(() => second.validation.get(run.validationRunId, first.workspaceId));
      assert.throws(() => second.reviews.getEvents(workflow.workflowId, first.workspaceId), ReviewConflictError);
    }
  } finally {
    await first.close();
    await second.close();
  }
});
