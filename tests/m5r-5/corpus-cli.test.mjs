import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { WorkflowApi } from "../../src/application/workflow-api.mjs";
import { runWorkflowCli } from "../../src/cli/workflow-cli.mjs";
import { ReimportService } from "../../src/document/reimport-service.mjs";
import { ExportService } from "../../src/export/export-service.mjs";
import { ResearchFoundationService } from "../../src/research/foundation-service.mjs";
import { ReviewService } from "../../src/translation/review-service.mjs";
import { stableJson } from "../../src/domain/contracts.mjs";
import { m5r5Corpus, m5r5CorpusManifest } from "../fixtures/m5r-5/corpus.mjs";
import { workspace } from "../m3-4/helpers.mjs";
import { enqueueInput, orchestrator } from "../m4-3/helpers.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const user = Object.freeze({ type: "user", id: "m5r-5-user" });

test("the fixed M5R.5 corpus has six balanced directions across three formats", () => {
  assert.equal(m5r5CorpusManifest.documents, 18); assert.equal(m5r5CorpusManifest.directions.length, 6);
  assert.deepEqual([...new Set(m5r5Corpus.map((item) => item.format))].sort(), ["html", "markdown", "text"]);
  for (const direction of m5r5CorpusManifest.directions) assert.equal(m5r5Corpus.filter(
    (item) => `${item.sourceLanguage}->${item.targetLanguage}` === direction).length, 3);
  assert.equal(new Set(m5r5Corpus.map((item) => item.id)).size, 18);
  assert.equal(m5r5Corpus.every((item) => item.dataClass === "public-synthetic"), true);
  assert.equal(sha(stableJson(m5r5Corpus)).length, 71);
});

test("eighteen documents complete the unified CLI and each receives an explicit user ResearchRequest decision", async () => {
  const fixture = await workspace("lectoria-m5r-5-corpus-"); const now = () => new Date(0);
  try {
    fixture.clock = { now, advance() {} };
    const exports = new ExportService({ database: fixture.database, root: fixture.root, trustedWorkspaceId: fixture.workspaceId,
      workCopies: fixture.workCopies, validation: fixture.validation, now });
    const reviews = new ReviewService(fixture.database, fixture.workspaceId, { now, validation: fixture.validation });
    const api = new WorkflowApi({ imports: fixture.imports,
      reimports: new ReimportService({ database: fixture.database, root: fixture.root, trustedWorkspaceId: fixture.workspaceId, now }),
      states: fixture.states, workCopies: fixture.workCopies, validation: fixture.validation, reviews, exports });
    const foundation = new ResearchFoundationService(fixture.database, fixture.workspaceId, { now });
    const decisions = ["approved", "rejected", "canceled"];
    let completed = 0;
    for (const [index, source] of m5r5Corpus.entries()) {
      const imported = await runWorkflowCli(api, ["document:import", JSON.stringify(source)]);
      runWorkflowCli(api, ["document:confirm", JSON.stringify({ importId: imported.importId, actor: user })]);
      const workflowId = randomUUID();
      runWorkflowCli(api, ["workflow:create", JSON.stringify({ importId: imported.importId, workflowId, targetLanguage: source.targetLanguage })]);
      const bundle = runWorkflowCli(api, ["working-copy:get", JSON.stringify({ workflowId })]);
      const segmentIds = [bundle.segments[0].segmentId];
      const task = orchestrator(fixture).enqueue(enqueueInput({ workflowId, documentId: imported.documentId,
        sourceRevisionId: imported.sourceRevisionId, targetLanguage: source.targetLanguage, segmentId: segmentIds[0] }, `m5r-5:${source.id}`));
      const request = { schemaVersion: "1.0", requestId: randomUUID(), revisionId: randomUUID(), taskId: task.task.task_id,
        workflowId, documentId: imported.documentId, sourceRevisionId: imported.sourceRevisionId, targetLanguage: source.targetLanguage,
        segmentIds, gapKinds: ["term"], questions: [`Confirm the public workspace term for ${source.id}`],
        localEvidenceDigest: sha(source.id), origin: user, createdAt: now().toISOString() };
      foundation.createRequest(request, user); foundation.submitRequest(request.requestId, 0, user);
      const decision = decisions[index % decisions.length]; foundation.decideRequest(request.requestId, 1, decision, user);
      for (const segment of bundle.segments) {
        const candidate = runWorkflowCli(api, ["candidate:add", JSON.stringify({ workflowId, segmentId: segment.segmentId,
          text: segment.sourceText, actor: { type: "fixture", id: "m5r-5-candidate" } })]);
        runWorkflowCli(api, ["candidate:select", JSON.stringify({ workflowId, segmentId: segment.segmentId,
          candidateId: candidate.candidateId, expectedHeadVersion: null, actor: user })]);
      }
      const validation = runWorkflowCli(api, ["validate", JSON.stringify({ workflowId })]);
      for (const finding of validation.findings.filter((item) => item.severity === "warning")) runWorkflowCli(api,
        ["warning:confirm", JSON.stringify({ workflowId, validationRunId: validation.validationRunId, findingId: finding.findingId, actor: user })]);
      runWorkflowCli(api, ["review", JSON.stringify({ workflowId, validationRunId: validation.validationRunId, expectedWorkflowVersion: 0, actor: user })]);
      runWorkflowCli(api, ["approve", JSON.stringify({ workflowId, validationRunId: validation.validationRunId, expectedWorkflowVersion: 1, actor: user })]);
      const ordinary = await runWorkflowCli(api, ["export", JSON.stringify({ workflowId, validationRunId: validation.validationRunId, format: source.format })]);
      const canonical = await runWorkflowCli(api, ["export", JSON.stringify({ workflowId, validationRunId: validation.validationRunId, format: "canonical" })]);
      assert.equal(ordinary.manifest.artifact_format, source.format); assert.equal(canonical.manifest.artifact_format, "canonical");
      assert.equal(foundation.getRequest(request.requestId).head.state, decision); completed += 1;
    }
    assert.equal(completed, 18);
    const rows = fixture.database.prepare("SELECT decision, count(*) AS count FROM research_request_decisions WHERE workspace_id = ? GROUP BY decision ORDER BY decision")
      .all(fixture.workspaceId);
    assert.deepEqual(rows, [{ decision: "approved", count: 6 }, { decision: "canceled", count: 6 }, { decision: "rejected", count: 6 }]);
    assert.equal(fixture.database.pragma("foreign_key_check").length, 0);
  } finally { await fixture.close(); }
});
