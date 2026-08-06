import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { runAgentHostProcess } from "../../src/agent/host-process.mjs";
import { agentDigest } from "../../src/agent/host-protocol.mjs";

const piUsage = (input, output) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const budgetUsage = (inputTokens = 10, outputTokens = 3) => ({ calls: 1, inputTokens, outputTokens, costMicrosCny: 100, costMicrosUsd: 0, durationMs: 1 });
const assistant = (content, stopReason, responseId) => ({ role: "assistant", content, api: "openai-completions", provider: "deepseek", model: "deepseek-chat",
  responseId, usage: piUsage(10, 3), stopReason, timestamp: 0 });
const attempt = (toolNames = ["calculate_number"]) => ({ attemptId: randomUUID(), taskId: randomUUID(), providerId: "deepseek", modelId: "deepseek-chat",
  targetLanguage: "zh-CN", sourceText: "焦点距離は50mmです。", protected: [], toolNames, maxOutputTokens: 1024 });

function ledger() { const facts = { calls: [], outcomes: [], checkpoints: [], final: null }; return { facts,
  beginCall(value) { facts.calls.push(value); return value; }, completeCall(id, value) { facts.outcomes.push({ id, ...value }); }, markUnknown(id) { facts.outcomes.push({ id, outcome: "unknown" }); },
  acceptCheckpoint(_id, value) { const accepted = { ...value, transcriptDigest: agentDigest(value.messages) }; facts.checkpoints.push(accepted); return accepted; },
  acceptFinal(_id, value) { facts.final = value.final; return { final: value.final }; } }; }

test("production Pi Host executes a trusted local tool, checkpoints both turns, and returns a ledger-bound final without Faux", async () => {
  const current = attempt(); const store = ledger(); let round = 0; const toolCalls = [];
  let result; try { result = await runAgentHostProcess({ attempt: current, ledger: store,
    invokeRound: async () => ++round === 1 ? { responseId: "one", assistantMessage: assistant([{ type: "toolCall", id: "number-1", name: "calculate_number",
      arguments: { schemaVersion: "number-calculation-request-v1", operation: "convert-unit", value: "50", from: "mm", to: "cm", precision: 2, rounding: "half-even" } }], "toolUse", "one"), usage: budgetUsage() }
      : { responseId: "two", assistantMessage: assistant([{ type: "text", text: "{\"translation\":\"焦距为50毫米。\"}" }], "stop", "two"), usage: budgetUsage(20, 8) },
    executeTool: async (request) => { toolCalls.push(request.toolName); return { result: { content: [{ type: "text", text: "{\"formattedValue\":\"5.00\"}" }], details: { exact: true } },
      cacheHit: false, receiptDigest: `sha256:${"b".repeat(64)}` }; } }); } catch (error) { throw new Error(`${error.message}: ${JSON.stringify(store.facts)}`); }
  assert.deepEqual(result.final, { translation: "焦距为50毫米。" });
  assert.deepEqual(toolCalls, ["calculate_number"]);
  assert.deepEqual(store.facts.calls.map((value) => value.kind), ["provider", "local-tool", "provider"]);
  assert.equal(store.facts.checkpoints.length, 2);
  assert.equal(store.facts.final.translation, "焦距为50毫米。");
  assert.deepEqual(result.providerUsage, { calls: 2, inputTokens: 30, outputTokens: 11, costMicrosCny: 200, costMicrosUsd: 0, durationMs: 2 });
});

test("tool-disabled Host exposes no tools and performs exactly one model round", async () => {
  const current = attempt([]); const store = ledger(); let rounds = 0; let tools = 0;
  const result = await runAgentHostProcess({ attempt: current, ledger: store,
    invokeRound: async (request) => { rounds += 1; assert.deepEqual(request.toolNames, []); return { responseId: "final",
      assistantMessage: assistant([{ type: "text", text: "{\"translation\":\"无工具译文\"}" }], "stop", "final"), usage: budgetUsage() }; },
    executeTool: async () => { tools += 1; throw new Error("unreachable"); } });
  assert.equal(rounds, 1); assert.equal(tools, 0); assert.equal(result.final.translation, "无工具译文");
});
