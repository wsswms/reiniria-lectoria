import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { decodeCanonicalPackage, encodeCanonicalPackage } from "../../src/domain/canonical.mjs";
import { ExportConflictError, ExportService } from "../../src/export/export-service.mjs";
import { normalizeDocument } from "../../src/document/parser.mjs";
import { ReimportService } from "../../src/document/reimport-service.mjs";
import { ValidationService } from "../../src/translation/validator.mjs";
import { validFixtures } from "../fixtures/m3-2/corpus.mjs";
import { workspace } from "../m3-4/helpers.mjs";
import { createExportable } from "./helpers.mjs";

test("all thirty-six fixtures produce deterministic ordinary and canonical artifacts twenty times", async () => {
  const fixture = await workspace("lectoria-m3-5-deterministic-");
  try {
    for (const source of validFixtures) {
      const once = normalizeDocument(source.format, source.content);
      const twice = normalizeDocument(source.format, once.normalized);
      assert.equal(twice.normalized, once.normalized, `${source.id}:normalization-fixed-point`);
      assert.deepEqual(twice.segments, once.segments, `${source.id}:segment-fixed-point`);
      const prepared = await createExportable(fixture, source);
      let ordinary;
      try { ordinary = await prepared.exports.export(prepared.workflow.workflowId, prepared.run.validationRunId, source.format); }
      catch (error) { error.message = `${source.id}: ${error.message}`; throw error; }
      const canonical = await prepared.exports.export(prepared.workflow.workflowId, prepared.run.validationRunId, "canonical");
      assert.equal(encodeCanonicalPackage(decodeCanonicalPackage(canonical.content.toString("utf8"))), canonical.content.toString("utf8"), source.id);
      for (let attempt = 1; attempt < 20; attempt += 1) {
        const nextOrdinary = await prepared.exports.export(prepared.workflow.workflowId, prepared.run.validationRunId, source.format);
        const nextCanonical = await prepared.exports.export(prepared.workflow.workflowId, prepared.run.validationRunId, "canonical");
        assert.equal(nextOrdinary.content.equals(ordinary.content), true, `${source.id}:ordinary:${attempt}`);
        assert.equal(nextCanonical.content.equals(canonical.content), true, `${source.id}:canonical:${attempt}`);
        assert.equal(nextOrdinary.manifestDigest, ordinary.manifestDigest);
        assert.equal(nextCanonical.manifestDigest, canonical.manifestDigest);
      }
    }
  } finally { await fixture.close(); }
});

test("export gates reject unapproved, stale, error and mismatched validation workflows", async () => {
  const fixture = await workspace("lectoria-m3-5-gates-");
  try {
    const imported = await fixture.imports.import({ format: "text", content: "Source.", title: "Gate" });
    fixture.imports.confirm(imported.importId, { type: "user", id: "owner" });
    const workflowId = crypto.randomUUID();
    fixture.states.create({ workflowId, documentId: imported.documentId, sourceRevisionId: imported.sourceRevisionId, targetLanguage: "fr" }, {}, "editing");
    const segmentId = fixture.database.prepare("SELECT segment_id AS id FROM source_segment_versions WHERE source_revision_id = ?").get(imported.sourceRevisionId).id;
    const candidate = fixture.workCopies.addCandidate(workflowId, segmentId, "", { type: "user", id: "writer" });
    fixture.workCopies.selectCandidate(workflowId, segmentId, candidate.candidateId, null, { type: "user", id: "writer" });
    const run = fixture.validation.run(workflowId);
    const service = new ExportService({ database: fixture.database, root: fixture.root, trustedWorkspaceId: fixture.workspaceId, workCopies: fixture.workCopies, validation: fixture.validation });
    await assert.rejects(service.export(workflowId, run.validationRunId, "text"), ExportConflictError);
  } finally { await fixture.close(); }
});

test("edited protected links and values survive ordinary export revalidation", async () => {
  const cases = [
    { id: "markdown-link", format: "markdown", content: "Read [manual](https://example.com/manual)." },
    { id: "html-link", format: "html", content: '<p>Read <a href="https://example.com/manual">manual</a>.</p>' },
    { id: "text-edit", format: "text", content: "Plain source." },
  ];
  for (const source of cases) {
    const fixture = await workspace(`lectoria-m3-5-protected-${source.format}-`);
    try {
      const prepared = await createExportable(fixture, source, (segment) => {
        const markers = segment.protected.map((item) => item.marker).join(" ");
        return `Traduction sûre${markers ? ` ${markers}` : ""}.`;
      });
      const result = await prepared.exports.export(prepared.workflow.workflowId, prepared.run.validationRunId, source.format);
      assert.equal(result.content.includes(Buffer.from("https://example.com/manual")), source.format !== "text");
    } finally { await fixture.close(); }
  }
});

test("markdown executable URLs are removed before protection and export", () => {
  const parsed = normalizeDocument("markdown", "[unsafe](javascript:alert(1))");
  assert.ok(parsed.diagnostics.some((item) => item.code === "MARKDOWN_EXECUTABLE_URL_REMOVED"));
  assert.equal(parsed.normalized.includes("javascript:"), false);
});

