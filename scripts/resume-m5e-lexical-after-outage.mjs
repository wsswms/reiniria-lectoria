import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { invokeM5CModelBroker } from "../src/m5c/model-broker-process.mjs";
import { assembleDetectorV3Coverage } from "../src/m5e/detector-v3.mjs";
import {
  buildLexicalStageABody,
  buildLexicalStageBBody,
  mergeLexicalStageAResults,
  normalizeLexicalStageAPayload,
  normalizeLexicalStageBPayload,
} from "../src/m5e/lexical-two-stage.mjs";
import {
  buildLexicalExperimentPlan,
  lexicalExperimentBudgetExposure,
  lexicalExperimentWaveAllowed,
  LEXICAL_EXPERIMENT_MAX_CALLS,
  LEXICAL_EXPERIMENT_MAX_CONCURRENCY,
  LEXICAL_EXPERIMENT_MAX_COST_MICROS_CNY,
  LEXICAL_EXPERIMENT_MAX_OUTPUT_TOKENS,
  LEXICAL_EXPERIMENT_MODEL,
  LEXICAL_EXPERIMENT_VERSION,
} from "../src/m5e/lexical-experiment.mjs";
import { classifyLexicalAuditEvents, lexicalAuditUsage } from "../src/m5e/lexical-experiment-recovery.mjs";
import { buildLexicalReferenceBenchmark, scoreLexicalReferenceBenchmark } from "../src/m5e/lexical-reference-benchmark.mjs";
import { createDetectorV3Fixture } from "./m5e-detector-v3-fixture.mjs";

const mode = process.env.M5E_LEXICAL_RECOVERY_MODE;
if (!new Set(["rebuild", "execute"]).has(mode)) throw new Error("Lexical recovery mode is invalid");
const sha = (value) => `sha256:${createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value)
  ? value : JSON.stringify(value)).digest("hex")}`;
const COST_FIELDS = Object.freeze(["calls", "inputTokens", "outputTokens", "reasoningTokens", "totalTokens", "costMicrosCny", "durationMs"]);

