import assert from "node:assert/strict";
import test from "node:test";
import { classifyLexicalAuditEvents, lexicalAuditUsage, lexicalRunnableTasks } from "../../src/m5e/lexical-experiment-recovery.mjs";

test("lexical recovery treats request as consumed and never reissues request-only unknown outcomes", () => {
  assert.deepEqual(classifyLexicalAuditEvents([]), { consumed: false, status: "not-started" });
  assert.deepEqual(classifyLexicalAuditEvents([{ event: "request" }]), { consumed: true, status: "unknown" });
  assert.deepEqual(classifyLexicalAuditEvents([{ event: "request" }, { event: "response", outcome: { normalized: false } }]),
    { consumed: true, status: "failed" });
  assert.deepEqual(classifyLexicalAuditEvents([{ event: "request" }, { event: "response",
    outcome: { normalized: false, error: { category: "unknown-outcome" } } }]), { consumed: true, status: "unknown" });
  assert.deepEqual(classifyLexicalAuditEvents([{ event: "request" }, { event: "response", outcome: { normalized: true } }]),
    { consumed: true, status: "completed" });
  assert.throws(() => classifyLexicalAuditEvents([{ event: "response" }]), /sequence/u);
  assert.throws(() => classifyLexicalAuditEvents([{ event: "request" }, { event: "request" }]), /sequence/u);
});

test("lexical recovery preserves frozen task ids and isolates a failed dependency", () => {
  const tasks = [
    { taskId: "a1", sequence: 1, dependencyTaskIds: [] },
    { taskId: "a2", sequence: 2, dependencyTaskIds: [] },
    { taskId: "b1", sequence: 3, dependencyTaskIds: ["a1"] },
    { taskId: "b2", sequence: 4, dependencyTaskIds: ["a2"] },
  ];
  const states = new Map([["a1", "failed"], ["a2", "completed"]]);
  assert.deepEqual(lexicalRunnableTasks(tasks, states).map((item) => item.taskId), ["b2"]);
  states.set("b2", "completed"); assert.deepEqual(lexicalRunnableTasks(tasks, states), []);
});

test("lexical recovery does not spin on a local pre-request failure in the same process", () => {
  const tasks = [{ taskId: "a1", sequence: 1, dependencyTaskIds: [] }, { taskId: "a2", sequence: 2, dependencyTaskIds: [] }];
  const attempted = new Set(["a1"]);
  assert.deepEqual(lexicalRunnableTasks(tasks, new Map(), attempted).map((item) => item.taskId), ["a2"]);
  attempted.add("a2"); assert.deepEqual(lexicalRunnableTasks(tasks, new Map(), attempted), []);
});

test("lexical recovery accounts valid usage and reserves unknown exposure for malformed provider usage", () => {
  const valid = lexicalAuditUsage([{ event: "request" }, { event: "response", elapsedMs: 25, response: { usage: {
    prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, completion_tokens_details: { reasoning_tokens: 7 },
  } } }]);
  assert.deepEqual(valid, { calls: 1, inputTokens: 10, outputTokens: 20, reasoningTokens: 7, totalTokens: 30,
    costMicrosCny: 140, durationMs: 25 });
  assert.equal(lexicalAuditUsage([{ event: "request" }]), null);
  assert.equal(lexicalAuditUsage([{ event: "request" }, { event: "response", response: { usage: {
    prompt_tokens: 10, completion_tokens: 20, total_tokens: 31,
  } } }]), null);
});
