import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOUNDED_ADJUDICATION_MAX_ACTUAL_ATTEMPTS,
  BOUNDED_ADJUDICATION_MAX_CONCURRENCY,
  BOUNDED_ADJUDICATION_MAX_COST_MICROS_CNY,
  aggregateCandidateAdjudications,
  boundedAdjudicationBudgetExposure,
  boundedAdjudicationWaveAllowed,
  buildCandidateAdjudicationBody,
  buildCandidateAdjudicationPlan,
  buildGoalConsolidationBody,
  buildGoalConsolidationPlan,
  buildZeroCallBaseline,
  normalizeCandidateAdjudicationPayload,
  normalizeGoalConsolidationPayload,
} from "../../src/m5e/lexical-bounded-adjudication.mjs";
import { invokeM5ECandidateAdjudicationDeepSeek } from "../../scripts/m5e-bounded-adjudication-deepseek.mjs";
import { invokeM5EBoundedBrokerProcess } from "../../scripts/m5e-bounded-adjudication-broker-process.mjs";

const candidate = (ordinal, documentId = "d1") => Object.freeze({
  candidateId: `sha256:${ordinal.toString(16).padStart(64, "0")}`,
  documentId,
  quotes: Object.freeze([Object.freeze({ text: `term-${ordinal}`, occurrences: Object.freeze([
    Object.freeze({ segmentId: `s${Math.ceil(ordinal / 3)}`, start: ordinal, end: ordinal + 2 }),
  ]) })]),
  contexts: Object.freeze([`context-${ordinal}`]),
});

test("bounded adjudication freezes 30 CNY, 32 concurrency, 236 attempts and reserves pending exposure", () => {
  assert.equal(BOUNDED_ADJUDICATION_MAX_COST_MICROS_CNY, 30_000_000);
  assert.equal(BOUNDED_ADJUDICATION_MAX_CONCURRENCY, 32);
  assert.equal(BOUNDED_ADJUDICATION_MAX_ACTUAL_ATTEMPTS, 236);
  assert.equal(boundedAdjudicationBudgetExposure({ knownCostMicrosCny: 1_000_000,
    unknownUsageCalls: 2, pendingCalls: 32 }), 18_000_000);
  assert.equal(boundedAdjudicationWaveAllowed({ knownCostMicrosCny: 13_000_000,
    unknownUsageCalls: 2, pendingCalls: 32 }), true);
  assert.equal(boundedAdjudicationWaveAllowed({ knownCostMicrosCny: 13_000_001,
    unknownUsageCalls: 2, pendingCalls: 32 }), false);
  assert.throws(() => boundedAdjudicationWaveAllowed({ knownCostMicrosCny: 0,
    unknownUsageCalls: 0, pendingCalls: 33 }), /pending/u);
});

test("candidate adjudication produces deterministic source and hash layouts capped at twelve", () => {
  const documents = [
    { documentId: "d1", candidates: Array.from({ length: 25 }, (_, index) => candidate(index + 1)) },
    { documentId: "d2", candidates: Array.from({ length: 13 }, (_, index) => candidate(index + 101, "d2")) },
  ];
  const tasks = buildCandidateAdjudicationPlan(documents);
  assert.equal(tasks.length, 10);
  assert.equal(tasks.filter((item) => item.layout === "source-layout").length, 5);
  assert.equal(tasks.filter((item) => item.layout === "hash-layout").length, 5);
  assert.ok(tasks.every((item) => item.candidates.length <= 12));
  assert.equal(new Set(tasks.flatMap((item) => item.layout === "source-layout"
    ? item.candidates.map((value) => `source:${value.candidateId}`) : [])).size, 38);
  assert.deepEqual(buildCandidateAdjudicationPlan(documents), tasks);
  const body = buildCandidateAdjudicationBody({ task: tasks[0], modelId: "deepseek-v4-pro", maxOutputTokens: 4096 });
  assert.equal(Object.hasOwn(body, "temperature"), false);
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(JSON.parse(body.messages[1].content).candidates.length, tasks[0].candidates.length);
});

test("candidate adjudication payload is an exact ref partition with bounded risk and goal contracts", () => {
  const [task] = buildCandidateAdjudicationPlan([{ documentId: "d1", candidates: [candidate(1), candidate(2)] }]);
  const result = normalizeCandidateAdjudicationPayload({ decisions: [
    { ref: "c001", decision: "research", riskCodes: ["official-form"], goalSeed: "确认官方译名" },
    { ref: "c002", decision: "direct", riskCodes: [], goalSeed: null },
  ] }, task);
  assert.equal(result.decisions[0].candidateId, candidate(1).candidateId);
  assert.throws(() => normalizeCandidateAdjudicationPayload({ decisions: [
    { ref: "c001", decision: "review", riskCodes: ["unknown-risk"], goalSeed: null },
    { ref: "c002", decision: "direct", riskCodes: [], goalSeed: null },
  ] }, task), /risk/u);
  assert.throws(() => normalizeCandidateAdjudicationPayload({ decisions: [
    { ref: "c001", decision: "direct", riskCodes: [], goalSeed: "not allowed" },
    { ref: "c002", decision: "direct", riskCodes: [], goalSeed: null },
  ] }, task), /goal/u);
});

