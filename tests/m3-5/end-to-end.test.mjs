import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowApi } from "../../src/application/workflow-api.mjs";
import { runWorkflowCli } from "../../src/cli/workflow-cli.mjs";
import { ReimportService } from "../../src/document/reimport-service.mjs";
import { ExportService } from "../../src/export/export-service.mjs";
import { normalizeDocument } from "../../src/document/parser.mjs";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../../src/storage/backup.mjs";
import { ReviewService } from "../../src/translation/review-service.mjs";
import { ValidationService } from "../../src/translation/validator.mjs";
import { WorkCopyService } from "../../src/translation/work-copy-service.mjs";
import { WorkspaceManager } from "../../src/workspace/manager.mjs";
import { FlowPlanService } from "../../src/m5c/flow-plan-service.mjs";
import { validFixtures } from "../fixtures/m3-2/corpus.mjs";
import { createEditableWorkflow, seedWorkingCopies, workspace } from "../m3-4/helpers.mjs";
import { createExportable } from "./helpers.mjs";

const markerPattern = /(⟦LCT-P-\d{4}-[0-9a-f]{16}⟧)/g;
const exactMarkerPattern = /^⟦LCT-P-\d{4}-[0-9a-f]{16}⟧$/;

function translatedText(segment) {
  return segment.sourceText.split(markerPattern).map((part) => exactMarkerPattern.test(part)
    ? part
    : part.replace(/\p{L}/gu, "x")).join("");
}

test("the application CLI creates only an M5C planning flow with a mandatory local ContextPlan", async () => {
  const fixture = await workspace("lectoria-m3-5-cli-e2e-");
  try {
    const exports = new ExportService({
      database: fixture.database, root: fixture.root, trustedWorkspaceId: fixture.workspaceId,
      workCopies: fixture.workCopies, validation: fixture.validation, now: () => new Date(0),
    });
    const api = new WorkflowApi({
      imports: fixture.imports,
      reimports: new ReimportService({ database: fixture.database, root: fixture.root, trustedWorkspaceId: fixture.workspaceId, now: () => new Date(0) }),
      flowPlans: new FlowPlanService(fixture.database, fixture.workspaceId, { now: () => new Date(0) }),
      workCopies: fixture.workCopies,
      validation: fixture.validation,
      reviews: fixture.reviews,
      exports,
    });
    const source = { format: "text", title: "CLI M5C", content: "Nikon 3枚 lens is not 2组." };
    const imported = await runWorkflowCli(api, ["document:import", JSON.stringify(source)]);
    runWorkflowCli(api, ["document:confirm", JSON.stringify({ importId: imported.importId, actor: { type: "user", id: "owner" } })]);
    const workflowId = crypto.randomUUID();
    const created = runWorkflowCli(api, ["workflow:create", JSON.stringify({ importId: imported.importId, workflowId, targetLanguage: "fr", actor: { type: "user", id: "owner" } })]);
    assert.equal(created.flow.flowState, "planning");
    assert.equal(created.plan.plannerMode, "local");
    assert.ok(created.plan.items.some((item) => item.kind === "measurement"));
    assert.throws(() => runWorkflowCli(api, ["review", JSON.stringify({ workflowId, validationRunId: "missing", expectedWorkflowVersion: 0, actor: { type: "user", id: "reviewer" } })]), /validation run not found/);
  } finally { await fixture.close(); }
});