async function privateDirectory(path, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("Lexical recovery directory is invalid");
  }
  return path;
}
async function privateFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("Lexical recovery file is invalid");
  }
  return readFile(path);
}
async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600); await rename(temporary, path); await chmod(path, 0o600);
}
function parseEvents(bytes) {
  const source = bytes.toString("utf8").trim();
  return source.length === 0 ? [] : source.split("\n").map((line) => JSON.parse(line));
}
function baseAuditName(task) { return `${String(task.sequence).padStart(4, "0")}-${task.taskId}.jsonl`; }
function baseArtifactName(task) { return `${String(task.sequence).padStart(4, "0")}-${task.taskId}.json`; }
function retryTaskId(metadata) {
  if (typeof metadata?.taskId === "string") return metadata.taskId;
  if (typeof metadata?.retryOf !== "string") return null;
  return metadata.retryOf.replace(/^[0-9]+-/u, "").replace(/\.jsonl$/u, "");
}
function totals(attempts) {
  const value = { ...Object.fromEntries(COST_FIELDS.map((field) => [field, 0])), unknownUsageCalls: 0 };
  for (const attempt of attempts.filter((item) => item.consumed)) {
    value.calls += 1;
    if (!attempt.usage) { value.unknownUsageCalls += 1; continue; }
    for (const field of COST_FIELDS.filter((name) => name !== "calls")) value[field] += attempt.usage[field];
  }
  return value;
}
function stageASummary(result, benchmark) {
  const quotes = result.candidates.flatMap((candidate) => candidate.quotes); const occurrences = quotes.flatMap((quote) => quote.occurrences);
  const covered = result.candidates.filter((item) => item.coverage.status === "covered").length;
  return Object.freeze({ candidates: result.candidates.length, quotes: quotes.length, occurrences: occurrences.length,
    covered, uncovered: result.candidates.length - covered, multiOccurrenceQuotes: quotes.filter((item) => item.occurrences.length > 1).length,
    benchmark: scoreLexicalReferenceBenchmark(benchmark, result.candidates) });
}
function stageBSummary(result, stageAResult, benchmark) {
  const inputCandidates = stageAResult.candidates.filter((item) => item.coverage.status === "uncovered").length;
  const research = result.groups.filter((item) => item.decision === "research");
  return Object.freeze({ stageACandidates: stageAResult.candidates.length,
    coveredCandidates: stageAResult.candidates.length - inputCandidates, inputCandidates,
    benchmark: scoreLexicalReferenceBenchmark(benchmark, stageAResult.candidates), groups: result.groups.length,
    researchGroups: research.length, translateDirectlyGroups: result.groups.length - research.length,
    researchNeeds: research.reduce((sum, item) => sum + item.needs.length, 0),
    singletonGroups: result.groups.filter((item) => item.memberCandidateIds.length === 1).length,
    maximumGroupSize: Math.max(0, ...result.groups.map((item) => item.memberCandidateIds.length)) });
}
function expectedRequest(task, coverages, successful) {
  if (task.stage === "stage-a") return Object.freeze({ stage: "stage-a", coverage: coverages[task.documentIndex],
    approvedTerms: coverages.approvedTerms, modelId: LEXICAL_EXPERIMENT_MODEL, stageAPromptVersion: "recall-v1",
    maxOutputTokens: LEXICAL_EXPERIMENT_MAX_OUTPUT_TOKENS, maximumAttempts: 1 });
  const values = task.dependencyTaskIds.map((taskId) => successful.get(taskId));
  if (values.some((value) => !value)) return null;
  return Object.freeze({ stage: "stage-b", stageAResult: mergeLexicalStageAResults(values), modelId: LEXICAL_EXPERIMENT_MODEL,
    maxOutputTokens: LEXICAL_EXPERIMENT_MAX_OUTPUT_TOKENS, maximumAttempts: 1 });
}
function expectedBody(request) { return request.stage === "stage-a" ? buildLexicalStageABody(request) : buildLexicalStageBBody(request); }
function reconstruct(task, events, request, benchmark) {
  const response = events.find((event) => event.event === "response");
  if (!response || response.outcome?.normalized !== true || typeof response.response?.content !== "string") return null;
  const payload = JSON.parse(response.response.content);
  const result = task.stage === "stage-a" ? normalizeLexicalStageAPayload(payload, request.coverage, request.approvedTerms)
    : normalizeLexicalStageBPayload(payload, request.stageAResult);
  return Object.freeze({ result, summary: task.stage === "stage-a" ? stageASummary(result, benchmark)
    : stageBSummary(result, request.stageAResult, benchmark) });
}
async function reference(path, expectedDigest) {
  const bytes = await privateFile(path);
  if (sha(bytes) !== expectedDigest) throw new Error("Lexical recovery reference digest mismatch");
  return JSON.parse(bytes.toString("utf8"));
}