test("dual-layout aggregation is conservative and preserves seed lineage", () => {
  const candidates = [candidate(1), candidate(2), candidate(3)];
  const source = { layout: "source-layout", decisions: [
    { candidateId: candidates[0].candidateId, decision: "direct", riskCodes: [], goalSeed: null },
    { candidateId: candidates[1].candidateId, decision: "research", riskCodes: ["official-form"], goalSeed: "official" },
    { candidateId: candidates[2].candidateId, decision: "review", riskCodes: ["context-insufficient"], goalSeed: null },
  ] };
  const hash = { layout: "hash-layout", decisions: [
    { candidateId: candidates[0].candidateId, decision: "direct", riskCodes: [], goalSeed: null },
    { candidateId: candidates[1].candidateId, decision: "direct", riskCodes: [], goalSeed: null },
    { candidateId: candidates[2].candidateId, decision: "research", riskCodes: ["ambiguous-abbreviation"], goalSeed: "expand" },
  ] };
  const aggregate = aggregateCandidateAdjudications(candidates, [source, hash]);
  assert.deepEqual(aggregate.map((item) => item.decision), ["direct", "research", "research"]);
  assert.deepEqual(aggregate[2].riskCodes, ["ambiguous-abbreviation", "context-insufficient"]);
  assert.deepEqual(aggregate[2].goalSeeds, [{ layout: "hash-layout", value: "expand" }]);
});

test("B0 is zero-call and B1/B2 preserve exact lineage with review singleton groups", () => {
  const adjudicated = Array.from({ length: 34 }, (_, index) => ({ ...candidate(index + 1),
    decision: index === 0 ? "review" : "research", riskCodes: [index % 2 ? "official-form" : "concept-distinction"],
    goalSeeds: [{ layout: "source-layout", value: `goal-${index + 1}` }] }));
  const baseline = buildZeroCallBaseline([{ documentId: "d1", candidates: adjudicated }]);
  assert.equal(baseline.calls, 0); assert.equal(baseline.groups.length, 34);
  const b1 = buildGoalConsolidationPlan([{ documentId: "d1", candidates: adjudicated }], "document-once");
  const b2 = buildGoalConsolidationPlan([{ documentId: "d1", candidates: adjudicated }], "bounded");
  assert.equal(b1.length, 1); assert.equal(b1[0].members.length, 34);
  assert.equal(b2.length, 3); assert.ok(b2.every((item) => item.members.length <= 16));
  const body = buildGoalConsolidationBody({ task: b2[0], modelId: "deepseek-v4-pro", maxOutputTokens: 4096 });
  assert.equal(Object.hasOwn(body, "temperature"), false);
  const refs = JSON.parse(body.messages[1].content).candidates.map((item) => item.ref);
  const groups = refs.map((ref) => ({ memberRefs: [ref], researchGoal: `investigate ${ref}` }));
  const normalized = normalizeGoalConsolidationPayload({ groups }, b2[0]);
  assert.equal(normalized.groups.length, refs.length);
  assert.throws(() => normalizeGoalConsolidationPayload({ groups: [{ memberRefs: refs, researchGoal: "merged" }] }, b2[0]), /review/u);
});

test("bounded adapter omits temperature, audits full evidence, and never retries unknown outcomes", async () => {
  const [task] = buildCandidateAdjudicationPlan([{ documentId: "d1", candidates: [candidate(1)] }]);
  const events = []; const requests = [];
  const payload = JSON.stringify({ id: "response-1", choices: [{ index: 0, finish_reason: "stop", message: {
    content: JSON.stringify({ decisions: [{ ref: "c001", decision: "direct", riskCodes: [], goalSeed: null }] }),
    reasoning_content: "private reasoning" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
    completion_tokens_details: { reasoning_tokens: 2 } } });
  const result = await invokeM5ECandidateAdjudicationDeepSeek({ stage: "candidate-adjudication", task,
    modelId: "deepseek-v4-pro", maxOutputTokens: 4096, maximumAttempts: 1 }, { credential: "fixture-key",
    audit: (event) => events.push(event), fetchImpl: async (url, request) => { requests.push({ url, request }); return {
      ok: true, status: 200, headers: { get: () => null, entries: () => [] }, arrayBuffer: async () => Buffer.from(payload),
    }; } });
  assert.equal(requests.length, 1); assert.equal(requests[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(Object.hasOwn(JSON.parse(requests[0].request.body), "temperature"), false);
  assert.deepEqual(events.map((item) => item.event), ["request", "response"]);
  assert.equal(events[0].request.headers.authorization, undefined); assert.equal(result.usage.totalTokens, 15);
  let calls = 0;
  await assert.rejects(() => invokeM5ECandidateAdjudicationDeepSeek({ stage: "candidate-adjudication", task,
    modelId: "deepseek-v4-pro", maxOutputTokens: 4096, maximumAttempts: 1 }, { credential: "fixture-key",
    fetchImpl: async () => { calls += 1; throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); } }),
  (error) => error.category === "unknown-outcome" && error.retryable === false);
  assert.equal(calls, 1);
});

test("bounded broker passes credential and audit descriptors and preserves a pre-network auth audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "m5e-bounded-broker-")); const credentialPath = join(root, "credential");
  const auditPath = join(root, "audit.jsonl"); await writeFile(credentialPath, "\n", { mode: 0o600 });
  const credential = await open(credentialPath, "r"); const audit = await open(auditPath, "wx", 0o600);
  try {
    const [task] = buildCandidateAdjudicationPlan([{ documentId: "d1", candidates: [candidate(1)] }]);
    await assert.rejects(() => invokeM5EBoundedBrokerProcess({ credentialFd: credential.fd, auditFd: audit.fd,
      request: { stage: "candidate-adjudication", task, modelId: "deepseek-v4-pro", maxOutputTokens: 4096, maximumAttempts: 1 } }),
    (error) => error.category === "auth" && error.retryable === false);
  } finally { await audit.close(); await credential.close(); }
  const records = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((item) => item.event), ["request", "response"]);
  await rm(root, { recursive: true, force: true });
});
