import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  ProtocolError,
  digestJson,
  strictHostRequest,
  strictParentMessage,
} from "./spike/protocol.mjs";
import { runSpikeHost } from "./spike/controller.mjs";

const attempt = () => Object.freeze({
  attemptId: randomUUID(),
  taskId: randomUUID(),
  providerId: "deepseek",
  modelId: "deepseek-chat",
  sourceLanguage: "ja",
  targetLanguage: "zh-CN",
  sourceText: "焦点距離は50mmです。",
});

const finalMessage = (text = "焦距为50毫米。") => fauxAssistantMessage(JSON.stringify({ translation: text }));
const resultFor = (request) => Object.freeze({
  content: [{ type: "text", text: JSON.stringify({ answer: `${request.toolName}:${request.arguments.query ?? request.arguments.value}` }) }],
  details: { source: "offline-fixture" },
});

test("Pi executes a three-tool batch sequentially, replays cached calls, and checkpoints every complete turn", async () => {
  const calls = [];
  const repeated = { query: "焦点距離" };
  const outcome = await runSpikeHost({
    attempt: attempt(),
    providerFixtures: [
      fauxAssistantMessage([
        fauxToolCall("lookup_dictionary", repeated, { id: "call-dictionary-1" }),
        fauxToolCall("lookup_entity", { query: "NIKKOR" }, { id: "call-entity-1" }),
        fauxToolCall("calculate_number", { operation: "unit", value: "50", from: "mm", to: "cm" }, { id: "call-number-1" }),
      ]),
      fauxAssistantMessage([
        fauxToolCall("lookup_dictionary", repeated, { id: "call-dictionary-2" }),
        fauxToolCall("calculate_number", { operation: "unit", value: "50", from: "mm", to: "cm" }, { id: "call-number-2" }),
      ]),
      finalMessage(),
    ],
    executeTool: async (request) => { calls.push(request.toolName); return resultFor(request); },
  });

  assert.equal(outcome.status, "completed", outcome.diagnostics);
  assert.deepEqual(calls, ["lookup_dictionary", "lookup_entity", "calculate_number"]);
  assert.deepEqual(outcome.toolRequests.map((item) => [item.toolName, item.cacheHit]), [
    ["lookup_dictionary", false], ["lookup_entity", false], ["calculate_number", false],
    ["lookup_dictionary", true], ["calculate_number", true],
  ]);
  assert.deepEqual(outcome.checkpoints.map((item) => item.ordinal), [1, 2, 3]);
  assert.deepEqual(outcome.final, { translation: "焦距为50毫米。" });
  assert.match(outcome.transcriptDigest, /^sha256:[a-f0-9]{64}$/u);
});

test("the fourth tool turn terminates only after the whole batch and a distinct no-tool Agent performs final-only", async () => {
  const fixtures = [1, 2, 3, 4].map((ordinal) => fauxAssistantMessage([
    fauxToolCall("lookup_dictionary", { query: `term-${ordinal}` }, { id: `call-${ordinal}-a` }),
    fauxToolCall("lookup_entity", { query: `entity-${ordinal}` }, { id: `call-${ordinal}-b` }),
  ]));
  fixtures.push(finalMessage("最终译文"));
  const outcome = await runSpikeHost({ attempt: attempt(), providerFixtures: fixtures, executeTool: resultFor });

  assert.equal(outcome.status, "completed", outcome.diagnostics);
  assert.equal(outcome.toolRequests.length, 8);
  assert.deepEqual(outcome.providerRequests.map((item) => item.mode), ["normal", "normal", "normal", "normal", "final-only"]);
  assert.notEqual(outcome.providerRequests[3].agentInstanceId, outcome.providerRequests[4].agentInstanceId);
  assert.deepEqual(outcome.providerRequests[4].toolNames, []);
  assert.deepEqual(outcome.final, { translation: "最终译文" });
});

