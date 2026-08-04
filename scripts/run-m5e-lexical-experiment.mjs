import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
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
  LEXICAL_EXPERIMENT_TEMPERATURE,
  LEXICAL_EXPERIMENT_VERSION,
} from "../src/m5e/lexical-experiment.mjs";
import { buildLexicalReferenceBenchmark, scoreLexicalReferenceBenchmark } from "../src/m5e/lexical-reference-benchmark.mjs";
import { classifyLexicalAuditEvents, lexicalAuditUsage, lexicalRunnableTasks } from "../src/m5e/lexical-experiment-recovery.mjs";
import { createDetectorV3Fixture } from "./m5e-detector-v3-fixture.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value)
  ? value : JSON.stringify(value)).digest("hex")}`;
const COST_FIELDS = Object.freeze(["calls", "inputTokens", "outputTokens", "reasoningTokens", "totalTokens", "costMicrosCny", "durationMs"]);
const mode = process.env.M5E_LEXICAL_EXPERIMENT_MODE;
if (!["dry-run", "execute", "resume"].includes(mode)) throw new Error("Lexical experiment mode is invalid");

async function outputRoot(path, resume) {
  if (typeof path !== "string" || path.length < 1) throw new Error("M5E_LEXICAL_EXPERIMENT_OUTPUT_DIR is required");
  if (!resume) { await mkdir(path, { recursive: false, mode: 0o700 }); await mkdir(join(path, "llm-calls"), { mode: 0o700 });
    await mkdir(join(path, "artifacts"), { mode: 0o700 }); }
  for (const value of [path, join(path, "llm-calls"), join(path, "artifacts")]) {
    const stat = await lstat(value); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
      throw new Error("Lexical experiment output directory is invalid");
    }
  }
  return Object.freeze({ root: path, calls: join(path, "llm-calls"), artifacts: join(path, "artifacts") });
}
async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600); await rename(temporary, path); await chmod(path, 0o600);
}
async function privateJson(path, expectedDigest, maximum = 4 * 1024 * 1024) {
  if (typeof path !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(expectedDigest ?? "")) throw new Error("Private JSON configuration is invalid");
  const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0
    || stat.size < 1 || stat.size > maximum) throw new Error("Private JSON file is invalid");
  const bytes = await readFile(path); if (sha(bytes) !== expectedDigest) throw new Error("Private JSON digest mismatch");
  return Object.freeze({ value: JSON.parse(bytes.toString("utf8")), fileDigest: expectedDigest });
}
function auditName(task) { return `${String(task.sequence).padStart(4, "0")}-${task.taskId}.jsonl`; }
function artifactName(task) { return `${String(task.sequence).padStart(4, "0")}-${task.taskId}.json`; }
function parseEvents(bytes) {
  const source = bytes.toString("utf8").trim(); if (source.length === 0) return [];
  return source.split("\n").map((line) => JSON.parse(line));
}
function totals(entries) {
  const value = { ...Object.fromEntries(COST_FIELDS.map((field) => [field, 0])), unknownUsageCalls: 0 };
  for (const entry of entries.filter((item) => item.consumed)) {
    value.calls += 1; if (!entry.usage) { value.unknownUsageCalls += 1; continue; }
    for (const field of COST_FIELDS.filter((name) => name !== "calls")) value[field] += entry.usage[field];
  }
  return value;
}
function stageAResultFor(task, successful) {
  const values = task.dependencyTaskIds.map((taskId) => successful.get(taskId));
  if (values.some((value) => !value)) return null; return mergeLexicalStageAResults(values);
}
function expectedRequest(task, coverages, fixture, successful) {
  if (task.stage === "stage-a") return Object.freeze({ stage: "stage-a", coverage: coverages[task.documentIndex],
    approvedTerms: fixture.approvedTerms, modelId: LEXICAL_EXPERIMENT_MODEL,
    maxOutputTokens: LEXICAL_EXPERIMENT_MAX_OUTPUT_TOKENS, maximumAttempts: 1 });
  const stageAResult = stageAResultFor(task, successful); if (!stageAResult) return null;
  return Object.freeze({ stage: "stage-b", stageAResult, modelId: LEXICAL_EXPERIMENT_MODEL,
    maxOutputTokens: LEXICAL_EXPERIMENT_MAX_OUTPUT_TOKENS, maximumAttempts: 1 });
}
function expectedBody(request) {
  return request.stage === "stage-a" ? buildLexicalStageABody(request) : buildLexicalStageBBody(request);
}
function reconstruct(task, events, request, benchmark) {
  const response = events.find((event) => event.event === "response");
  if (!response || response.outcome?.normalized !== true || typeof response.response?.content !== "string") return null;
  let payload; try { payload = JSON.parse(response.response.content); } catch { throw new Error("Normalized lexical response cannot be decoded"); }
  const result = task.stage === "stage-a" ? normalizeLexicalStageAPayload(payload, request.coverage, request.approvedTerms)
    : normalizeLexicalStageBPayload(payload, request.stageAResult);
  const summary = task.stage === "stage-a" ? stageASummary(result, benchmark) : stageBSummary(result, request.stageAResult, benchmark);
  return Object.freeze({ result, summary });
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
  const coveredCandidates = stageAResult.candidates.length - inputCandidates;
  const research = result.groups.filter((item) => item.decision === "research");
  return Object.freeze({ stageACandidates: stageAResult.candidates.length, coveredCandidates, inputCandidates,
    benchmark: scoreLexicalReferenceBenchmark(benchmark, stageAResult.candidates), groups: result.groups.length, researchGroups: research.length,
    translateDirectlyGroups: result.groups.length - research.length, researchNeeds: research.reduce((sum, item) => sum + item.needs.length, 0),
    singletonGroups: result.groups.filter((item) => item.memberCandidateIds.length === 1).length,
    maximumGroupSize: Math.max(0, ...result.groups.map((item) => item.memberCandidateIds.length)) });
}
async function validateFile(path, kind) {
  const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Lexical ${kind} file is invalid`);
  }
  return readFile(path);
}

