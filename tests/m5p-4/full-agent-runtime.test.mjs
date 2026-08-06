import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentTranslationInvoker } from "../../src/agent/translation-agent-runtime.mjs";
import { DEFAULT_FLOW_BUDGET } from "../../src/m5c/contracts.mjs";
import { FlowPlanService } from "../../src/m5c/flow-plan-service.mjs";
import { providerRequestContract } from "../../src/provider/contracts.mjs";
import { buildContextManifest } from "../../src/provider/prompt-context.mjs";
import { TranslationTaskOrchestrator } from "../../src/provider/task-orchestrator.mjs";
import { TranslationToolConfigurationService } from "../../src/tools/translation-tool-configuration-service.mjs";
import { setup } from "../m5c-1/helpers.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const piUsage = (input, output) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const actual = (inputTokens = 10, outputTokens = 3) => ({ calls: 1, inputTokens, outputTokens, costMicrosCny: 100, costMicrosUsd: 0, durationMs: 1 });
const assistant = (content, stopReason, id) => ({ role: "assistant", content, api: "openai-completions", provider: "deepseek", model: "deepseek-chat",
  responseId: id, usage: piUsage(10, 3), stopReason, timestamp: 0 });

test("real control-plane ledger plus low-privilege Host execute number tool and reconstruct the final candidate deterministically", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5p4-full-")); const seeded = setup(join(root, "app.sqlite3"));
  try {
    const { database, workspaceId } = seeded; const segment = database.prepare("SELECT segment_id AS segmentId FROM source_segment_versions WHERE workspace_id = ? AND source_revision_id = ? ORDER BY ordinal LIMIT 1")
      .get(workspaceId, seeded.sourceRevisionId);
    new FlowPlanService(database, workspaceId).create({ workflowId: seeded.workflowId, documentId: seeded.documentId,
      sourceRevisionId: seeded.sourceRevisionId, targetLanguage: "zh-CN", budget: DEFAULT_FLOW_BUDGET }, { type: "user", id: "fixture-user" });
    const context = buildContextManifest(database, workspaceId, { workflowId: seeded.workflowId, segmentIds: [segment.segmentId] });
    const tasks = new TranslationTaskOrchestrator(database, workspaceId); const queued = tasks.enqueue({ workflowId: seeded.workflowId, documentId: seeded.documentId,
      sourceRevisionId: seeded.sourceRevisionId, targetLanguage: "zh-CN", segmentIds: [segment.segmentId], idempotencyKey: randomUUID(), requestDigest: sha("request"),
      policyVersion: "policy-v1", providerId: "deepseek", modelId: "deepseek-chat", promptVersion: context.manifest.promptVersion,
      contextDigest: context.contextDigest, maxAttempts: 1, batchSize: 1 }); const attempt = queued.attempts[0];
    database.prepare("UPDATE translation_attempts SET state = 'leased', version = version + 1 WHERE workspace_id = ? AND attempt_id = ?").run(workspaceId, attempt.attempt_id);
    database.prepare("UPDATE attempt_runtime_states SET lease_holder = 'agent-worker', lease_expires_at = ?, heartbeat_at = ? WHERE workspace_id = ? AND attempt_id = ?")
      .run(new Date(60_000).toISOString(), new Date(0).toISOString(), workspaceId, attempt.attempt_id);
    database.prepare("UPDATE translation_tasks SET state = 'running', version = version + 1 WHERE workspace_id = ? AND task_id = ?").run(workspaceId, queued.task.task_id);
    database.prepare("UPDATE translation_flow_controls SET flow_state = 'translating' WHERE workspace_id = ? AND workflow_id = ?").run(workspaceId, seeded.workflowId);
    new TranslationToolConfigurationService(database, workspaceId).bind(queued.task.task_id, { schemaVersion: "translation-tool-configuration-v1",
      dictionary: null, entity: null, number: { providerId: "local-number", providerVersion: "local-number-v1", maxCalls: 2 } });
    let round = 0; const invoke = createAgentTranslationInvoker(database, workspaceId, { invokeRound: async () => ++round === 1
      ? { responseId: "tool", assistantMessage: assistant([{ type: "toolCall", id: "number-1", name: "calculate_number", arguments: {
        schemaVersion: "number-calculation-request-v1", operation: "convert-unit", value: "50", from: "mm", to: "cm", precision: 2, rounding: "half-even" } }], "toolUse", "tool"), usage: actual() }
      : { responseId: "final", assistantMessage: assistant([{ type: "text", text: "{\"translation\":\"焦距为50mm。\"}" }], "stop", "final"), usage: actual(20, 8) } });
    const request = providerRequestContract({ workspaceId, taskId: queued.task.task_id, attemptId: attempt.attempt_id, workflowId: seeded.workflowId,
      sourceRevisionId: seeded.sourceRevisionId, targetLanguage: "zh-CN", providerId: "deepseek", modelId: "deepseek-chat", maxOutputTokens: 1024,
      promptVersion: context.manifest.promptVersion, contextDigest: context.contextDigest, segments: context.manifest.segments.map((item) => ({
        segmentId: item.segmentId, sourceDigest: item.sourceDigest, sourceText: item.sourceText, protected: item.protected })) });
    const response = await invoke(request); assert.equal(response.candidates[0].text, "焦距为50mm。"); assert.equal(round, 2);
    assert.deepEqual(database.prepare("SELECT kind FROM agent_runtime_calls ORDER BY call_sequence").all().map((row) => row.kind), ["provider", "local-tool", "provider"]);
    assert.equal(database.prepare("SELECT count(*) AS total FROM agent_runtime_outcomes WHERE outcome = 'completed'").get().total, 3);
    assert.equal(database.prepare("SELECT count(*) AS total FROM agent_runtime_checkpoints WHERE kind = 'turn'").get().total, 2);
    assert.equal(database.prepare("SELECT count(*) AS total FROM agent_runtime_checkpoints WHERE kind = 'final'").get().total, 1);
  } finally { seeded.database.close(); await rm(root, { recursive: true, force: true }); }
});
