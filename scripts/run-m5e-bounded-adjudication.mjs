import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { assembleDetectorV3Coverage } from "../src/m5e/detector-v3.mjs";
import {
  buildLexicalStageABody,
  mergeLexicalStageAResults,
  normalizeLexicalStageAPayload,
  normalizeLexicalStageBPayload,
} from "../src/m5e/lexical-two-stage.mjs";
import { buildLexicalReferenceBenchmark, scoreLexicalReferenceBenchmark } from "../src/m5e/lexical-reference-benchmark.mjs";
import { classifyLexicalAuditEvents } from "../src/m5e/lexical-experiment-recovery.mjs";
import {
  BOUNDED_ADJUDICATION_MAX_ACTUAL_ATTEMPTS,
  BOUNDED_ADJUDICATION_MAX_CONCURRENCY,
  BOUNDED_ADJUDICATION_MAX_COST_MICROS_CNY,
  BOUNDED_ADJUDICATION_MAX_LOGICAL_CALLS,
  BOUNDED_ADJUDICATION_MODEL,
  BOUNDED_ADJUDICATION_VERSION,
  CANDIDATE_ADJUDICATION_SYSTEM_PROMPT,
  GOAL_CONSOLIDATION_SYSTEM_PROMPT,
  aggregateCandidateAdjudications,
  boundedAdjudicationBudgetExposure,
  buildCandidateAdjudicationBody,
  buildCandidateAdjudicationPlan,
  buildGoalConsolidationBody,
  buildGoalConsolidationPlan,
  buildZeroCallBaseline,
  normalizeCandidateAdjudicationPayload,
  normalizeGoalConsolidationPayload,
} from "../src/m5e/lexical-bounded-adjudication.mjs";
import { createDetectorV3Fixture } from "./m5e-detector-v3-fixture.mjs";
import { invokeM5EBoundedBrokerProcess } from "./m5e-bounded-adjudication-broker-process.mjs";

const mode = process.env.M5E_BOUNDED_ADJUDICATION_MODE;
if (!new Set(["dry-run", "execute", "rebuild"]).has(mode)) throw new Error("Bounded adjudication mode is invalid");
const MAX_OUTPUT_TOKENS = 65_536;
const RETRYABLE = new Set(["malformed-response", "provider", "rate-limit", "timeout"]);
const PRICE_USD_PER_MILLION = Object.freeze({ cacheHitInput: 0.003625, cacheMissInput: 0.435, output: 0.87 });
const FX_CNY_PER_USD = 8;
const sha = (value) => `sha256:${createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value)
  ? value : JSON.stringify(value)).digest("hex")}`;
const promptDigests = Object.freeze({
  "candidate-adjudication": sha(CANDIDATE_ADJUDICATION_SYSTEM_PROMPT),
  "goal-consolidation": sha(GOAL_CONSOLIDATION_SYSTEM_PROMPT),
});