async function rebuildState(tasks, output, coverages, fixture, benchmark) {
  const knownNames = new Set(tasks.map(auditName)); const names = await readdir(output.calls);
  if (names.some((name) => !knownNames.has(name))) throw new Error("Lexical audit contains an unknown task");
  const knownArtifacts = new Set(tasks.map(artifactName)); const observedArtifactNames = await readdir(output.artifacts);
  for (const name of observedArtifactNames.filter((item) => !knownArtifacts.has(item))) {
    const match = /^(.*\.json)\.[0-9]+\.tmp$/u.exec(name);
    if (!match || !knownArtifacts.has(match[1])) throw new Error("Lexical artifacts contain an unknown task");
    await validateFile(join(output.artifacts, name), "temporary artifact"); await unlink(join(output.artifacts, name));
  }
  const artifactNames = new Set((await readdir(output.artifacts)).filter((name) => knownArtifacts.has(name)));
  const successful = new Map(); const entries = []; const reusable = new Set();
  for (const task of tasks) {
    const name = auditName(task); const hasArtifact = artifactNames.has(artifactName(task));
    if (!names.includes(name)) { if (hasArtifact) throw new Error("Lexical artifact has no consumed task"); continue; }
    const path = join(output.calls, name);
    const bytes = await validateFile(path, "audit"); const events = parseEvents(bytes);
    const classification = classifyLexicalAuditEvents(events); const requests = events.filter((event) => event.event === "request");
    const responses = events.filter((event) => event.event === "response");
    if (!classification.consumed) {
      if (hasArtifact) throw new Error("Lexical artifact has no consumed task"); reusable.add(task.taskId); continue;
    }
    const request = expectedRequest(task, coverages, fixture, successful); if (!request) throw new Error("Consumed lexical task has missing dependencies");
    if (sha(requests[0].request?.body) !== sha(expectedBody(request))) throw new Error("Lexical request body drift detected");
    const restored = reconstruct(task, events, request, benchmark); const usage = lexicalAuditUsage(events);
    const status = restored ? "completed" : classification.status;
    const entry = Object.freeze({ sequence: task.sequence, taskId: task.taskId, stage: task.stage, documentId: task.documentId,
      repeat: task.repeat, unionWidth: task.unionWidth, dependencyTaskIds: task.dependencyTaskIds, consumed: true, status,
      error: restored ? null : responses.at(-1)?.outcome?.error ?? Object.freeze({ category: "unknown-outcome" }), usage,
      auditFile: name, auditDigest: sha(bytes), artifactFile: restored ? artifactName(task) : null, summary: restored?.summary ?? null });
    entries.push(entry);
    if (restored) {
      successful.set(task.taskId, restored.result); const artifactPath = join(output.artifacts, artifactName(task));
      const artifact = { schemaVersion: `${LEXICAL_EXPERIMENT_VERSION}-artifact`, task, result: restored.result, summary: restored.summary };
      try { const existing = await validateFile(artifactPath, "artifact"); if (sha(existing) !== sha(`${JSON.stringify(artifact, null, 2)}\n`)) {
        throw new Error("Lexical artifact drift detected"); } } catch (error) {
        if (error?.code !== "ENOENT") throw error; await atomicJson(artifactPath, artifact);
      }
    } else if (hasArtifact) throw new Error("Lexical artifact exists for an unsuccessful task");
  }
  return Object.freeze({ entries: Object.freeze(entries), successful, reusable });
}