test("DeepSeek offline tool messages round-trip through Pi without loss", async () => {
  const toolArguments = { operation: "unit", value: "12.50", from: "cm", to: "mm" };
  const toolResult = Object.freeze({ content: [{ type: "text", text: "{\"value\":\"125\"}" }], details: { exact: true } });
  let secondContext;
  const outcome = await runSpikeHost({
    attempt: attempt(),
    providerFixtures: [
      fauxAssistantMessage([fauxToolCall("calculate_number", toolArguments, { id: "deepseek-tool-1" })]),
      (request) => { secondContext = request.context; return finalMessage(); },
    ],
    executeTool: async () => toolResult,
  });
  assert.equal(outcome.status, "completed", outcome.diagnostics);
  const call = secondContext.messages.find((message) => message.role === "assistant").content.find((item) => item.type === "toolCall");
  const result = secondContext.messages.find((message) => message.role === "toolResult");
  assert.deepEqual(call.arguments, toolArguments);
  assert.equal(call.id, "deepseek-tool-1");
  assert.equal(result.toolCallId, "deepseek-tool-1");
  assert.deepEqual(result.content, toolResult.content);
});

test("protocol contracts reject forged identity, sequence, correlation, usage, tool, digest, and final fields", () => {
  const base = { version: "m5p-spike-v1", sequence: 1, correlationId: "rpc-1", type: "provider.response", ok: true,
    payload: { attemptId: "attempt", providerId: "deepseek", modelId: "deepseek-chat", ordinal: 1,
      assistantMessage: finalMessage(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      responseDigest: digestJson(finalMessage()) } };
  const mutations = [
    { ...base, sequence: 2 },
    { ...base, correlationId: "rpc-forged" },
    { ...base, payload: { ...base.payload, attemptId: "other" } },
    { ...base, payload: { ...base.payload, providerId: "other" } },
    { ...base, payload: { ...base.payload, usage: { ...base.payload.usage, totalTokens: 99 } } },
    { ...base, payload: { ...base.payload, responseDigest: digestJson("forged") } },
  ];
  for (const mutation of mutations) assert.throws(() => strictParentMessage(mutation, {
    expectedSequence: 1, expectedCorrelationId: "rpc-1", expectedType: "provider.response",
    attemptId: "attempt", providerId: "deepseek", modelId: "deepseek-chat", ordinal: 1,
  }), ProtocolError);

  assert.throws(() => strictHostRequest({ version: "m5p-spike-v1", sequence: 1, correlationId: "rpc-1", type: "tool.request",
    payload: { attemptId: "attempt", toolName: "shell", toolCallId: "call", arguments: {}, requestDigest: digestJson({}) } }), ProtocolError);
  assert.throws(() => strictHostRequest({ version: "m5p-spike-v1", sequence: 1, correlationId: "rpc-1", type: "final.request",
    payload: { attemptId: "attempt", final: { translation: "x", extra: true }, transcriptDigest: digestJson([]) } }), ProtocolError);
  assert.throws(() => strictParentMessage({ version: "m5p-spike-v1", sequence: 1, correlationId: "rpc-1", type: "tool.response", ok: true,
    payload: { attemptId: "attempt", toolName: "lookup_dictionary", toolCallId: "forged", result: { content: [] },
      resultDigest: digestJson({ content: [] }), cacheHit: false } }, { expectedSequence: 1, expectedCorrelationId: "rpc-1",
    expectedType: "tool.response", attemptId: "attempt", toolName: "lookup_dictionary", toolCallId: "actual" }), ProtocolError);
});

test("half-line JSON, duplicate, late, reordered responses and cancel races fail closed with one terminal outcome", async () => {
  for (const fault of ["half-line", "duplicate-response", "late-response", "reordered-response"]) {
    const outcome = await runSpikeHost({ attempt: attempt(), providerFixtures: [finalMessage()], executeTool: resultFor, fault });
    assert.equal(outcome.status, "failed", fault);
    assert.match(outcome.category, /protocol|unknown/u, fault);
    assert.equal(outcome.providerRequests.length, 1, fault);
  }

  for (const race of ["cancel-first", "response-first"]) {
    const outcome = await runSpikeHost({ attempt: attempt(), providerFixtures: [finalMessage()], executeTool: resultFor, fault: race });
    assert.ok(["canceled", "completed"].includes(outcome.status), `${race}: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.terminalEvents, 1);
    if (race === "cancel-first") assert.equal(outcome.status, "canceled");
    if (race === "response-first") assert.equal(outcome.status, "completed");
  }
});

test("SIGTERM, SIGKILL, parent exit, limits, and checkpoint restart never replay an unknown request", async () => {
  for (const fault of ["sigterm", "sigkill", "parent-exit", "output-limit"]) {
    const outcome = await runSpikeHost({ attempt: attempt(), providerFixtures: [finalMessage()], executeTool: resultFor, fault });
    assert.equal(outcome.status, "failed", fault);
    assert.equal(outcome.providerRequests.length, 1, fault);
    assert.equal(outcome.autoRetries, 0, fault);
  }

  const first = await runSpikeHost({
    attempt: attempt(),
    providerFixtures: [
      fauxAssistantMessage([fauxToolCall("lookup_dictionary", { query: "checkpoint" }, { id: "checkpoint-call" })]),
      finalMessage(),
    ],
    executeTool: resultFor,
    fault: "kill-after-checkpoint",
  });
  assert.equal(first.status, "failed");
  assert.equal(first.checkpoints.length, 1);
  const resumed = await runSpikeHost({
    attempt: first.attempt,
    providerFixtures: [finalMessage()],
    executeTool: resultFor,
    resumeCheckpoint: first.checkpoints[0],
  });
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.toolRequests.length, 0);
  assert.equal(resumed.providerRequests.length, 1);
});

test("remote-tool unknown, 64 KiB results, and the eighth-call ceiling fail closed without retries", async () => {
  const oneTool = fauxAssistantMessage([fauxToolCall("lookup_dictionary", { query: "bounded" }, { id: "bounded-call" })]);
  const unknown = await runSpikeHost({ attempt: attempt(), providerFixtures: [oneTool], executeTool: resultFor, fault: "tool-parent-exit" });
  assert.equal(unknown.status, "failed");
  assert.equal(unknown.category, "unknown");
  assert.equal(unknown.toolRequests.length, 1);
  assert.equal(unknown.autoRetries, 0);

  const oversized = await runSpikeHost({ attempt: attempt(), providerFixtures: [oneTool],
    executeTool: async () => ({ content: [{ type: "text", text: "x".repeat(65 * 1024) }], details: {} }) });
  assert.equal(oversized.status, "failed");
  assert.equal(oversized.toolRequests.length, 1);
  assert.equal(oversized.final, null);

  const nineCalls = [1, 2, 3].map((round) => fauxAssistantMessage([1, 2, 3].map((call) =>
    fauxToolCall("lookup_dictionary", { query: `${round}-${call}` }, { id: `limit-${round}-${call}` }))));
  const limited = await runSpikeHost({ attempt: attempt(), providerFixtures: nineCalls, executeTool: resultFor });
  assert.equal(limited.status, "failed");
  assert.equal(limited.toolRequests.length, 8);
  assert.equal(limited.providerRequests.length, 3);
});

test("every normal turn boundary resumes from the accepted checkpoint and four no-tool directions stay compatible", async () => {
  for (let boundary = 1; boundary <= 4; boundary += 1) {
    const currentAttempt = attempt();
    const toolFixtures = Array.from({ length: boundary }, (_, index) => fauxAssistantMessage([
      fauxToolCall("lookup_dictionary", { query: `turn-${index + 1}` }, { id: `turn-call-${index + 1}` }),
    ]));
    const interrupted = await runSpikeHost({ attempt: currentAttempt, providerFixtures: toolFixtures, executeTool: resultFor,
      fault: `kill-after-checkpoint-${boundary}` });
    assert.equal(interrupted.status, "failed", `boundary ${boundary}`);
    assert.equal(interrupted.checkpoints.length, boundary, `boundary ${boundary}`);
    const resumed = await runSpikeHost({ attempt: currentAttempt, providerFixtures: [finalMessage(`resumed-${boundary}`)], executeTool: resultFor,
      resumeCheckpoint: interrupted.checkpoints.at(-1) });
    assert.equal(resumed.status, "completed", resumed.diagnostics);
    assert.equal(resumed.toolRequests.length, 0);
    assert.deepEqual(resumed.final, { translation: `resumed-${boundary}` });
  }

  for (const [sourceLanguage, targetLanguage, translation] of [
    ["en", "zh-CN", "英中"], ["zh-CN", "en", "中英"], ["ja", "zh-CN", "日中"], ["zh-CN", "ja", "中日"],
  ]) {
    const currentAttempt = { ...attempt(), sourceLanguage, targetLanguage };
    const outcome = await runSpikeHost({ attempt: currentAttempt, providerFixtures: [finalMessage(translation)], executeTool: resultFor });
    assert.equal(outcome.status, "completed", outcome.diagnostics);
    assert.equal(outcome.toolRequests.length, 0);
    assert.deepEqual(outcome.final, { translation });
  }
});
