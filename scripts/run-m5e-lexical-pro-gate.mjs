import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { invokeM5CModelBroker } from "../src/m5c/model-broker-process.mjs";
import { assembleDetectorV3Coverage } from "../src/m5e/detector-v3.mjs";
import {
  buildLexicalStageABody,
  buildLexicalStageBBody,
  LEXICAL_STAGE_A_SYSTEM_PROMPT_V1,
  LEXICAL_STAGE_A_SYSTEM_PROMPT_V2,
  LEXICAL_STAGE_A_SYSTEM_PROMPT_V3,
  normalizeLexicalStageAPayload,
  normalizeLexicalStageBPayload,
} from "../src/m5e/lexical-two-stage.mjs";
import { buildLexicalReferenceBenchmark, scoreLexicalReferenceBenchmark } from "../src/m5e/lexical-reference-benchmark.mjs";
import { classifyLexicalAuditEvents } from "../src/m5e/lexical-experiment-recovery.mjs";
import {
  LEXICAL_STAGE_A_V2_MAX_ATTEMPTS,
  LEXICAL_STAGE_A_V2_MAX_CONCURRENCY,
  LEXICAL_STAGE_A_V2_MAX_COST_MICROS_CNY,
  lexicalStageAV2Plan,
} from "../src/m5e/lexical-stage-a-v2-experiment.mjs";
import {
  LEXICAL_STAGE_A_V3_MAX_ATTEMPTS,
  LEXICAL_STAGE_A_V3_MAX_CONCURRENCY,
  LEXICAL_STAGE_A_V3_MAX_COST_MICROS_CNY,
  lexicalStageAV3Plan,
} from "../src/m5e/lexical-stage-a-v3-experiment.mjs";
import { createDetectorV3Fixture } from "./m5e-detector-v3-fixture.mjs";

const variant = process.env.M5E_LEXICAL_PRO_GATE_VARIANT ?? "gate-v1";
if (!["gate-v1", "stage-a-v2", "stage-a-v3"].includes(variant)) throw new Error("Lexical Pro gate variant is invalid");
const stageAV2 = variant === "stage-a-v2";
const stageAV3 = variant === "stage-a-v3";
const stageAOnly = stageAV2 || stageAV3;
const VERSION = stageAV3 ? "m5e-lexical-stage-a-v3-experiment-v1"
  : stageAV2 ? "m5e-lexical-stage-a-v2-experiment-v1" : "m5e-lexical-pro-gate-v1";
const MODEL = "deepseek-v4-pro";
const MAX_LOGICAL = stageAV3 ? 16 : stageAV2 ? 8 : 16;
const MAX_ATTEMPTS = stageAV3 ? LEXICAL_STAGE_A_V3_MAX_ATTEMPTS : stageAV2 ? LEXICAL_STAGE_A_V2_MAX_ATTEMPTS : 30;
const MAX_CONCURRENCY = stageAV3 ? LEXICAL_STAGE_A_V3_MAX_CONCURRENCY : stageAV2 ? LEXICAL_STAGE_A_V2_MAX_CONCURRENCY : 8;
const MAX_OUTPUT_TOKENS = 65_536;
const MAX_COST_MICROS_CNY = stageAV3 ? LEXICAL_STAGE_A_V3_MAX_COST_MICROS_CNY
  : stageAV2 ? LEXICAL_STAGE_A_V2_MAX_COST_MICROS_CNY : 5_000_000;
const UNKNOWN_RESERVATION_MICROS_CNY = 500_000;
const FX_CNY_PER_USD = 8;
const PRICE_USD_PER_MILLION = Object.freeze({ cacheHitInput: 0.003625, cacheMissInput: 0.435, output: 0.87 });
const RETRYABLE = new Set(["malformed-response", "provider", "rate-limit", "timeout"]);
const mode = process.env.M5E_LEXICAL_PRO_GATE_MODE;
if (!new Set(["dry-run", "execute", "rebuild"]).has(mode)) throw new Error("Lexical Pro gate mode is invalid");

const sha = (value) => `sha256:${createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value)
  ? value : JSON.stringify(value)).digest("hex")}`;
const STAGE_A_PROMPT_VERSION = stageAV3 ? "balanced-v3" : stageAV2 ? "precision-v2" : "recall-v1";
const STAGE_A_PROMPT_DIGEST = sha(stageAV3 ? LEXICAL_STAGE_A_SYSTEM_PROMPT_V3
  : stageAV2 ? LEXICAL_STAGE_A_SYSTEM_PROMPT_V2 : LEXICAL_STAGE_A_SYSTEM_PROMPT_V1);