async function executeTask(task, request, credentialFd, output) {
  const path = join(output.calls, auditName(task)); let handle;
  try { handle = await open(path, "wx", 0o600); } catch (error) { if (error?.code !== "EEXIST") throw error;
    const bytes = await validateFile(path, "audit"); if (parseEvents(bytes).length !== 0) throw new Error("Consumed lexical task cannot be reissued");
    handle = await open(path, "a", 0o600); }
  await chmod(path, 0o600);
  try {
    await invokeM5CModelBroker({ credentialFd, auditFd: handle.fd, request },
      { entry: new URL("./m5e-lexical-broker-entry.mjs", import.meta.url), timeoutMs: 900_000, outputBytes: 32 * 1024 * 1024 });
  } catch { /* audit is the authoritative outcome */ } finally { await handle.close(); }
}

async function writeManifest(output, fixture, benchmark, state, status) {
  const usage = totals(state.entries); const value = { schemaVersion: `${LEXICAL_EXPERIMENT_VERSION}-manifest`, status,
    corpusDigest: fixture.corpusDigest, factSetDigest: fixture.manifest.factSetDigest, benchmarkDigest: benchmark.benchmarkDigest,
    entries: state.entries, totals: usage, budgetExposureMicrosCny: lexicalExperimentBudgetExposure({ knownCostMicrosCny: usage.costMicrosCny,
      unknownUsageCalls: usage.unknownUsageCalls }) };
  await atomicJson(join(output.root, "manifest.json"), { ...value, manifestDigest: sha(value) }); return value;
}