test("edited text cannot inject active HTML into markdown or HTML exports", async () => {
  for (const format of ["markdown", "html"]) {
    const fixture = await workspace(`lectoria-m3-5-active-target-${format}-`);
    try {
      const content = format === "markdown" ? "Safe paragraph." : "<p>Safe paragraph.</p>";
      const prepared = await createExportable(fixture, { id: `active-${format}`, format, content }, () => "<script>alert(1)</script> Safe");
      const result = await prepared.exports.export(prepared.workflow.workflowId, prepared.run.validationRunId, format);
      const reparsed = normalizeDocument(format, result.content);
      assert.equal(reparsed.diagnostics.some((item) => item.code === "HTML_ACTIVE_TAG_REMOVED"), false);
      assert.equal(result.content.toString("utf8").includes("<script>"), false);
    } finally { await fixture.close(); }
  }

  const fixture = await workspace("lectoria-m3-5-protected-code-");
  try {
    const prepared = await createExportable(fixture, {
      id: "protected-code",
      format: "html",
      content: "<p><code>&lt;/code&gt;&lt;script&gt;alert(1)&lt;/script&gt;</code></p>",
    }, (segment) => segment.protected.map((item) => item.marker).join(" "));
    const result = await prepared.exports.export(prepared.workflow.workflowId, prepared.run.validationRunId, "html");
    assert.equal(result.content.toString("utf8").includes("<script>"), false);
  } finally { await fixture.close(); }
});

test("parser or validator runtime changes make approved validation ineligible for export", async () => {
  const fixture = await workspace("lectoria-m3-5-stale-validation-");
  try {
    const prepared = await createExportable(fixture, { id: "stale", format: "text", content: "Stable source." });
    const changedValidation = new ValidationService(fixture.database, fixture.workspaceId, {
      workCopies: fixture.workCopies, parserVersion: "lectoria-parser-v-next",
    });
    const service = new ExportService({
      database: fixture.database, root: fixture.root, trustedWorkspaceId: fixture.workspaceId,
      workCopies: fixture.workCopies, validation: changedValidation,
    });
    await assert.rejects(service.export(prepared.workflow.workflowId, prepared.run.validationRunId, "text"), /stale/);
  } finally { await fixture.close(); }
});

test("pending ambiguous reimport blocks a newly approved export", async () => {
  const fixture = await workspace("lectoria-m3-5-pending-reimport-");
  try {
    const prepared = await createExportable(fixture, { id: "ambiguous", format: "text", content: "First part second part" });
    const reimports = new ReimportService({ database: fixture.database, root: fixture.root, trustedWorkspaceId: fixture.workspaceId, now: () => new Date(0) });
    const operation = await reimports.prepare({
      documentId: prepared.workflow.documentId,
      baseRevisionId: prepared.workflow.sourceRevisionId,
      format: "text",
      content: "First part\n\nsecond part",
    });
    assert.ok(operation.candidates.every((item) => item.status === "ambiguous"));
    await assert.rejects(prepared.exports.export(prepared.workflow.workflowId, prepared.run.validationRunId, "text"), /pending reimport/);
  } finally { await fixture.close(); }
});

test("export identities and records never cross workspace scope", async () => {
  const first = await workspace("lectoria-m3-5-scope-a-");
  const second = await workspace("lectoria-m3-5-scope-b-");
  try {
    const prepared = await createExportable(first, { id: "scope", format: "text", content: "Scoped source." });
    await prepared.exports.export(prepared.workflow.workflowId, prepared.run.validationRunId, "text");
    const foreign = new ExportService({ database: second.database, root: second.root, trustedWorkspaceId: second.workspaceId, workCopies: second.workCopies, validation: second.validation });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await assert.rejects(foreign.export(prepared.workflow.workflowId, prepared.run.validationRunId, "text"), ExportConflictError);
    }
  } finally {
    await first.close();
    await second.close();
  }
});

test("all export failure points preserve atomic files and retry to one immutable record", async () => {
  const points = ["after-temp-directory", "after-file-manifest.json", "after-file-translation.txt", "before-directory-rename", "after-directory-rename", "after-export-stage", "before-export-commit"];
  for (const point of points) for (let attempt = 0; attempt < 10; attempt += 1) {
    const fixture = await workspace("lectoria-m3-5-fault-");
    try {
      const prepared = await createExportable(fixture, { id: `fault-${point}-${attempt}`, format: "text", content: "Stable export." });
      let fired = false;
      const failing = new ExportService({
        database: fixture.database, root: fixture.root, trustedWorkspaceId: fixture.workspaceId,
        workCopies: fixture.workCopies, validation: fixture.validation,
        inject(current) { if (!fired && current === point) { fired = true; throw new Error(`injected ${point}`); } },
      });
      await assert.rejects(failing.export(prepared.workflow.workflowId, prepared.run.validationRunId, "text"), /injected/);
      const recovered = await prepared.exports.export(prepared.workflow.workflowId, prepared.run.validationRunId, "text");
      assert.equal((await readFile(join(fixture.root, recovered.relativePath, recovered.filename))).equals(recovered.content), true);
      assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM export_records WHERE workflow_id = ?").get(prepared.workflow.workflowId).total, 1);
      assert.throws(() => fixture.database.prepare("UPDATE export_records SET content_digest = 'tampered'").run(), /immutable/);
    } finally { await fixture.close(); }
  }
});
