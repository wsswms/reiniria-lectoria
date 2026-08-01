import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspaceDatabase } from "../../src/db/connection.mjs";
import { DocumentImportService } from "../../src/document/import-service.mjs";
import { DomainStateService } from "../../src/domain/state-service.mjs";
import { ReviewService } from "../../src/translation/review-service.mjs";
import { ValidationService } from "../../src/translation/validator.mjs";
import { WorkCopyService } from "../../src/translation/work-copy-service.mjs";

export async function workspace(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  for (const path of ["private/objects", "private/ledger", "derived", "staging"]) await mkdir(join(root, path), { recursive: true });
  const workspaceId = randomUUID();
  const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId });
  const options = { now: () => new Date(0), id: () => randomUUID() };
  const workCopies = new WorkCopyService(database, workspaceId, options);
  const validation = new ValidationService(database, workspaceId, { ...options, workCopies });
  return {
    root, workspaceId, database, workCopies, validation,
    imports: new DocumentImportService({ database, root, trustedWorkspaceId: workspaceId, now: options.now, id: options.id }),
    states: new DomainStateService(database, workspaceId, options),
    reviews: new ReviewService(database, workspaceId, { ...options, validation }),
    close: async () => { database.close(); await rm(root, { recursive: true, force: true }); },
  };
}

export async function createEditableWorkflow(fixture, {
  content = "# Guide\n\nPay 20 kg on 2026-01-02 at [site](https://example.com) {{< badge >}}.",
  targetLanguage = "fr",
} = {}) {
  const imported = await fixture.imports.import({ format: "markdown", content, title: "Fixture" });
  fixture.imports.confirm(imported.importId, { type: "user", id: "owner" });
  const workflowId = randomUUID();
  fixture.states.create({
    workflowId,
    documentId: imported.documentId,
    sourceRevisionId: imported.sourceRevisionId,
    targetLanguage,
  }, {}, "editing");
  const segments = fixture.database.prepare(`
    SELECT segment_id AS segmentId, kind, structural_path AS structuralPath,
           source_text AS sourceText, protected_json AS protectedJson, ordinal
    FROM source_segment_versions WHERE workspace_id = ? AND source_revision_id = ? ORDER BY ordinal
  `).all(fixture.workspaceId, imported.sourceRevisionId).map((row) => ({ ...row, protected: JSON.parse(row.protectedJson) }));
  return { ...imported, workflowId, targetLanguage, segments };
}

export function seedWorkingCopies(fixture, workflow, transform = (segment) => segment.sourceText, actor = { type: "fixture", id: "fixture" }) {
  const heads = [];
  for (const segment of workflow.segments) {
    const candidate = fixture.workCopies.addCandidate(workflow.workflowId, segment.segmentId, transform(segment), actor);
    heads.push(fixture.workCopies.selectCandidate(workflow.workflowId, segment.segmentId, candidate.candidateId, null, { type: "user", id: `${actor.id}-selector` }));
  }
  return heads;
}