async function rebuild(tasks, paths, coverages, benchmark) {
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const attempts = []; const successful = new Map(); const summaries = new Map(); const base = new Map();
  const artifactNames = new Set(await readdir(paths.artifacts));
  for (const task of tasks) {
    const auditPath = join(paths.calls, baseAuditName(task));
    let bytes;
    try { bytes = await privateFile(auditPath); } catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    const events = parseEvents(bytes); const classification = classifyLexicalAuditEvents(events); const usage = lexicalAuditUsage(events);
    const response = events.find((event) => event.event === "response");
    const entry = Object.freeze({ source: "base", taskId: task.taskId, consumed: classification.consumed,
      status: classification.status, category: response?.outcome?.error?.category ?? null, usage,
      auditFile: `llm-calls/${baseAuditName(task)}`, auditDigest: sha(bytes) });
    attempts.push(entry); base.set(task.taskId, entry);
    if (artifactNames.has(baseArtifactName(task))) {
      const artifactBytes = await privateFile(join(paths.artifacts, baseArtifactName(task)));
      const artifact = JSON.parse(artifactBytes.toString("utf8"));
      successful.set(task.taskId, artifact.result); summaries.set(task.taskId, artifact.summary);
    } else if (classification.status === "completed") throw new Error("Completed lexical base task has no artifact");
  }
  const retryNames = (await readdir(paths.retries)).filter((name) => name.endsWith(".metadata.json")).sort();
  const retries = [];
  for (const metadataName of retryNames) {
    const metadataBytes = await privateFile(join(paths.retries, metadataName)); const metadata = JSON.parse(metadataBytes.toString("utf8"));
    const stem = metadataName.replace(/\.metadata\.json$/u, ""); const auditName = `${stem}.jsonl`;
    const auditBytes = await privateFile(join(paths.retries, auditName)); const events = parseEvents(auditBytes);
    const classification = classifyLexicalAuditEvents(events); const usage = lexicalAuditUsage(events); const taskId = retryTaskId(metadata);
    const task = taskById.get(taskId); if (!task) throw new Error("Lexical recovery retry has unknown task");
    const requestEvent = events.find((event) => event.event === "request");
    if (classification.consumed && sha(requestEvent?.request?.body) !== metadata.requestBodyDigest) {
      throw new Error("Lexical recovery retry body digest mismatch");
    }
    const response = events.find((event) => event.event === "response");
    const entry = Object.freeze({ source: "recovery", taskId, action: metadata.action ?? "probe", modelId: metadata.modelId,
      consumed: classification.consumed, status: classification.status, category: response?.outcome?.error?.category ?? null,
      usage, auditFile: `retries/${auditName}`, auditDigest: sha(auditBytes), metadataFile: `retries/${metadataName}` });
    attempts.push(entry); retries.push(Object.freeze({ metadata, entry, events, task }));
  }
  // Only same-model strict successes can recover the frozen experiment result. A Pro probe remains usage evidence only.
  for (const retry of retries.filter((item) => item.entry.status === "completed" && item.entry.modelId === LEXICAL_EXPERIMENT_MODEL)) {
    if (successful.has(retry.task.taskId)) continue;
    const request = expectedRequest(retry.task, coverages, successful); if (!request) continue;
    if (sha(expectedBody(request)) !== retry.metadata.requestBodyDigest) throw new Error("Lexical recovery request drift detected");
    const restored = reconstruct(retry.task, retry.events, request, benchmark); if (!restored) continue;
    successful.set(retry.task.taskId, restored.result); summaries.set(retry.task.taskId, restored.summary);
  }
  const recoveryAttempted = new Set(retries.filter((item) => item.metadata.action === "failure-retry").map((item) => item.task.taskId));
  const logical = tasks.map((task) => Object.freeze({ taskId: task.taskId, stage: task.stage,
    status: successful.has(task.taskId) ? "completed" : base.get(task.taskId)?.status ?? "not-started",
    summary: summaries.get(task.taskId) ?? null }));
  return Object.freeze({ attempts: Object.freeze(attempts), successful, base, retries: Object.freeze(retries),
    recoveryAttempted, logical: Object.freeze(logical) });
}
function eligibleTasks(tasks, state) {
  const logical = new Map(state.logical.map((item) => [item.taskId, item.status]));
  const dependenciesReady = (task) => task.dependencyTaskIds.every((taskId) => state.successful.has(taskId));
  const failures = tasks.filter((task) => logical.get(task.taskId) === "failed" && !state.recoveryAttempted.has(task.taskId)
    && state.base.get(task.taskId)?.category === "malformed-response" && dependenciesReady(task));
  const unstarted = tasks.filter((task) => logical.get(task.taskId) === "not-started" && dependenciesReady(task));
  return Object.freeze((failures.length > 0 ? failures : unstarted).sort((left, right) => left.sequence - right.sequence));
}
async function executeAttempt(task, request, paths, credentialFd, ordinal, action) {
  const stem = `${String(ordinal).padStart(4, "0")}-${action}-${task.taskId}`;
  const auditPath = join(paths.retries, `${stem}.jsonl`); const metadataPath = join(paths.retries, `${stem}.metadata.json`);
  const body = expectedBody(request); const baseEntry = action === "failure-retry" ? paths.base.get(task.taskId) : null;
  const metadata = { schemaVersion: "m5e-lexical-explicit-retry-v1", taskId: task.taskId, action,
    retryOf: baseEntry?.auditFile?.replace(/^llm-calls\//u, "") ?? null,
    authorization: "user-explicit-resume-failed-and-continue-2026-08-04", reason: action,
    apiMode: "deepseek-openai-compatible-chat-completions", modelId: LEXICAL_EXPERIMENT_MODEL, thinking: "enabled",
    temperatureSemantics: "ignored-by-provider-in-thinking-mode", requestBodyDigest: sha(body) };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o600 }); await chmod(metadataPath, 0o600);
  const audit = await open(auditPath, "wx", 0o600);
  try { await invokeM5CModelBroker({ credentialFd, auditFd: audit.fd, request },
    { entry: new URL("./m5e-lexical-broker-entry.mjs", import.meta.url), timeoutMs: 900_000, outputBytes: 32 * 1024 * 1024 }); }
  catch { /* the per-attempt audit is authoritative */ } finally { await audit.close(); }
}
async function writeRecoveryReport(paths, fixture, benchmark, tasks, state, status) {
  const usage = totals(state.attempts); const value = { schemaVersion: `${LEXICAL_EXPERIMENT_VERSION}-recovery-manifest-v1`, status,
    corpusDigest: fixture.corpusDigest, factSetDigest: fixture.manifest.factSetDigest, benchmarkDigest: benchmark.benchmarkDigest,
    logicalTasks: tasks.length, logical: state.logical, attempts: state.attempts, totals: usage,
    budgetExposureMicrosCny: lexicalExperimentBudgetExposure({ knownCostMicrosCny: usage.costMicrosCny,
      unknownUsageCalls: usage.unknownUsageCalls }), maximums: { actualAttempts: LEXICAL_EXPERIMENT_MAX_CALLS,
      concurrency: LEXICAL_EXPERIMENT_MAX_CONCURRENCY, costMicrosCny: LEXICAL_EXPERIMENT_MAX_COST_MICROS_CNY },
    modelId: LEXICAL_EXPERIMENT_MODEL, thinking: "enabled", temperatureEffective: false,
    braveCalls: 0, fetchCalls: 0, translationCalls: 0, qaCalls: 0, researchCalls: 0, persistenceWrites: 0 };
  await atomicJson(join(paths.root, "recovery-manifest.json"), { ...value, manifestDigest: sha(value) });
  if (status !== "running") await atomicJson(join(paths.root, "recovery-report.json"), { ...value, reportDigest: sha(value) });
  return value;
}