async function privateDirectory(path, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("Lexical Pro gate directory is invalid");
  }
  return path;
}
async function privateFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("Lexical Pro gate file is invalid");
  }
  return readFile(path);
}
async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600); await rename(temporary, path); await chmod(path, 0o600);
}
function parseEvents(bytes) {
  const source = bytes.toString("utf8").trim(); return source.length === 0 ? [] : source.split("\n").map((line) => JSON.parse(line));
}
function plan(documents) {
  if (stageAV3) return lexicalStageAV3Plan(documents);
  if (stageAV2) return lexicalStageAV2Plan(documents);
  const tasks = [];
  for (let repeat = 1; repeat <= 2; repeat += 1) for (const [documentIndex, document] of documents.entries()) {
    tasks.push(Object.freeze({ taskId: `pro-a-d${documentIndex + 1}-r${repeat}`, stage: "stage-a", repeat, documentIndex,
      documentId: document.documentId, dependencyTaskIds: Object.freeze([]) }));
  }
  for (let repeat = 1; repeat <= 2; repeat += 1) for (const [documentIndex, document] of documents.entries()) {
    tasks.push(Object.freeze({ taskId: `pro-b1-d${documentIndex + 1}-r${repeat}`, stage: "stage-b", repeat, documentIndex,
      documentId: document.documentId, dependencyTaskIds: Object.freeze([`pro-a-d${documentIndex + 1}-r${repeat}`]) }));
  }
  if (tasks.length !== MAX_LOGICAL) throw new Error("Lexical Pro gate plan is invalid");
  return Object.freeze(tasks.map((task, index) => Object.freeze({ ...task, sequence: index + 1 })));
}
function expectedRequest(task, coverages, successful) {
  if (task.stage === "stage-a") return Object.freeze({ stage: "stage-a", coverage: coverages[task.documentIndex],
    approvedTerms: coverages.approvedTerms, modelId: MODEL, omitTemperature: true,
    stageAPromptVersion: STAGE_A_PROMPT_VERSION,
    maxOutputTokens: MAX_OUTPUT_TOKENS, maximumAttempts: 1 });
  const stageAResult = successful.get(task.dependencyTaskIds[0]); if (!stageAResult) return null;
  return Object.freeze({ stage: "stage-b", stageAResult, modelId: MODEL, omitTemperature: true,
    maxOutputTokens: MAX_OUTPUT_TOKENS, maximumAttempts: 1 });
}
function expectedBody(request) { return request.stage === "stage-a" ? buildLexicalStageABody(request) : buildLexicalStageBBody(request); }
function normalizedUsage(events) {
  const response = events.find((event) => event.event === "response"); const value = response?.response?.usage;
  if (!value) return null;
  const inputTokens = value.prompt_tokens; const outputTokens = value.completion_tokens; const totalTokens = value.total_tokens;
  const reasoningTokens = value.completion_tokens_details?.reasoning_tokens ?? 0;
  const cacheHitTokens = value.prompt_cache_hit_tokens ?? value.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheMissTokens = value.prompt_cache_miss_tokens ?? inputTokens - cacheHitTokens;
  if (![inputTokens, outputTokens, totalTokens, reasoningTokens, cacheHitTokens, cacheMissTokens]
    .every((item) => Number.isSafeInteger(item) && item >= 0) || inputTokens + outputTokens !== totalTokens
    || cacheHitTokens + cacheMissTokens !== inputTokens || reasoningTokens > outputTokens) return null;
  const costMicrosUsd = Math.ceil(cacheHitTokens * PRICE_USD_PER_MILLION.cacheHitInput
    + cacheMissTokens * PRICE_USD_PER_MILLION.cacheMissInput + outputTokens * PRICE_USD_PER_MILLION.output);
  return Object.freeze({ inputTokens, outputTokens, reasoningTokens, totalTokens, cacheHitTokens, cacheMissTokens,
    costMicrosUsd, costMicrosCny: costMicrosUsd * FX_CNY_PER_USD, durationMs: response.elapsedMs ?? 0 });
}
function totals(attempts) {
  const value = { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0,
    cacheHitTokens: 0, cacheMissTokens: 0, costMicrosUsd: 0, costMicrosCny: 0, durationMs: 0, unknownUsageCalls: 0 };
  for (const attempt of attempts.filter((item) => item.consumed)) {
    value.calls += 1; if (!attempt.usage) { value.unknownUsageCalls += 1; continue; }
    for (const field of Object.keys(value).filter((field) => !["calls", "unknownUsageCalls"].includes(field))) value[field] += attempt.usage[field];
  }
  return value;
}
function exposure(usage, pending = 0) { return usage.costMicrosCny + (usage.unknownUsageCalls + pending) * UNKNOWN_RESERVATION_MICROS_CNY; }
function reconstruct(task, events, request, benchmark) {
  const response = events.find((event) => event.event === "response");
  if (!response || response.outcome?.normalized !== true || typeof response.response?.content !== "string") return null;
  const payload = JSON.parse(response.response.content);
  const result = task.stage === "stage-a" ? normalizeLexicalStageAPayload(payload, request.coverage, request.approvedTerms)
    : normalizeLexicalStageBPayload(payload, request.stageAResult);
  if (task.stage === "stage-a") {
    const quotes = result.candidates.flatMap((candidate) => candidate.quotes); const occurrences = quotes.flatMap((quote) => quote.occurrences);
    const covered = result.candidates.filter((item) => item.coverage.status === "covered").length;
    return Object.freeze({ result, summary: Object.freeze({ candidates: result.candidates.length, quotes: quotes.length,
      occurrences: occurrences.length, covered, uncovered: result.candidates.length - covered,
      benchmark: scoreLexicalReferenceBenchmark(benchmark, result.candidates) }) });
  }
  const research = result.groups.filter((item) => item.decision === "research");
  return Object.freeze({ result, summary: Object.freeze({ inputCandidates: request.stageAResult.candidates
    .filter((item) => item.coverage.status === "uncovered").length, groups: result.groups.length, researchGroups: research.length,
  researchNeeds: research.reduce((sum, item) => sum + item.needs.length, 0) }) });
}
async function rebuild(tasks, paths, coverages, benchmark) {
  const taskById = new Map(tasks.map((task) => [task.taskId, task])); const successful = new Map(); const summaries = new Map();
  const attempts = []; const attemptsByTask = new Map(); const names = (await readdir(paths.calls)).filter((name) => name.endsWith(".metadata.json")).sort();
  const records = [];
  for (const metadataName of names) {
    const metadata = JSON.parse((await privateFile(join(paths.calls, metadataName))).toString("utf8")); const task = taskById.get(metadata.taskId);
    if (!task || metadata.modelId !== MODEL || metadata.temperatureEffective !== false
      || (stageAOnly && (metadata.stageAPromptVersion !== STAGE_A_PROMPT_VERSION
        || metadata.stageAPromptDigest !== STAGE_A_PROMPT_DIGEST))) {
      throw new Error("Lexical Pro gate metadata is invalid");
    }
    const stem = metadataName.replace(/\.metadata\.json$/u, ""); const auditName = `${stem}.jsonl`;
    const auditBytes = await privateFile(join(paths.calls, auditName)); const events = parseEvents(auditBytes);
    const classification = classifyLexicalAuditEvents(events); const requestEvent = events.find((event) => event.event === "request");
    if (classification.consumed && (sha(requestEvent?.request?.body) !== metadata.requestBodyDigest
      || Object.hasOwn(requestEvent.request.body, "temperature"))) throw new Error("Lexical Pro gate request drift detected");
    const response = events.find((event) => event.event === "response"); const usage = normalizedUsage(events);
    const entry = Object.freeze({ ordinal: metadata.ordinal, taskId: task.taskId, attempt: metadata.attempt, consumed: classification.consumed,
      status: classification.status, category: response?.outcome?.error?.category ?? null, usage,
      auditFile: auditName, auditDigest: sha(auditBytes), metadataFile: metadataName });
    attempts.push(entry); const list = attemptsByTask.get(task.taskId) ?? []; list.push(entry); attemptsByTask.set(task.taskId, list);
    records.push(Object.freeze({ metadata, task, events, entry }));
  }
  for (const task of tasks) {
    for (const record of records.filter((item) => item.task.taskId === task.taskId && item.entry.status === "completed")) {
      const request = expectedRequest(task, coverages, successful); if (!request) continue;
      if (sha(expectedBody(request)) !== record.metadata.requestBodyDigest) throw new Error("Lexical Pro gate logical request drift detected");
      const restored = reconstruct(task, record.events, request, benchmark); if (!restored) continue;
      successful.set(task.taskId, restored.result); summaries.set(task.taskId, restored.summary); break;
    }
  }
  const logical = tasks.map((task) => {
    const list = attemptsByTask.get(task.taskId) ?? []; const last = list.at(-1);
    return Object.freeze({ taskId: task.taskId, stage: task.stage, status: successful.has(task.taskId) ? "completed"
      : !last ? "not-started" : last.status, attempts: list.length, summary: summaries.get(task.taskId) ?? null });
  });
  return Object.freeze({ successful, attempts: Object.freeze(attempts), attemptsByTask, logical: Object.freeze(logical) });
}
function eligible(tasks, state) {
  const byTask = new Map(state.logical.map((item) => [item.taskId, item]));
  const retries = tasks.filter((task) => { const logical = byTask.get(task.taskId); const attempts = state.attemptsByTask.get(task.taskId) ?? [];
    const last = attempts.at(-1); return logical.status === "failed" && logical.attempts < 2 && RETRYABLE.has(last?.category); });
  if (retries.length > 0) return retries;
  return tasks.filter((task) => { const logical = byTask.get(task.taskId);
    return logical.status === "not-started" && task.dependencyTaskIds.every((taskId) => state.successful.has(taskId)); });
}
async function executeAttempt(task, request, paths, credentialFd, ordinal, attempt) {
  const stem = `${String(ordinal).padStart(4, "0")}-${task.taskId}-a${attempt}`; const auditPath = join(paths.calls, `${stem}.jsonl`);
  const body = expectedBody(request); const metadata = { schemaVersion: `${VERSION}-attempt`, ordinal, taskId: task.taskId, attempt,
    maximumAttempts: 2, modelId: MODEL, thinking: "enabled", temperatureEffective: false, requestBodyDigest: sha(body) };
  if (task.stage === "stage-a") { metadata.stageAPromptVersion = request.stageAPromptVersion;
    metadata.stageAPromptDigest = STAGE_A_PROMPT_DIGEST; }
  await writeFile(join(paths.calls, `${stem}.metadata.json`), `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const audit = await open(auditPath, "wx", 0o600); await chmod(auditPath, 0o600);
  try { await invokeM5CModelBroker({ credentialFd, auditFd: audit.fd, request },
    { entry: new URL("./m5e-lexical-broker-entry.mjs", import.meta.url), timeoutMs: 900_000, outputBytes: 32 * 1024 * 1024 }); }
  catch { /* per-attempt audit is authoritative */ } finally { await audit.close(); }
}
async function writeReport(paths, fixture, benchmark, state, status) {
  const usage = totals(state.attempts); const value = { schemaVersion: `${VERSION}-report`, status, corpusDigest: fixture.corpusDigest,
    factSetDigest: fixture.manifest.factSetDigest, benchmarkDigest: benchmark.benchmarkDigest, modelId: MODEL,
    logicalTasks: MAX_LOGICAL, maximumActualAttempts: MAX_ATTEMPTS, maximumConcurrency: MAX_CONCURRENCY,
    maximumCostMicrosCny: MAX_COST_MICROS_CNY, thinking: "enabled", temperatureSent: false, temperatureEffective: false,
    ...(stageAOnly ? { stageAPromptVersion: STAGE_A_PROMPT_VERSION, stageAPromptDigest: STAGE_A_PROMPT_DIGEST } : {}),
    priceSnapshot: { source: "https://api-docs.deepseek.com/quick_start/pricing", observedAt: "2026-08-04",
      currency: "USD", usdPerMillionTokens: PRICE_USD_PER_MILLION, conservativeFxCnyPerUsd: FX_CNY_PER_USD },
    logical: state.logical, attempts: state.attempts, totals: usage, budgetExposureMicrosCny: exposure(usage),
    braveCalls: 0, fetchCalls: 0, translationCalls: 0, qaCalls: 0, researchCalls: 0, persistenceWrites: 0 };
  await atomicJson(join(paths.root, "report.json"), { ...value, reportDigest: sha(value) }); return value;
}

let fixture; let credential;
try {
  fixture = await createDetectorV3Fixture(process.env.M5E_DETECTOR_V3_CORPUS); const tasks = plan(fixture.documents);
  const coverages = fixture.documents.map((document) => assembleDetectorV3Coverage({ document, approvedTerms: fixture.approvedTerms,
    retriever: fixture.retriever })); Object.defineProperty(coverages, "approvedTerms", { value: fixture.approvedTerms });
  const referenceBytes = await privateFile(process.env.M5E_LEXICAL_REFERENCE_PROPOSAL);
  if (sha(referenceBytes) !== process.env.M5E_LEXICAL_REFERENCE_PROPOSAL_DIGEST) throw new Error("Lexical Pro reference digest mismatch");
  const benchmark = buildLexicalReferenceBenchmark(JSON.parse(referenceBytes.toString("utf8")), fixture.documents);
  if (mode === "dry-run") {
    process.stdout.write(`${JSON.stringify({ schemaVersion: `${VERSION}-preflight`, status: "ready", modelId: MODEL,
      logicalTasks: tasks.length, stageA: stageAOnly ? MAX_LOGICAL : 8, stageB: stageAOnly ? 0 : 8,
      stageAPromptVersion: STAGE_A_PROMPT_VERSION, stageAPromptDigest: STAGE_A_PROMPT_DIGEST,
      maximumActualAttempts: MAX_ATTEMPTS, maximumConcurrency: MAX_CONCURRENCY,
      maximumCostMicrosCny: MAX_COST_MICROS_CNY, thinking: "enabled", temperatureSent: false, temperatureEffective: false,
      maximumAttemptsPerLogicalTask: 2, retryableCategories: [...RETRYABLE], unknownRetry: false, credentialRead: false })}\n`);
  } else {
    const outputDirectory = stageAV3 ? process.env.M5E_LEXICAL_STAGE_A_V3_OUTPUT_DIR
      : stageAV2 ? process.env.M5E_LEXICAL_STAGE_A_V2_OUTPUT_DIR : process.env.M5E_LEXICAL_PRO_GATE_OUTPUT_DIR;
    if (mode === "execute") await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
    const root = await privateDirectory(outputDirectory);
    const paths = { root, calls: await privateDirectory(join(root, "llm-calls"), mode === "execute") };
    let state = await rebuild(tasks, paths, coverages, benchmark); let status = "completed";
    if (mode === "execute") {
      credential = await openCredentialFile(process.env.DEEPSEEK_KEY_FILE);
      while (true) {
        state = await rebuild(tasks, paths, coverages, benchmark); const usage = totals(state.attempts); const candidates = eligible(tasks, state);
        if (candidates.length === 0) break;
        if (usage.calls >= MAX_ATTEMPTS) { status = "attempt-limit-stopped"; break; }
        let wave = candidates.slice(0, Math.min(MAX_CONCURRENCY, MAX_ATTEMPTS - usage.calls));
        while (wave.length > 0 && exposure(usage, wave.length) > MAX_COST_MICROS_CNY) wave = wave.slice(0, -1);
        if (wave.length === 0) { status = "budget-stopped"; break; }
        const ordinal = state.attempts.length + 1;
        await Promise.allSettled(wave.map((task, index) => { const prior = state.attemptsByTask.get(task.taskId) ?? [];
          const request = expectedRequest(task, coverages, state.successful); if (!request) throw new Error("Lexical Pro dependency drift");
          return executeAttempt(task, request, paths, credential.fd, ordinal + index, prior.length + 1); }));
        state = await rebuild(tasks, paths, coverages, benchmark); const progress = await writeReport(paths, fixture, benchmark, state, "running");
        process.stderr.write(`${JSON.stringify({ type: "pro-gate-progress", actualAttempts: progress.totals.calls,
          completedLogical: state.logical.filter((item) => item.status === "completed").length,
          budgetExposureMicrosCny: progress.budgetExposureMicrosCny })}\n`);
      }
    } else status = "rebuilt";
    state = await rebuild(tasks, paths, coverages, benchmark);
    if (status === "completed" && state.logical.some((item) => item.status !== "completed")) status = "evidence-complete";
    const reportStatus = status === "rebuilt"
      ? state.logical.every((item) => item.status === "completed") ? "completed" : "evidence-complete"
      : status;
    const report = await writeReport(paths, fixture, benchmark, state, reportStatus);
    process.stdout.write(`${JSON.stringify({ status, actualAttempts: report.totals.calls,
      completedLogical: state.logical.filter((item) => item.status === "completed").length,
      failedLogical: state.logical.filter((item) => item.status === "failed").length,
      unknownLogical: state.logical.filter((item) => item.status === "unknown").length,
      notStartedLogical: state.logical.filter((item) => item.status === "not-started").length,
      totals: report.totals, budgetExposureMicrosCny: report.budgetExposureMicrosCny })}\n`);
  }
} finally { await credential?.close(); await fixture?.close(); }