async function privateDirectory(path, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("Bounded adjudication directory is invalid");
  }
  return path;
}
async function privateFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("Bounded adjudication file is invalid");
  }
  return readFile(path);
}
async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600); await rename(temporary, path); await chmod(path, 0o600);
}
function events(bytes) {
  const source = bytes.toString("utf8").trim(); return source.length === 0 ? [] : source.split("\n").map((line) => JSON.parse(line));
}
function expectedHistoricalRequest(coverage, approvedTerms) {
  return Object.freeze({ stage: "stage-a", coverage, approvedTerms, modelId: BOUNDED_ADJUDICATION_MODEL,
    omitTemperature: true, stageAPromptVersion: "recall-v1", maxOutputTokens: MAX_OUTPUT_TOKENS, maximumAttempts: 1 });
}
async function historicalInputs(root, coverages, approvedTerms) {
  await privateDirectory(root); const calls = await privateDirectory(join(root, "llm-calls"));
  const report = JSON.parse((await privateFile(join(root, "report.json"))).toString("utf8"));
  if (report.modelId !== BOUNDED_ADJUDICATION_MODEL || report.corpusDigest !== "sha256:3defc2a47e53e946e950211232c3250dcc173619f32c44d9c46ebe163e0667da"
    || report.factSetDigest !== coverages.factSetDigest) throw new Error("Historical recall-v1 report lineage is invalid");
  const names = (await readdir(calls)).filter((name) => name.endsWith(".metadata.json")).sort(); const records = [];
  for (const metadataName of names) {
    const metadataBytes = await privateFile(join(calls, metadataName)); const metadata = JSON.parse(metadataBytes.toString("utf8"));
    const auditName = metadataName.replace(/\.metadata\.json$/u, ".jsonl"); const auditBytes = await privateFile(join(calls, auditName));
    records.push({ metadata, auditBytes, events: events(auditBytes) });
  }
  const stageA = []; const stageBDirectSurfaces = new Set();
  for (let documentIndex = 0; documentIndex < coverages.length; documentIndex += 1) {
    const repeats = [];
    for (let repeat = 1; repeat <= 2; repeat += 1) {
      const taskId = `pro-a-d${documentIndex + 1}-r${repeat}`; const matches = records.filter((item) => item.metadata.taskId === taskId);
      const request = expectedHistoricalRequest(coverages[documentIndex], approvedTerms); let restored = null;
      for (const record of matches) {
        const classification = classifyLexicalAuditEvents(record.events); const requestEvent = record.events.find((item) => item.event === "request");
        if (classification.consumed && (record.metadata.requestBodyDigest !== sha(requestEvent?.request?.body)
          || record.metadata.requestBodyDigest !== sha(buildLexicalStageABody(request)))) throw new Error("Historical recall-v1 request drift detected");
        const response = record.events.find((item) => item.event === "response");
        if (classification.status === "completed" && typeof response?.response?.content === "string") {
          restored = normalizeLexicalStageAPayload(JSON.parse(response.response.content), request.coverage, approvedTerms); break;
        }
      }
      if (!restored) throw new Error("Historical recall-v1 Stage A evidence is incomplete"); repeats.push(restored);
    }
    const merged = mergeLexicalStageAResults(repeats); stageA.push(merged);
    for (let repeat = 1; repeat <= 2; repeat += 1) {
      const taskId = `pro-b1-d${documentIndex + 1}-r${repeat}`; const source = repeats[repeat - 1];
      for (const record of records.filter((item) => item.metadata.taskId === taskId)) {
        const classification = classifyLexicalAuditEvents(record.events); const response = record.events.find((item) => item.event === "response");
        if (classification.status !== "completed" || typeof response?.response?.content !== "string") continue;
        const result = normalizeLexicalStageBPayload(JSON.parse(response.response.content), source);
        const directIds = new Set(result.groups.filter((item) => item.decision === "translate-directly").flatMap((item) => item.memberCandidateIds));
        for (const candidate of source.candidates.filter((item) => directIds.has(item.candidateId))) {
          for (const quote of candidate.quotes) stageBDirectSurfaces.add(quote.text);
        }
        break;
      }
    }
  }
  const documents = stageA.map((result) => Object.freeze({ documentId: result.documentId,
    candidates: Object.freeze(result.candidates.filter((item) => item.coverage.status === "uncovered")) }));
  return Object.freeze({ documents: Object.freeze(documents), stageA: Object.freeze(stageA),
    stageBDirectSurfaces: Object.freeze([...stageBDirectSurfaces].sort()), historicalReportDigest: sha(await privateFile(join(root, "report.json"))) });
}
function expectedRequest(task) {
  const base = { stage: task.stage, task, modelId: BOUNDED_ADJUDICATION_MODEL, maxOutputTokens: MAX_OUTPUT_TOKENS, maximumAttempts: 1 };
  return Object.freeze(base);
}
function expectedBody(request) {
  return request.stage === "candidate-adjudication" ? buildCandidateAdjudicationBody(request) : buildGoalConsolidationBody(request);
}
function normalizedUsage(value, elapsedMs) {
  const inputTokens = value?.prompt_tokens; const outputTokens = value?.completion_tokens; const totalTokens = value?.total_tokens;
  const reasoningTokens = value?.completion_tokens_details?.reasoning_tokens ?? 0;
  const cacheHitTokens = value?.prompt_cache_hit_tokens ?? value?.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheMissTokens = value?.prompt_cache_miss_tokens ?? inputTokens - cacheHitTokens;
  if (![inputTokens, outputTokens, totalTokens, reasoningTokens, cacheHitTokens, cacheMissTokens]
    .every((item) => Number.isSafeInteger(item) && item >= 0) || inputTokens + outputTokens !== totalTokens
    || cacheHitTokens + cacheMissTokens !== inputTokens || reasoningTokens > outputTokens) return null;
  const costMicrosUsd = Math.ceil(cacheHitTokens * PRICE_USD_PER_MILLION.cacheHitInput
    + cacheMissTokens * PRICE_USD_PER_MILLION.cacheMissInput + outputTokens * PRICE_USD_PER_MILLION.output);
  return Object.freeze({ inputTokens, outputTokens, reasoningTokens, totalTokens, cacheHitTokens, cacheMissTokens,
    costMicrosUsd, costMicrosCny: costMicrosUsd * FX_CNY_PER_USD, durationMs: elapsedMs ?? 0 });
}
function usageTotals(attempts) {
  const value = { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0,
    cacheHitTokens: 0, cacheMissTokens: 0, costMicrosUsd: 0, costMicrosCny: 0, durationMs: 0, unknownUsageCalls: 0 };
  for (const attempt of attempts.filter((item) => item.consumed)) {
    value.calls += 1; if (!attempt.usage) { value.unknownUsageCalls += 1; continue; }
    for (const key of Object.keys(value).filter((field) => !["calls", "unknownUsageCalls"].includes(field))) value[key] += attempt.usage[key];
  }
  return value;
}
function restoreResult(task, record) {
  const response = record.events.find((item) => item.event === "response");
  if (record.classification.status !== "completed" || typeof response?.response?.content !== "string") return null;
  const payload = JSON.parse(response.response.content);
  return task.stage === "candidate-adjudication" ? normalizeCandidateAdjudicationPayload(payload, task)
    : normalizeGoalConsolidationPayload(payload, task);
}
async function readAttemptRecords(paths, knownTasks) {
  const taskById = new Map(knownTasks.map((task) => [task.taskId, task])); const records = [];
  const names = (await readdir(paths.calls)).filter((name) => name.endsWith(".metadata.json")).sort();
  for (const metadataName of names) {
    const metadata = JSON.parse((await privateFile(join(paths.calls, metadataName))).toString("utf8")); const task = taskById.get(metadata.taskId);
    if (!task || metadata.modelId !== BOUNDED_ADJUDICATION_MODEL || metadata.promptDigest !== promptDigests[task.stage]
      || metadata.temperatureEffective !== false) throw new Error("Bounded adjudication metadata is invalid");
    const auditName = metadataName.replace(/\.metadata\.json$/u, ".jsonl"); const auditBytes = await privateFile(join(paths.calls, auditName));
    const auditEvents = events(auditBytes); const classification = classifyLexicalAuditEvents(auditEvents);
    const requestEvent = auditEvents.find((item) => item.event === "request"); const request = expectedRequest(task);
    if (classification.consumed && (sha(requestEvent?.request?.body) !== metadata.requestBodyDigest
      || sha(expectedBody(request)) !== metadata.requestBodyDigest)) throw new Error("Bounded adjudication request drift detected");
    const response = auditEvents.find((item) => item.event === "response");
    records.push(Object.freeze({ metadata, task, events: auditEvents, classification,
      usage: normalizedUsage(response?.response?.usage, response?.elapsedMs), auditName, auditDigest: sha(auditBytes) }));
  }
  return records;
}
function stateFor(tasks, records) {
  const successful = new Map(); const attemptsByTask = new Map();
  for (const task of tasks) for (const record of records.filter((item) => item.task.taskId === task.taskId)) {
    const list = attemptsByTask.get(task.taskId) ?? []; list.push(record); attemptsByTask.set(task.taskId, list);
    if (!successful.has(task.taskId)) { const result = restoreResult(task, record); if (result) successful.set(task.taskId, result); }
  }
  const logical = tasks.map((task) => { const attempts = attemptsByTask.get(task.taskId) ?? []; const last = attempts.at(-1);
    return Object.freeze({ taskId: task.taskId, stage: task.stage, strategy: task.strategy ?? task.layout,
      status: successful.has(task.taskId) ? "completed" : !last ? "not-started" : last.classification.status, attempts: attempts.length }); });
  return Object.freeze({ successful, attemptsByTask, logical: Object.freeze(logical) });
}
function phaseAAggregate(source, tasks, state) {
  if (tasks.some((task) => !state.successful.has(task.taskId))) return null;
  return Object.freeze(source.documents.map((document) => {
    const results = tasks.filter((task) => task.documentId === document.documentId).map((task) => state.successful.get(task.taskId));
    const grouped = ["source-layout", "hash-layout"].map((layout) => Object.freeze({ layout,
      decisions: Object.freeze(results.filter((result) => result.layout === layout).flatMap((result) => result.decisions)) }));
    return Object.freeze({ documentId: document.documentId, candidates: aggregateCandidateAdjudications(document.candidates, grouped) });
  }));
}
function containsSurface(candidate, surface) { return candidate.quotes.some((quote) => quote.text.includes(surface)); }
function phaseAMetrics(aggregate, benchmark, directSurfaces) {
  const candidates = aggregate.flatMap((document) => document.candidates); const unresolved = candidates.filter((item) => item.decision !== "direct");
  const direct = candidates.filter((item) => item.decision === "direct"); const score = scoreLexicalReferenceBenchmark(benchmark, unresolved);
  const directScore = scoreLexicalReferenceBenchmark(benchmark, direct); const agreements = candidates.filter((item) => {
    const pair = item.layoutDecisions; return pair["source-layout"] === pair["hash-layout"];
  }).length;
  const negativeMatches = directSurfaces.map((surface) => candidates.filter((item) => containsSurface(item, surface)))
    .filter((items) => items.length > 0); const negativeDirect = negativeMatches.filter((items) => items.some((item) => item.decision === "direct")).length;
  const review = candidates.filter((item) => item.decision === "review").length;
  return Object.freeze({ candidates: candidates.length, agreement: agreements / candidates.length,
    reviewRate: review / candidates.length, benchmark: score, criticalDoubleDirect: directScore.criticalCovered,
    negativeSurfaces: directSurfaces.length, matchedNegativeSurfaces: negativeMatches.length,
    consistentDirectNegativeRate: negativeMatches.length === 0 ? 0 : negativeDirect / negativeMatches.length,
    pass: directScore.criticalCovered === 0 && score.criticalCovered === score.criticalFamilies
      && score.highCovered / score.highFamilies >= 0.95 && agreements / candidates.length >= 0.85
      && review / candidates.length <= 0.20 && negativeMatches.length > 0 && negativeDirect / negativeMatches.length >= 0.70 });
}
function phaseDocuments(aggregate) {
  return aggregate.map((document) => Object.freeze({ documentId: document.documentId,
    candidates: Object.freeze(document.candidates.filter((item) => item.decision !== "direct")) }));
}
async function executeAttempt(task, paths, credentialFd, ordinal, attempt) {
  const stem = `${String(ordinal).padStart(4, "0")}-${task.taskId}-a${attempt}`; const request = expectedRequest(task);
  const body = expectedBody(request); const metadata = { schemaVersion: `${BOUNDED_ADJUDICATION_VERSION}-attempt`, ordinal,
    taskId: task.taskId, stage: task.stage, attempt, maximumAttempts: 2, modelId: BOUNDED_ADJUDICATION_MODEL,
    thinking: "enabled", temperatureEffective: false, promptDigest: promptDigests[task.stage], requestBodyDigest: sha(body) };
  await writeFile(join(paths.calls, `${stem}.metadata.json`), `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const auditPath = join(paths.calls, `${stem}.jsonl`); const audit = await open(auditPath, "wx", 0o600); await chmod(auditPath, 0o600);
  try { await invokeM5EBoundedBrokerProcess({ credentialFd, auditFd: audit.fd, request }); }
  catch (error) {
    let auditSize;
    try { auditSize = (await audit.stat()).size; }
    catch (statError) { throw new Error(`audit-stat:${statError?.code ?? "error"}:${statError?.message ?? "failure"}`); }
    if (auditSize === 0) throw error;
  } finally { await audit.close(); }
}
function eligible(tasks, state, attemptedInProcess) {
  const status = new Map(state.logical.map((item) => [item.taskId, item]));
  const retries = tasks.filter((task) => { const logical = status.get(task.taskId); const last = state.attemptsByTask.get(task.taskId)?.at(-1);
    const category = last?.events.find((item) => item.event === "response")?.outcome?.error?.category;
    return logical.status === "failed" && logical.attempts < 2 && RETRYABLE.has(category); });
  return retries.length > 0 ? retries : tasks.filter((task) => status.get(task.taskId).status === "not-started"
    && !attemptedInProcess.has(task.taskId));
}
function publicAttempt(record) {
  const response = record.events.find((item) => item.event === "response");
  return Object.freeze({ ordinal: record.metadata.ordinal, taskId: record.task.taskId, attempt: record.metadata.attempt,
    consumed: record.classification.consumed, status: record.classification.status,
    category: response?.outcome?.error?.category ?? null, usage: record.usage,
    auditFile: record.auditName, auditDigest: record.auditDigest });
}
async function writeReports(paths, source, benchmark, allTasks, records, aggregate, metrics, status) {
  const attempts = records.map(publicAttempt); const totals = usageTotals(attempts); const phaseDocs = aggregate ? phaseDocuments(aggregate) : [];
  const b0 = aggregate ? buildZeroCallBaseline(phaseDocs) : null; const state = stateFor(allTasks, records);
  const completedB1 = allTasks.filter((task) => task.strategy === "document-once" && state.successful.has(task.taskId));
  const completedB2 = allTasks.filter((task) => task.strategy === "bounded" && state.successful.has(task.taskId));
  const arm = (tasks) => { const results = tasks.map((task) => state.successful.get(task.taskId)).filter(Boolean);
    return Object.freeze({ logicalCalls: tasks.length, completedCalls: results.length,
      goals: results.reduce((sum, result) => sum + result.groups.length, 0),
      members: results.reduce((sum, result) => sum + result.groups.reduce((count, group) => count + group.memberCandidateIds.length, 0), 0) }); };
  const value = { schemaVersion: `${BOUNDED_ADJUDICATION_VERSION}-report`, status,
    corpusDigest: "sha256:3defc2a47e53e946e950211232c3250dcc173619f32c44d9c46ebe163e0667da",
    factSetDigest: source.factSetDigest, historicalReportDigest: source.historicalReportDigest,
    benchmarkDigest: benchmark.benchmarkDigest, modelId: BOUNDED_ADJUDICATION_MODEL, thinking: "enabled",
    temperatureSent: false, temperatureEffective: false, logicalTasks: allTasks.length,
    maximumLogicalCalls: BOUNDED_ADJUDICATION_MAX_LOGICAL_CALLS, maximumActualAttempts: BOUNDED_ADJUDICATION_MAX_ACTUAL_ATTEMPTS,
    maximumConcurrency: BOUNDED_ADJUDICATION_MAX_CONCURRENCY, maximumCostMicrosCny: BOUNDED_ADJUDICATION_MAX_COST_MICROS_CNY,
    maximumAttemptsPerLogicalTask: 2, unknownRetry: false, retryableCategories: [...RETRYABLE], phaseAMetrics: metrics,
    arms: { b0: b0 ? { logicalCalls: 0, goals: b0.groups.length, members: b0.groups.reduce((sum, group) => sum + group.members.length, 0) } : null,
      b1: arm(completedB1), b2: arm(completedB2) }, logical: state.logical, attempts, totals,
    budgetExposureMicrosCny: boundedAdjudicationBudgetExposure({ knownCostMicrosCny: totals.costMicrosCny,
      unknownUsageCalls: totals.unknownUsageCalls }), braveCalls: 0, fetchCalls: 0, researchCalls: 0,
    translationCalls: 0, qaCalls: 0, persistenceWrites: 0 };
  await atomicJson(join(paths.root, "report.json"), { ...value, reportDigest: sha(value) });
  if (aggregate) await atomicJson(join(paths.root, "blind-review.json"), { schemaVersion: `${BOUNDED_ADJUDICATION_VERSION}-blind-review`,
    status: "pending-user-review", documents: aggregate.map((document) => ({ documentId: document.documentId,
      candidates: document.candidates.filter((item) => item.decision === "review" || item.layoutDecisions["source-layout"] !== item.layoutDecisions["hash-layout"])
        .map((item) => ({ candidateId: item.candidateId, quotes: item.quotes.map((quote) => quote.text), decision: item.decision,
          riskCodes: item.riskCodes, layoutDecisions: item.layoutDecisions })) })) });
  return value;
}

let fixture; let credential;
try {
  fixture = await createDetectorV3Fixture(process.env.M5E_DETECTOR_V3_CORPUS);
  const coverages = fixture.documents.map((document) => assembleDetectorV3Coverage({ document, approvedTerms: fixture.approvedTerms,
    retriever: fixture.retriever })); Object.defineProperty(coverages, "factSetDigest", { value: fixture.manifest.factSetDigest });
  const historical = await historicalInputs(process.env.M5E_BOUNDED_ADJUDICATION_INPUT_DIR, coverages, fixture.approvedTerms);
  const source = Object.freeze({ ...historical, factSetDigest: fixture.manifest.factSetDigest });
  const referenceBytes = await privateFile(process.env.M5E_LEXICAL_REFERENCE_PROPOSAL);
  const expectedReferenceDigest = String(process.env.M5E_LEXICAL_REFERENCE_PROPOSAL_DIGEST ?? "").replace(/^sha256:/u, "");
  if (sha(referenceBytes).replace(/^sha256:/u, "") !== expectedReferenceDigest) throw new Error("Reference proposal digest mismatch");
  const benchmark = buildLexicalReferenceBenchmark(JSON.parse(referenceBytes.toString("utf8")), fixture.documents);
  const phaseATasks = buildCandidateAdjudicationPlan(source.documents); const counts = source.documents.map((item) => item.candidates.length);
  if (counts.join(",") !== "94,122,121,132" || phaseATasks.length !== 82 || source.stageBDirectSurfaces.length !== 77) {
    throw new Error("Bounded adjudication frozen input does not match the data-bound baseline");
  }
  if (mode === "dry-run") {
    process.stdout.write(`${JSON.stringify({ schemaVersion: `${BOUNDED_ADJUDICATION_VERSION}-preflight`, status: "ready",
      modelId: BOUNDED_ADJUDICATION_MODEL, frozenCandidates: counts, phaseALogicalCalls: phaseATasks.length,
      maximumB1Calls: 4, maximumB2Calls: 32, maximumLogicalCalls: BOUNDED_ADJUDICATION_MAX_LOGICAL_CALLS,
      maximumActualAttempts: BOUNDED_ADJUDICATION_MAX_ACTUAL_ATTEMPTS, maximumConcurrency: BOUNDED_ADJUDICATION_MAX_CONCURRENCY,
      maximumCostMicrosCny: BOUNDED_ADJUDICATION_MAX_COST_MICROS_CNY, firstWaveReservationMicrosCny: 16_000_000,
      maximumAttemptsPerLogicalTask: 2, retryableCategories: [...RETRYABLE], unknownRetry: false,
      historicalInputReadOnly: true, credentialRead: false, braveCalls: 0, fetchCalls: 0, researchCalls: 0,
      translationCalls: 0, qaCalls: 0, persistenceWrites: 0 })}\n`);
  } else {
    const output = process.env.M5E_BOUNDED_ADJUDICATION_OUTPUT_DIR;
    if (mode === "execute") await mkdir(output, { recursive: false, mode: 0o700 });
    const paths = { root: await privateDirectory(output), calls: await privateDirectory(join(output, "llm-calls"), mode === "execute") };
    if (mode === "execute") credential = await openCredentialFile(process.env.DEEPSEEK_KEY_FILE);
    let status = mode === "rebuild" ? "rebuilt" : "completed"; let allTasks = phaseATasks; let aggregate = null; let metrics = null;
    const attemptedInProcess = new Set();
    while (true) {
      let records = await readAttemptRecords(paths, allTasks); let phaseState = stateFor(phaseATasks, records); aggregate = phaseAAggregate(source, phaseATasks, phaseState);
      if (aggregate) {
        metrics = phaseAMetrics(aggregate, benchmark, source.stageBDirectSurfaces);
        if (!metrics.pass) { status = "phase-a-no-go"; await writeReports(paths, source, benchmark, allTasks, records, aggregate, metrics, status); break; }
        const phaseDocs = phaseDocuments(aggregate); const b1 = buildGoalConsolidationPlan(phaseDocs, "document-once");
        const b2 = buildGoalConsolidationPlan(phaseDocs, "bounded"); allTasks = Object.freeze([...phaseATasks, ...b1, ...b2]
          .map((task, index) => Object.freeze({ ...task, sequence: index + 1 })));
        if (allTasks.length > BOUNDED_ADJUDICATION_MAX_LOGICAL_CALLS) throw new Error("Bounded adjudication logical ceiling exceeded");
        records = await readAttemptRecords(paths, allTasks);
      }
      const state = stateFor(allTasks, records); const attempts = records.map(publicAttempt); const totals = usageTotals(attempts);
      if (mode === "rebuild") { await writeReports(paths, source, benchmark, allTasks, records, aggregate, metrics, status); break; }
      if (state.logical.some((item) => item.status === "unknown")) { status = "unknown-stopped"; await writeReports(paths, source, benchmark, allTasks, records, aggregate, metrics, status); break; }
      let candidates = eligible(allTasks, state, attemptedInProcess);
      if (aggregate) {
        const runnableB1 = candidates.filter((task) => task.strategy === "document-once");
        candidates = runnableB1.length > 0 ? runnableB1 : candidates.filter((task) => task.strategy !== "document-once");
      } else candidates = candidates.filter((task) => task.stage === "candidate-adjudication");
      if (candidates.length === 0) {
        status = state.logical.every((item) => item.status === "completed") ? "completed" : "evidence-complete";
        await writeReports(paths, source, benchmark, allTasks, records, aggregate, metrics, status); break;
      }
      if (records.length >= BOUNDED_ADJUDICATION_MAX_ACTUAL_ATTEMPTS) { status = "attempt-limit-stopped"; await writeReports(paths, source, benchmark, allTasks, records, aggregate, metrics, status); break; }
      let wave = candidates.slice(0, Math.min(BOUNDED_ADJUDICATION_MAX_CONCURRENCY,
        BOUNDED_ADJUDICATION_MAX_ACTUAL_ATTEMPTS - records.length));
      while (wave.length > 0 && boundedAdjudicationBudgetExposure({ knownCostMicrosCny: totals.costMicrosCny,
        unknownUsageCalls: totals.unknownUsageCalls, pendingCalls: wave.length }) > BOUNDED_ADJUDICATION_MAX_COST_MICROS_CNY) wave = wave.slice(0, -1);
      if (wave.length === 0) { status = "budget-stopped"; await writeReports(paths, source, benchmark, allTasks, records, aggregate, metrics, status); break; }
      const ordinal = records.length + 1;
      const settled = await Promise.allSettled(wave.map((task, index) => executeAttempt(task, paths, credential.fd, ordinal + index,
        (state.attemptsByTask.get(task.taskId)?.length ?? 0) + 1)));
      const localFailure = settled.find((item) => item.status === "rejected");
      if (localFailure) throw new Error(`Bounded broker pre-request failure: ${localFailure.reason?.providerCode ?? "provider"} ${localFailure.reason?.localDiagnostic ?? ""}`.trim());
      wave.forEach((task) => attemptedInProcess.add(task.taskId));
      const progressRecords = await readAttemptRecords(paths, allTasks);
      const report = await writeReports(paths, source, benchmark, allTasks, progressRecords, aggregate, metrics, "running");
      process.stderr.write(`${JSON.stringify({ type: "bounded-adjudication-progress", actualAttempts: report.totals.calls,
        completedLogical: report.logical.filter((item) => item.status === "completed").length,
        budgetExposureMicrosCny: report.budgetExposureMicrosCny })}\n`);
    }
    const report = JSON.parse((await privateFile(join(paths.root, "report.json"))).toString("utf8"));
    process.stdout.write(`${JSON.stringify({ status: report.status, logicalTasks: report.logicalTasks,
      completedLogical: report.logical.filter((item) => item.status === "completed").length,
      failedLogical: report.logical.filter((item) => item.status === "failed").length,
      unknownLogical: report.logical.filter((item) => item.status === "unknown").length,
      totals: report.totals, budgetExposureMicrosCny: report.budgetExposureMicrosCny })}\n`);
  }
} finally { await credential?.close(); await fixture?.close(); }
