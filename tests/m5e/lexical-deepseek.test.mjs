import assert from "node:assert/strict";
import test from "node:test";
import { assembleDetectorV3Coverage } from "../../src/m5e/detector-v3.mjs";
import {
  invokeM5ELexicalStageADeepSeek,
  invokeM5ELexicalStageBDeepSeek,
} from "../../scripts/m5e-lexical-deepseek.mjs";

const IDS = Object.freeze({
  document: "20000000-0000-4000-8000-000000000001",
  first: "20000000-0000-4000-8000-000000000002",
  second: "20000000-0000-4000-8000-000000000003",
  fact: "20000000-0000-4000-8000-000000000004",
  revision: "20000000-0000-4000-8000-000000000005",
});
const document = Object.freeze({ schemaVersion: "m5e-detector-document-v1", documentId: IDS.document,
  language: "ja", targetLanguage: "zh-CN", title: "光学設計", segments: Object.freeze([
    Object.freeze({ segmentId: IDS.first, sourceText: "倍率色収差を補正する。", structuralRole: "paragraph" }),
    Object.freeze({ segmentId: IDS.second, sourceText: "球面収差と倍率色収差。", structuralRole: "paragraph" }),
  ]) });
const approvedTerms = Object.freeze([Object.freeze({ factId: IDS.fact, revisionId: IDS.revision,
  contentDigest: `sha256:${"a".repeat(64)}`, retrieverVersion: "fts-v1", state: "active", kind: "term", language: "ja",
  targetLanguages: Object.freeze(["zh-CN"]), term: "倍率色収差",
  preferredTranslations: Object.freeze([Object.freeze({ language: "zh-CN", text: "倍率色差" })]), variants: Object.freeze([]) })]);
const retriever = Object.freeze({ manifest: () => Object.freeze({ factSetDigest: `sha256:${"b".repeat(64)}`, retrieverVersion: "fts-v1" }),
  search: () => Object.freeze([]) });
const coverage = assembleDetectorV3Coverage({ document, approvedTerms, retriever });

function response(content, { usage = { prompt_tokens: 11, completion_tokens: 19, total_tokens: 30,
  completion_tokens_details: { reasoning_tokens: 7 } }, bodyFailure = null } = {}) {
  const raw = JSON.stringify({ id: "response-1", choices: [{ index: 0, finish_reason: "stop",
    message: { content, reasoning_content: "private reasoning" } }], usage });
  return { ok: true, status: 200, headers: { get: () => null, entries: () => [["x-request-id", "request-1"]] },
    arrayBuffer: async () => { if (bodyFailure) throw bodyFailure; return Buffer.from(raw); } };
}

test("Lexical Stage A adapter fixes provider controls, normalizes payload, usage, and complete audit", async () => {
  const requests = []; const events = [];
  const result = await invokeM5ELexicalStageADeepSeek({ coverage, approvedTerms, modelId: "deepseek-v4-flash",
    maxOutputTokens: 65_536, maximumAttempts: 1 }, { credential: "fixture-key", audit: (event) => events.push(event),
    fetchImpl: async (url, request) => { requests.push({ url, request });
      return response(JSON.stringify({ items: [{ quotes: ["倍率色収差"] }, { quotes: ["球面収差"] }] })); } });
  assert.equal(requests.length, 1); assert.equal(requests[0].url, "https://api.deepseek.com/chat/completions");
  const body = JSON.parse(requests[0].request.body);
  assert.deepEqual(body.thinking, { type: "enabled" }); assert.equal(body.temperature, 1);
  assert.deepEqual(body.response_format, { type: "json_object" }); assert.equal(body.max_tokens, 65_536);
  assert.equal(body.stream, false); assert.equal(requests[0].request.redirect, "error");
  assert.equal(result.candidates.length, 2); assert.equal(result.usage.calls, 1);
  assert.equal(result.usage.inputTokens, 11); assert.equal(result.usage.outputTokens, 19);
  assert.equal(result.usage.reasoningTokens, 7); assert.equal(result.usage.totalTokens, 30);
  assert.equal(result.usage.costMicrosCny, Math.ceil((11 * 28 + 19 * 56) / 10));
  assert.deepEqual(events.map((event) => event.event), ["request", "response"]);
  assert.equal(events[0].role, "planner-lexical-stage-a"); assert.equal(events[0].thinking, "enabled");
  assert.equal(events[0].temperature, 1); assert.equal(events[0].maximumAttempts, 1);
  assert.deepEqual(events[0].request.body, body); assert.equal(events[0].request.headers.authorization, undefined);
  assert.equal(events[1].response.content.includes("球面収差"), true);
  assert.equal(events[1].response.reasoningContent, "private reasoning");
  assert.deepEqual(events[1].response.usage.completion_tokens_details, { reasoning_tokens: 7 });
  assert.deepEqual(events[1].outcome, { normalized: true });
});