let fixture; let credential;
try {
  const root = await privateDirectory(process.env.M5E_LEXICAL_EXPERIMENT_OUTPUT_DIR);
  const paths = { root, calls: await privateDirectory(join(root, "llm-calls")),
    artifacts: await privateDirectory(join(root, "artifacts")), retries: await privateDirectory(join(root, "retries"), true), base: null };
  fixture = await createDetectorV3Fixture(process.env.M5E_DETECTOR_V3_CORPUS);
  const coverages = fixture.documents.map((document) => assembleDetectorV3Coverage({ document, approvedTerms: fixture.approvedTerms,
    retriever: fixture.retriever }));
  Object.defineProperty(coverages, "approvedTerms", { value: fixture.approvedTerms });
  const tasks = buildLexicalExperimentPlan(fixture.documents);
  const benchmarkValue = await reference(process.env.M5E_LEXICAL_REFERENCE_PROPOSAL, process.env.M5E_LEXICAL_REFERENCE_PROPOSAL_DIGEST);
  const benchmark = buildLexicalReferenceBenchmark(benchmarkValue, fixture.documents);
  let state = await rebuild(tasks, paths, coverages, benchmark); paths.base = state.base;
  if (mode === "rebuild") {
    const report = await writeRecoveryReport(paths, fixture, benchmark, tasks, state, "rebuilt");
    process.stdout.write(`${JSON.stringify({ status: "rebuilt", actualAttempts: report.totals.calls,
      successfulLogicalTasks: state.logical.filter((item) => item.status === "completed").length,
      failedLogicalTasks: state.logical.filter((item) => item.status === "failed").length,
      unknownLogicalTasks: state.logical.filter((item) => item.status === "unknown").length,
      notStartedLogicalTasks: state.logical.filter((item) => item.status === "not-started").length,
      retryableOrRunnable: eligibleTasks(tasks, state).length, totals: report.totals,
      budgetExposureMicrosCny: report.budgetExposureMicrosCny, credentialRead: false })}\n`);
  } else {
    credential = await openCredentialFile(process.env.DEEPSEEK_KEY_FILE);
    let status = "evidence-complete";
    while (true) {
      state = await rebuild(tasks, paths, coverages, benchmark); paths.base = state.base;
      const usage = totals(state.attempts); const eligible = eligibleTasks(tasks, state);
      if (eligible.length === 0) break;
      if (usage.calls >= LEXICAL_EXPERIMENT_MAX_CALLS) { status = "call-limit-stopped"; break; }
      const remainingCalls = LEXICAL_EXPERIMENT_MAX_CALLS - usage.calls;
      let wave = eligible.slice(0, Math.min(LEXICAL_EXPERIMENT_MAX_CONCURRENCY, remainingCalls));
      while (wave.length > 0 && !lexicalExperimentWaveAllowed({ knownCostMicrosCny: usage.costMicrosCny,
        unknownUsageCalls: usage.unknownUsageCalls, pendingCalls: wave.length })) wave = wave.slice(0, -1);
      if (wave.length === 0) { status = "budget-stopped"; break; }
      const ordinal = state.retries.length + 1;
      await Promise.allSettled(wave.map((task, index) => {
        const action = state.logical.find((item) => item.taskId === task.taskId)?.status === "failed" ? "failure-retry" : "continuation";
        const request = expectedRequest(task, coverages, state.successful); if (!request) throw new Error("Recovery dependency drift");
        return executeAttempt(task, request, { ...paths, base: state.base }, credential.fd, ordinal + index, action);
      }));
      state = await rebuild(tasks, paths, coverages, benchmark); paths.base = state.base;
      const progress = await writeRecoveryReport(paths, fixture, benchmark, tasks, state, "running");
      process.stderr.write(`${JSON.stringify({ type: "recovery-progress", actualAttempts: progress.totals.calls,
        successfulLogicalTasks: state.logical.filter((item) => item.status === "completed").length,
        budgetExposureMicrosCny: progress.budgetExposureMicrosCny })}\n`);
    }
    state = await rebuild(tasks, paths, coverages, benchmark); const report = await writeRecoveryReport(paths, fixture, benchmark, tasks, state, status);
    process.stdout.write(`${JSON.stringify({ status, actualAttempts: report.totals.calls,
      successfulLogicalTasks: state.logical.filter((item) => item.status === "completed").length,
      failedLogicalTasks: state.logical.filter((item) => item.status === "failed").length,
      unknownLogicalTasks: state.logical.filter((item) => item.status === "unknown").length,
      notStartedLogicalTasks: state.logical.filter((item) => item.status === "not-started").length,
      totals: report.totals, budgetExposureMicrosCny: report.budgetExposureMicrosCny })}\n`);
  }
} finally { await credential?.close(); await fixture?.close(); }