let fixture; let credential;
try {
  fixture = await createDetectorV3Fixture(process.env.M5E_DETECTOR_V3_CORPUS);
  const coverages = fixture.documents.map((document) => assembleDetectorV3Coverage({ document, approvedTerms: fixture.approvedTerms,
    retriever: fixture.retriever }));
  const tasks = buildLexicalExperimentPlan(fixture.documents); const reference = await privateJson(process.env.M5E_LEXICAL_REFERENCE_PROPOSAL,
    process.env.M5E_LEXICAL_REFERENCE_PROPOSAL_DIGEST); const benchmark = buildLexicalReferenceBenchmark(reference.value, fixture.documents);
  if (mode === "dry-run") {
    const stageAMetrics = coverages.map((coverage) => { const body = buildLexicalStageABody({ coverage, modelId: LEXICAL_EXPERIMENT_MODEL,
      maxOutputTokens: LEXICAL_EXPERIMENT_MAX_OUTPUT_TOKENS }); return Object.freeze({ documentId: coverage.document.documentId,
      systemCharacters: body.messages[0].content.length, userCharacters: body.messages[1].content.length, bodyDigest: sha(body) }); });
    process.stdout.write(`${JSON.stringify({ schemaVersion: `${LEXICAL_EXPERIMENT_VERSION}-preflight`, status: "ready",
      corpusDigest: fixture.corpusDigest, factSetDigest: fixture.manifest.factSetDigest, referenceFileDigest: reference.fileDigest,
      benchmark: { lexicalFamilies: benchmark.lexicalFamilies, anchoredFamilies: benchmark.anchoredFamilies.length,
        unanchoredFamilies: benchmark.unanchoredFamilyIds.length, exactSurfaces: benchmark.exactSurfaces.length,
        benchmarkDigest: benchmark.benchmarkDigest }, modelId: LEXICAL_EXPERIMENT_MODEL, thinking: "enabled",
      temperature: LEXICAL_EXPERIMENT_TEMPERATURE, logicalTasks: tasks.length,
      stages: Object.fromEntries(["stage-a", "stage-b-single", "stage-b-pair", "stage-b-union8"].map((stage) => [stage,
        tasks.filter((task) => task.stage === stage).length])), maximumActualAttempts: LEXICAL_EXPERIMENT_MAX_CALLS,
      maximumConcurrency: LEXICAL_EXPERIMENT_MAX_CONCURRENCY, maximumCostMicrosCny: LEXICAL_EXPERIMENT_MAX_COST_MICROS_CNY,
      maximumOutputTokens: LEXICAL_EXPERIMENT_MAX_OUTPUT_TOKENS, stageAMetrics, credentialRead: false,
      maximumAttemptsPerTask: 1, braveCalls: 0, fetchCalls: 0, translationCalls: 0, qaCalls: 0, researchCalls: 0,
      persistenceWrites: 0 })}\n`);
  } else {
    const output = await outputRoot(process.env.M5E_LEXICAL_EXPERIMENT_OUTPUT_DIR, mode === "resume");
    credential = await openCredentialFile(process.env.DEEPSEEK_KEY_FILE);
    let stoppedByBudget = false; let stoppedByLocalFailure = false; const attemptedThisRun = new Set();
    while (true) {
      let state = await rebuildState(tasks, output, coverages, fixture, benchmark); const usage = totals(state.entries);
      const taskStates = new Map(state.entries.map((entry) => [entry.taskId, entry.status]));
      const runnable = lexicalRunnableTasks(tasks, taskStates);
      const eligible = lexicalRunnableTasks(tasks, taskStates, attemptedThisRun);
      if (eligible.length === 0 || usage.calls >= LEXICAL_EXPERIMENT_MAX_CALLS) {
        stoppedByLocalFailure = runnable.length > 0 && eligible.length === 0; break;
      }
      const wave = eligible.slice(0, LEXICAL_EXPERIMENT_MAX_CONCURRENCY);
      if (!lexicalExperimentWaveAllowed({ knownCostMicrosCny: usage.costMicrosCny, unknownUsageCalls: usage.unknownUsageCalls,
        pendingCalls: wave.length })) { stoppedByBudget = true; break; }
      wave.forEach((task) => attemptedThisRun.add(task.taskId));
      await Promise.allSettled(wave.map((task) => executeTask(task, expectedRequest(task, coverages, fixture, state.successful), credential.fd, output)));
      state = await rebuildState(tasks, output, coverages, fixture, benchmark); await writeManifest(output, fixture, benchmark, state, "running");
      const current = totals(state.entries); process.stderr.write(`${JSON.stringify({ type: "progress", actualAttempts: current.calls,
        successful: state.entries.filter((entry) => entry.status === "completed").length, unknown: current.unknownUsageCalls,
        costMicrosCny: current.costMicrosCny, budgetExposureMicrosCny: lexicalExperimentBudgetExposure({ knownCostMicrosCny: current.costMicrosCny,
          unknownUsageCalls: current.unknownUsageCalls }) })}\n`);
    }
    const state = await rebuildState(tasks, output, coverages, fixture, benchmark); const usage = totals(state.entries);
    const blocked = tasks.filter((task) => !state.entries.some((entry) => entry.taskId === task.taskId)
      && task.dependencyTaskIds.some((taskId) => !state.successful.has(taskId))).map((task) => task.taskId);
    const status = stoppedByBudget ? "budget-stopped" : stoppedByLocalFailure ? "local-stopped" : "completed";
    const manifest = await writeManifest(output, fixture, benchmark, state, status);
    const report = { schemaVersion: `${LEXICAL_EXPERIMENT_VERSION}-report`, ...manifest, logicalTasks: tasks.length,
      blockedDependencyTasks: blocked, maximums: { actualAttempts: LEXICAL_EXPERIMENT_MAX_CALLS,
        concurrency: LEXICAL_EXPERIMENT_MAX_CONCURRENCY, costMicrosCny: LEXICAL_EXPERIMENT_MAX_COST_MICROS_CNY,
        outputTokens: LEXICAL_EXPERIMENT_MAX_OUTPUT_TOKENS }, modelId: LEXICAL_EXPERIMENT_MODEL, thinking: "enabled",
      temperature: LEXICAL_EXPERIMENT_TEMPERATURE, referenceStatus: "pending-user-confirmation",
      braveCalls: 0, fetchCalls: 0, translationCalls: 0, qaCalls: 0, researchCalls: 0, persistenceWrites: 0 };
    await atomicJson(join(output.root, "report.json"), { ...report, reportDigest: sha(report) });
    process.stdout.write(`${JSON.stringify({ status, actualAttempts: usage.calls,
      successful: state.entries.filter((entry) => entry.status === "completed").length,
      failed: state.entries.filter((entry) => entry.status === "failed").length,
      unknown: state.entries.filter((entry) => entry.status === "unknown").length,
      blockedDependencyTasks: blocked.length, totals: usage, reportDigest: sha(report), outputPermissions: "0700/0600" })}\n`);
  }
} finally { await credential?.close(); await fixture?.close(); }
