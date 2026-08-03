import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildM5CDeepSeekRoleRequest, M5CDeepSeekRoleAdapter, M5C_DEEPSEEK_PRICING,
  normalizeM5CDeepSeekRoleResponse } from "../../src/m5c/deepseek-role-adapter.mjs";
import { invokeM5CModelBroker } from "../../src/m5c/model-broker-process.mjs";

const segmentId = randomUUID();
const planner = { role: "planner", modelId: "deepseek-v4-flash", maxOutputTokens: 2_048, request: {
  schemaVersion: "m5c-planner-request-v1", workflowId: randomUUID(), documentId: randomUUID(), sourceRevisionId: randomUUID(),
  targetLanguage: "zh-CN", localPlanDigest: `sha256:${"0".repeat(64)}`, localItems: [{ itemId: randomUUID(), kind: "term",
    coverage: "uncovered", instructionType: "preferred", impact: "high", segmentIds: [segmentId], dependencies: {}, content: { term: "fixture" } }],
} };
const qa = { role: "qa", modelId: "deepseek-v4-flash", maxOutputTokens: 2_048, request: {
  schemaVersion: "m5c-model-qa-request-v1", workflowId: randomUUID(), sourceRevisionId: randomUUID(), targetLanguage: "zh-CN",
  workingCopyDigest: `sha256:${"1".repeat(64)}`, scope: "full", segments: [{ segmentId, sourceText: "3枚", targetText: "3片", targetDigest: `sha256:${"2".repeat(64)}` }],
} };