test("twelve documents complete ten offline import-edit-review-export rounds", async () => {
  const selected = ["markdown", "html", "text"].flatMap((format) => validFixtures.filter((item) => item.format === format).slice(0, 4));
  assert.equal(selected.length, 12);
  const fixture = await workspace("lectoria-m3-5-e2e-");
  let completed = 0;
  try {
    for (const source of selected) for (let round = 0; round < 10; round += 1) {
      const prepared = await createExportable(fixture, { ...source, id: `${source.id}-${round}` }, translatedText);
      const ordinary = await prepared.exports.export(prepared.workflow.workflowId, prepared.run.validationRunId, source.format);
      const canonical = await prepared.exports.export(prepared.workflow.workflowId, prepared.run.validationRunId, "canonical");
      const reparsed = normalizeDocument(source.format, ordinary.content);
      const bundle = fixture.workCopies.getBundle(prepared.workflow.workflowId);
      assert.deepEqual(reparsed.segments.map((segment) => segment.sourceText), bundle.segments.map((segment) => segment.text));
      assert.equal(canonical.manifest.source_revision_id, prepared.workflow.sourceRevisionId);
      assert.equal(fixture.states.get(prepared.workflow.workflowId).state, "exported");
      assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM export_records WHERE workflow_id = ?").get(prepared.workflow.workflowId).total, 2);
      assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM working_copy_revisions WHERE workflow_id = ?").get(prepared.workflow.workflowId).total, prepared.workflow.segments.length * 2);
      completed += 1;
    }
    assert.equal(completed, 120);
  } finally { await fixture.close(); }
});

test("three workspaces restore and continue editing, validating, reviewing and exporting ten times", async () => {
  let completed = 0;
  for (let workspaceIndex = 0; workspaceIndex < 3; workspaceIndex += 1) {
    const source = await workspace(`lectoria-m3-5-restore-source-${workspaceIndex}-`);
    try {
      const workflow = await createEditableWorkflow(source, { content: `Workspace ${workspaceIndex} source text.` });
      seedWorkingCopies(source, workflow);
      for (let round = 0; round < 10; round += 1) {
        const backup = join(source.root, `backup-${round}`);
        await createWorkspaceBackup({ database: source.database, workspaceRoot: source.root, destination: backup });
        const targetRoot = await mkdtemp(join(tmpdir(), "lectoria-m3-5-restore-target-"));
        const manager = await WorkspaceManager.create(targetRoot);
        try {
          await restoreWorkspaceBackup({ backupRoot: backup, manager });
          const handle = manager.open(source.workspaceId);
          try {
            const workCopies = new WorkCopyService(handle.database, source.workspaceId, { now: () => new Date(0) });
            const validation = new ValidationService(handle.database, source.workspaceId, { now: () => new Date(0), workCopies });
            const reviews = new ReviewService(handle.database, source.workspaceId, { now: () => new Date(0), validation });
            const head = workCopies.getHead(workflow.workflowId, workflow.segments[0].segmentId);
            workCopies.edit(workflow.workflowId, workflow.segments[0].segmentId, head.version, `Restored translation ${round}.`, { type: "user", id: "writer" });
            const run = validation.run(workflow.workflowId);
            for (const warning of run.findings.filter((item) => item.severity === "warning")) {
              reviews.confirmWarning(workflow.workflowId, run.validationRunId, warning.findingId, { type: "user", id: "reviewer" });
            }
            reviews.humanReview(workflow.workflowId, run.validationRunId, 0, { type: "user", id: "reviewer" });
            reviews.approve(workflow.workflowId, run.validationRunId, 1, { type: "user", id: "approver" });
            const exports = new ExportService({ database: handle.database, root: handle.root, trustedWorkspaceId: source.workspaceId, workCopies, validation, now: () => new Date(0) });
            const result = await exports.export(workflow.workflowId, run.validationRunId, "markdown");
            assert.equal(result.manifest.working_copy_digest, workCopies.getBundle(workflow.workflowId).digest);
            assert.equal(handle.database.prepare("SELECT count(*) AS total FROM working_copy_revisions WHERE workflow_id = ?").get(workflow.workflowId).total, 2);
            assert.equal(handle.database.prepare("SELECT count(*) AS total FROM review_events WHERE workflow_id = ? AND action IN ('human-reviewed','approved-for-export')").get(workflow.workflowId).total, 2);
            assert.equal(handle.database.pragma("foreign_key_check").length, 0);
            completed += 1;
          } finally { handle.database.close(); }
        } finally {
          manager.close();
          await rm(targetRoot, { recursive: true, force: true });
        }
      }
    } finally { await source.close(); }
  }
  assert.equal(completed, 30);
});
