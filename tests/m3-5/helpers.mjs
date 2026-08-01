import { randomUUID } from "node:crypto";
import { ExportService } from "../../src/export/export-service.mjs";
import { seedWorkingCopies } from "../m3-4/helpers.mjs";

export async function createExportable(fixture, source, transform = (segment) => segment.sourceText) {
  const imported = await fixture.imports.import({ format: source.format, content: source.content, title: source.id ?? "Fixture" });
  fixture.imports.confirm(imported.importId, { type: "user", id: "owner" });
  const workflowId = randomUUID();
  fixture.states.create({
    workflowId, documentId: imported.documentId, sourceRevisionId: imported.sourceRevisionId, targetLanguage: source.targetLanguage ?? "fr",
  }, {}, "editing");
  const segments = fixture.database.prepare(`
    SELECT segment_id AS segmentId, kind, structural_path AS structuralPath,
           source_text AS sourceText, protected_json AS protectedJson, ordinal
    FROM source_segment_versions WHERE workspace_id = ? AND source_revision_id = ? ORDER BY ordinal
  `).all(fixture.workspaceId, imported.sourceRevisionId).map((row) => ({ ...row, protected: JSON.parse(row.protectedJson) }));
  const workflow = { ...imported, workflowId, targetLanguage: source.targetLanguage ?? "fr", segments };
  const heads = seedWorkingCopies(fixture, workflow);
  segments.forEach((segment, index) => {
    fixture.workCopies.edit(workflowId, segment.segmentId, heads[index].version, transform(segment), { type: "user", id: "writer" });
  });
  const run = fixture.validation.run(workflowId);
  for (const warning of run.findings.filter((item) => item.severity === "warning")) {
    fixture.reviews.confirmWarning(workflowId, run.validationRunId, warning.findingId, { type: "user", id: "reviewer" });
  }
  fixture.reviews.humanReview(workflowId, run.validationRunId, 0, { type: "user", id: "reviewer" });
  fixture.reviews.approve(workflowId, run.validationRunId, 1, { type: "user", id: "approver" });
  return {
    workflow, run,
    exports: new ExportService({
      database: fixture.database, root: fixture.root, trustedWorkspaceId: fixture.workspaceId,
      now: () => new Date(0), workCopies: fixture.workCopies, validation: fixture.validation,
    }),
  };
}