test("Lexical Stage B adapter accepts only one attempt and never retries malformed billed output", async () => {
  const stageAResult = await invokeM5ELexicalStageADeepSeek({ coverage, approvedTerms, modelId: "deepseek-v4-flash",
    maxOutputTokens: 4096, maximumAttempts: 1 }, { credential: "fixture-key",
    fetchImpl: async () => response(JSON.stringify({ items: [{ quotes: ["球面収差"] }] })) });
  const requests = [];
  const success = await invokeM5ELexicalStageBDeepSeek({ stageAResult, modelId: "deepseek-v4-flash",
    maxOutputTokens: 4096, maximumAttempts: 1 }, { credential: "fixture-key", fetchImpl: async (_url, request) => {
      requests.push(JSON.parse(request.body)); return response(JSON.stringify({ groups: [{ memberIds: ["c001"], decision: "research",
        priority: "high", needs: [{ researchGoal: "确认球面像差的规范中文译法" }] }] })); } });
  assert.equal(requests.length, 1); assert.deepEqual(requests[0].thinking, { type: "enabled" });
  assert.equal(JSON.parse(requests[0].messages[1].content).candidates[0].ref, "c001");
  assert.equal(success.groups[0].memberCandidateIds[0], stageAResult.candidates[0].candidateId);
  assert.equal(success.groups[0].needs[0].researchGoal, "确认球面像差的规范中文译法"); assert.equal(success.usage.calls, 1);
  let calls = 0; const events = [];
  await assert.rejects(() => invokeM5ELexicalStageBDeepSeek({ stageAResult, modelId: "deepseek-v4-flash",
    maxOutputTokens: 4096, maximumAttempts: 1 }, { credential: "fixture-key", audit: (event) => events.push(event),
    fetchImpl: async () => { calls += 1; return response("{"); } }),
  (error) => error.category === "malformed-response" && error.providerCode === "payload-json" && error.retryable === false);
  assert.equal(calls, 1); assert.equal(events.length, 2); assert.equal(events[1].outcome.willRetry, false);
  assert.throws(() => invokeM5ELexicalStageBDeepSeek({ stageAResult, modelId: "deepseek-v4-flash",
    maxOutputTokens: 4096, maximumAttempts: 2 }, { credential: "fixture-key" }), /configuration is invalid/);
  assert.throws(() => invokeM5ELexicalStageBDeepSeek({ stageAResult, modelId: "deepseek-v4-flash",
    maxOutputTokens: 65_537, maximumAttempts: 1 }, { credential: "fixture-key" }), /configuration is invalid/);
});

test("Lexical adapters fail closed on strict usage and classify response-body failures as unknown", async () => {
  await assert.rejects(() => invokeM5ELexicalStageADeepSeek({ coverage, approvedTerms, modelId: "deepseek-v4-flash",
    maxOutputTokens: 4096, maximumAttempts: 1 }, { credential: "fixture-key", fetchImpl: async () => response("{}", {
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 4 } }) }),
  (error) => error.category === "malformed-response" && error.providerCode === "usage");
  let calls = 0;
  await assert.rejects(() => invokeM5ELexicalStageADeepSeek({ coverage, approvedTerms, modelId: "deepseek-v4-flash",
    maxOutputTokens: 4096, maximumAttempts: 1 }, { credential: "fixture-key", fetchImpl: async () => {
      calls += 1; return response("{}", { bodyFailure: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }) }); } }),
  (error) => error.category === "unknown-outcome" && error.providerCode === "ECONNRESET" && error.retryable === false);
  assert.equal(calls, 1);
});