function response(content) { return { id: "response-fixture", choices: [{ index: 0, finish_reason: "stop", message: { content: JSON.stringify(content) } }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }; }

test("DeepSeek role adapter fixes the M5C planner and QA origin prompt bounds and conservative CNY pricing", () => {
  for (const input of [planner, qa]) {
    const outbound = buildM5CDeepSeekRoleRequest(input); assert.equal(outbound.url, "https://api.deepseek.com/chat/completions");
    assert.equal(outbound.body.model, "deepseek-v4-flash"); assert.deepEqual(outbound.body.thinking, { type: "disabled" });
    assert.equal(outbound.body.temperature, 0); assert.equal(outbound.body.max_tokens, 2_048); assert.equal(outbound.body.stream, false);
  }
  assert.deepEqual(buildM5CDeepSeekRoleRequest({ ...qa, thinking: "enabled" }).body.thinking, { type: "enabled" });
  assert.throws(() => buildM5CDeepSeekRoleRequest({ ...qa, thinking: "automatic" }), /M5C DeepSeek role invocation failed/);
  assert.throws(() => buildM5CDeepSeekRoleRequest({ ...planner, thinking: "enabled" }), /M5C DeepSeek role invocation failed/);
  assert.equal(buildM5CDeepSeekRoleRequest({ ...planner, maxOutputTokens: 65_536 }).body.max_tokens, 65_536);
  assert.throws(() => buildM5CDeepSeekRoleRequest({ ...planner, maxOutputTokens: 65_537 }), /M5C DeepSeek role invocation failed/);
  assert.equal(buildM5CDeepSeekRoleRequest({ ...planner, maxOutputTokens: 384_000,
    evaluationScope: "m5c-real-article-audit-v1" }).body.max_tokens, 384_000);
  assert.throws(() => buildM5CDeepSeekRoleRequest({ ...planner, maxOutputTokens: 384_001,
    evaluationScope: "m5c-real-article-audit-v1" }), /M5C DeepSeek role invocation failed/);
  assert.deepEqual(M5C_DEEPSEEK_PRICING, { version: "deepseek-v4-flash-2026-08-03-conservative-cny-v1", sourceCurrency: "USD",
    inputUsdPerMillion: 0.14, outputUsdPerMillion: 0.28, cnyPerUsdCeiling: 10, peakMultiplierCeiling: 2 });
});

test("planner and QA responses are role-bound normalized and charged with the conservative peak ceiling", () => {
  const planned = normalizeM5CDeepSeekRoleResponse(response({ items: [{ kind: "term", coverage: "uncovered", instructionType: "preferred",
    impact: "high", segmentIds: [segmentId], dependencies: {}, content: { term: "fixture" } }], researchScope: {}, qaProfile: {} }), planner);
  assert.equal(planned.items.length, 1); assert.equal(planned.usage.costMicrosCny, 392);
  const checked = normalizeM5CDeepSeekRoleResponse(response({ findings: [{ segmentId, severity: "warning", code: "terminology-risk", details: { note: "fixture" } }] }), qa);
  assert.equal(checked.findings[0].code, "terminology-risk"); assert.equal(checked.usage.costMicrosUsd, 0);
  assert.throws(() => normalizeM5CDeepSeekRoleResponse(response({ findings: [{ segmentId: randomUUID(), severity: "warning", code: "forged", details: {} }] }), qa), /M5C DeepSeek role invocation failed/);
});

test("role adapter and Broker fail closed on credentials identity malformed output and disconnects", async () => {
  assert.throws(() => invokeM5CModelBroker({ request: qa, credentialFd: 3, credentialRef: "forged" }), /credential scope/);
  await assert.rejects(new M5CDeepSeekRoleAdapter({ fetchImpl: async () => new Response("private upstream body", { status: 401 }) }).invoke(qa, { credential: "fixture-secret" }),
    (error) => error.category === "auth" && !String(error).includes("fixture-secret") && !String(error).includes("private upstream"));
  await assert.rejects(new M5CDeepSeekRoleAdapter({ fetchImpl: async () => { throw new Error("private socket detail"); } }).invoke(qa, { credential: "fixture-secret" }),
    (error) => error.category === "unknown-outcome" && error.retryable === false);
  await assert.rejects(new M5CDeepSeekRoleAdapter({ fetchImpl: async () => new Response("not-json", { status: 200 }) }).invoke(qa, { credential: "fixture-secret" }),
    (error) => error.category === "malformed-response");
});

test("role adapter audits full requests raw responses reasoning usage and malformed outcomes without credentials", async () => {
  const secret = `ROLE-AUDIT-SECRET-${randomUUID()}`; const records = [];
  const raw = response({ findings: [] }); raw.choices[0].message.reasoning_content = "private reasoning trace";
  const adapter = new M5CDeepSeekRoleAdapter({ fetchImpl: async () => new Response(JSON.stringify(raw), { status: 200,
    headers: { "x-request-id": "request-audit-fixture" } }), audit: (record) => records.push(record) });
  await adapter.invoke(qa, { credential: secret });
  assert.equal(records.length, 2); assert.equal(records[0].event, "request"); assert.equal(records[1].response.reasoningContent, "private reasoning trace");
  assert.equal(records[1].response.finishReason, "stop"); assert.deepEqual(records[1].response.usage, raw.usage);
  assert.equal(records[1].outcome.normalized, true); assert.equal(records[0].request.body.messages.length, 2);
  assert.equal(JSON.stringify(records).includes(secret), false); assert.equal(JSON.stringify(records).includes("authorization"), false);

  const malformed = [];
  await assert.rejects(new M5CDeepSeekRoleAdapter({ fetchImpl: async () => new Response("not-json", { status: 200 }),
    audit: (record) => malformed.push(record) }).invoke(qa, { credential: secret }), (error) => error.category === "malformed-response");
  assert.equal(malformed.length, 2); assert.equal(malformed[1].response.rawBody, "not-json");
  assert.equal(malformed[1].outcome.normalized, false); assert.equal(malformed[1].outcome.error.category, "malformed-response");
});

test("M5C model Broker passes private audit fd 4 and records auth failures before any network call", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-model-broker-audit-")); const credentialPath = join(root, "key"); const auditPath = join(root, "call.jsonl");
  let credentialHandle; let auditHandle;
  try {
    await writeFile(credentialPath, "invalid credential with spaces\n", { mode: 0o600 }); credentialHandle = await open(credentialPath, "r"); auditHandle = await open(auditPath, "wx", 0o600);
    await assert.rejects(invokeM5CModelBroker({ request: qa, credentialFd: credentialHandle.fd, auditFd: auditHandle.fd }),
      (error) => error.category === "auth"); await auditHandle.close(); auditHandle = undefined;
    const text = await readFile(auditPath, "utf8"); const events = text.trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.map((event) => event.event), ["request", "response"]); assert.equal(text.includes("invalid credential"), false);
    assert.equal(text.includes("authorization"), false); assert.equal(events[1].outcome.error.category, "auth");
  } finally { await auditHandle?.close(); await credentialHandle?.close(); await rm(root, { recursive: true, force: true }); }
});
