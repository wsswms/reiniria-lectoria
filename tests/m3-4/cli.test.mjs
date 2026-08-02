import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowApi } from "../../src/application/workflow-api.mjs";
import { runWorkflowCli } from "../../src/cli/workflow-cli.mjs";

test("CLI parses commands and delegates all storage work to the workflow API", () => {
  const calls = [];
  const api = { execute(command, payload) { calls.push({ command, payload }); return { ok: true }; } };
  assert.deepEqual(runWorkflowCli(api, ["validate", '{"workflowId":"workflow"}']), { ok: true });
  assert.deepEqual(calls, [{ command: "validate", payload: { workflowId: "workflow" } }]);
  assert.throws(() => runWorkflowCli(api, ["validate", "not-json"]), /valid JSON/);
  assert.throws(() => runWorkflowCli(api, ["validate"]), /usage/);
});

test("workflow API exposes only service operations and rejects unknown commands", () => {
  const api = new WorkflowApi({
    imports: {}, reimports: {}, flowPlans: {}, exports: {},
    workCopies: { listCandidates() {}, selectCandidate() {}, edit() {}, getBundle() {} },
    validation: { run() {} },
    reviews: { confirmWarning() {}, humanReview() {}, approve() {} },
  });
  const payload = { workflowId: "w", segmentId: "s", text: "t", actor: { type: "user", id: "u" } };
  for (const command of ["candidate:add", "internet:create", "internet:search", "internet:fetch", "proposal:create",
    "proposal:decide", "proposal:apply", "quality:run-working", "quality:compare"])
    assert.throws(() => api.execute(command, payload), /unknown workflow command/, command);
  assert.throws(() => api.execute("sqlite:query", {}), /unknown workflow command/);
});

test("workflow API derives workflow scope from a confirmed import", () => {
  const calls = [];
  const imported = { confirmed: true, documentId: "trusted-document", sourceRevisionId: "trusted-revision" };
  const api = new WorkflowApi({
    imports: { get(importId) { calls.push(["import:get", importId]); return imported; } },
    flowPlans: { create(identity, by) { calls.push(["workflow:create", identity, by]); return identity; } },
    reimports: {}, workCopies: {}, validation: {}, reviews: {}, exports: {},
  });
  const result = api.execute("workflow:create", {
    importId: "trusted-import", workflowId: "workflow", targetLanguage: "fr",
    actor: { type: "user", id: "owner" },
    documentId: "forged-document", sourceRevisionId: "forged-revision",
  });
  assert.deepEqual(result, {
    workflowId: "workflow", documentId: "trusted-document", sourceRevisionId: "trusted-revision", targetLanguage: "fr", plannerEnabled: true,
  });
  assert.deepEqual(calls, [
    ["import:get", "trusted-import"],
    ["workflow:create", { ...result, plannerEnabled: true }, { type: "user", id: "owner" }],
  ]);
  imported.confirmed = false;
  assert.throws(() => api.execute("workflow:create", { importId: "trusted-import", workflowId: "other", targetLanguage: "de" }), /confirmed/);
});
