import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { invokeM5CModelBroker } from "../src/m5c/model-broker-process.mjs";
import { assembleDetectorV3Coverage, buildDetectorV3Plan } from "../src/m5e/detector-v3.mjs";
import {
  buildPlannerExperimentMatrix,
  plannerExperimentPromptMetrics,
  PLANNER_EXPERIMENT_INITIAL_CALLS,
  PLANNER_EXPERIMENT_CONFIRM_CALLS,
  PLANNER_EXPERIMENT_MAX_CALLS,
  PLANNER_EXPERIMENT_MAX_CONCURRENCY,
  PLANNER_EXPERIMENT_MAX_COST_MICROS_CNY,
  PLANNER_EXPERIMENT_MAX_OUTPUT_TOKENS,
  PLANNER_EXPERIMENT_MODEL,
  PLANNER_EXPERIMENT_VERSION,
} from "../src/m5e/planner-prompt-experiment.mjs";
import { createDetectorV3Fixture } from "./m5e-detector-v3-fixture.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex")}`;
const COST_FIELDS = Object.freeze(["calls", "inputTokens", "outputTokens", "reasoningTokens", "totalTokens", "costMicrosCny", "durationMs"]);

async function privateOutput(path) {
  if (typeof path !== "string" || path.length < 1) throw new Error("M5E_PLANNER_EXPERIMENT_OUTPUT_DIR is required");
  await mkdir(path, { recursive: false, mode: 0o700 }); const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("Planner experiment output directory is invalid");
  const calls = join(path, "llm-calls"); const artifacts = join(path, "artifacts");
  await mkdir(calls, { mode: 0o700 }); await mkdir(artifacts, { mode: 0o700 }); return Object.freeze({ root: path, calls, artifacts });
}
async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600); await rename(temporary, path); await chmod(path, 0o600);
}
async function priorReport(path, expectedDigest) {
  if (typeof path !== "string" || typeof expectedDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(expectedDigest)) {
    throw new Error("Planner experiment prior report configuration is invalid");
  }
  const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0
    || stat.size < 1 || stat.size > 64 * 1024 * 1024) throw new Error("Planner experiment prior report is invalid");
  const bytes = await readFile(path); if (sha(bytes) !== expectedDigest) throw new Error("Planner experiment prior report digest mismatch");
  const value = JSON.parse(bytes.toString("utf8"));
  if (value?.schemaVersion !== `${PLANNER_EXPERIMENT_VERSION}-report` || value.status !== "completed"
    || value.entries?.length !== PLANNER_EXPERIMENT_INITIAL_CALLS || value.totals?.calls !== PLANNER_EXPERIMENT_INITIAL_CALLS
    || value.corpusDigest !== "sha256:3defc2a47e53e946e950211232c3250dcc173619f32c44d9c46ebe163e0667da") {
    throw new Error("Planner experiment prior report content is invalid");
  }
  return Object.freeze({ value, fileDigest: expectedDigest });
}
function usageFromEvents(events) {
  const values = events.filter((event) => event.event === "response").map((event) => event.response?.usage).filter(Boolean);
  if (values.length !== 1) throw new Error("Planner experiment requires exactly one billed response per task");
  const item = values[0]; const inputTokens = item.prompt_tokens, outputTokens = item.completion_tokens, totalTokens = item.total_tokens;
  if (![inputTokens, outputTokens, totalTokens].every((value) => Number.isSafeInteger(value) && value >= 0) || inputTokens + outputTokens !== totalTokens) {
    throw new Error("Planner experiment usage is invalid");
  }
  const reasoningTokens = Number.isSafeInteger(item.completion_tokens_details?.reasoning_tokens) ? item.completion_tokens_details.reasoning_tokens : 0;
  return Object.freeze({ calls: 1, inputTokens, outputTokens, reasoningTokens, totalTokens,
    costMicrosCny: Math.ceil((inputTokens * 28 + outputTokens * 56) / 10),
    durationMs: events.filter((event) => event.event === "response").reduce((sum, event) => sum + (event.elapsedMs ?? 0), 0) });
}
function add(target, value) { for (const field of COST_FIELDS) target[field] += value[field]; }
function summary(plan) {
  const resolutions = Object.fromEntries([...new Set(plan.knowledgeIdentities.map((item) => item.resolution))].sort()
    .map((value) => [value, plan.knowledgeIdentities.filter((item) => item.resolution === value).length]));
  const signatures = plan.knowledgeIdentities.map((item) => sha([item.kind, item.sourceSpans.map((span) => [span.segmentId, span.text]).sort()])).sort();
  return Object.freeze({ items: plan.knowledgeIdentities.length, researchBatches: plan.researchBatches.length,
    resolutions: Object.freeze(resolutions), signatureSetDigest: sha(signatures), signatures: Object.freeze(signatures), planDigest: plan.planDigest });
}
async function executeTask(task, credentialFd, output) {
  const auditPath = join(output.calls, `${String(task.sequence).padStart(4, "0")}-${task.taskId}.jsonl`);
  const handle = await open(auditPath, "wx", 0o600); await chmod(auditPath, 0o600); let response; let error;
  try {
    response = await invokeM5CModelBroker({ credentialFd, auditFd: handle.fd,
      request: { coverage: task.coverage, modelId: PLANNER_EXPERIMENT_MODEL, maxOutputTokens: PLANNER_EXPERIMENT_MAX_OUTPUT_TOKENS,
        maximumAttempts: 1, promptVariant: task.promptVariant, temperature: task.temperature } },
    { entry: new URL("./m5e-detector-v3-broker-entry.mjs", import.meta.url), timeoutMs: 900_000, outputBytes: 32 * 1024 * 1024 });
  } catch (caught) { error = caught; } finally { await handle.close(); }
  const bytes = await readFile(auditPath); const events = bytes.toString("utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  if (events.filter((event) => event.event === "request").length !== 1 || events.filter((event) => event.event === "response").length !== 1) {
    throw new Error("Planner experiment audit sequence is incomplete");
  }
  const usage = usageFromEvents(events); let planSummary = null;
  if (!error) { const plan = buildDetectorV3Plan(response, task.coverage); planSummary = summary(plan);
    await atomicJson(join(output.artifacts, `${String(task.sequence).padStart(4, "0")}-${task.taskId}.json`),
      { schemaVersion: `${PLANNER_EXPERIMENT_VERSION}-artifact`, task: { ...task, coverage: undefined }, response, plan, summary: planSummary }); }
  const final = events.at(-1); return Object.freeze({ sequence: task.sequence, taskId: task.taskId, documentId: task.documentId,
    sourceLanguage: task.sourceLanguage, targetLanguage: task.targetLanguage, promptVariant: task.promptVariant, temperature: task.temperature,
    repeat: task.repeat, status: error ? "failed" : "completed", error: error ? Object.freeze({ category: error?.category ?? "provider",
      providerCode: error?.providerCode ?? null }) : null, normalized: final.outcome?.normalized === true, finishReason: final.response?.finishReason ?? null,
    usage, auditFile: auditPath.split("/").at(-1), auditDigest: sha(bytes), plan: planSummary });
}

const mode = process.env.M5E_PLANNER_EXPERIMENT_MODE;
if (!new Set(["dry-run", "execute-initial", "execute-confirmation"]).has(mode)) throw new Error("Planner experiment mode is invalid");
let fixture; let credential;
try {
  fixture = await createDetectorV3Fixture(process.env.M5E_DETECTOR_V3_CORPUS);
  const coverages = fixture.documents.map((document) => assembleDetectorV3Coverage({ document, approvedTerms: fixture.approvedTerms, retriever: fixture.retriever }));
  const confirmation = mode === "execute-confirmation"; const selectedTemperature = Number(process.env.M5E_PLANNER_EXPERIMENT_TEMPERATURE);
  const tasks = buildPlannerExperimentMatrix(coverages, confirmation ? { phase: "confirmation",
    promptVariant: process.env.M5E_PLANNER_EXPERIMENT_PROMPT_VARIANT, temperature: selectedTemperature } : undefined);
  const promptMetrics = plannerExperimentPromptMetrics(coverages);
  if (mode === "dry-run") {
    process.stdout.write(`${JSON.stringify({ schemaVersion: `${PLANNER_EXPERIMENT_VERSION}-preflight`, status: "ready",
      corpusDigest: fixture.corpusDigest, factSetDigest: fixture.manifest.factSetDigest, modelId: PLANNER_EXPERIMENT_MODEL,
      thinking: "enabled", actualAttempts: tasks.length, expectedActualAttempts: PLANNER_EXPERIMENT_INITIAL_CALLS,
      maximumConcurrency: PLANNER_EXPERIMENT_MAX_CONCURRENCY, maximumCostMicrosCny: PLANNER_EXPERIMENT_MAX_COST_MICROS_CNY,
      maximumOutputTokens: PLANNER_EXPERIMENT_MAX_OUTPUT_TOKENS, promptMetrics, credentialRead: false,
      braveCalls: 0, fetchCalls: 0, translationCalls: 0, qaCalls: 0, researchCalls: 0 })}\n`);
  } else {
    const prior = confirmation ? await priorReport(process.env.M5E_PLANNER_EXPERIMENT_PRIOR_REPORT,
      process.env.M5E_PLANNER_EXPERIMENT_PRIOR_REPORT_DIGEST) : null;
    const output = await privateOutput(process.env.M5E_PLANNER_EXPERIMENT_OUTPUT_DIR); credential = await openCredentialFile(process.env.DEEPSEEK_KEY_FILE);
    const totals = Object.fromEntries(COST_FIELDS.map((field) => [field, 0])); const entries = [];
    for (let cursor = 0; cursor < tasks.length; cursor += PLANNER_EXPERIMENT_MAX_CONCURRENCY) {
      const wave = tasks.slice(cursor, cursor + PLANNER_EXPERIMENT_MAX_CONCURRENCY);
      const results = await Promise.all(wave.map((task) => executeTask(task, credential.fd, output)));
      for (const result of results) { entries.push(result); add(totals, result.usage); }
      await atomicJson(join(output.root, "manifest.json"), { schemaVersion: `${PLANNER_EXPERIMENT_VERSION}-manifest`, status: "running",
        corpusDigest: fixture.corpusDigest, entries, totals });
      process.stderr.write(`${JSON.stringify({ type: "progress", completed: entries.length, successful: entries.filter((item) => item.status === "completed").length,
        costMicrosCny: totals.costMicrosCny })}\n`);
      const cumulativeCalls = (prior?.value.totals.calls ?? 0) + totals.calls;
      const cumulativeCost = (prior?.value.totals.costMicrosCny ?? 0) + totals.costMicrosCny;
      const phaseMaximum = confirmation ? PLANNER_EXPERIMENT_CONFIRM_CALLS : PLANNER_EXPERIMENT_INITIAL_CALLS;
      if (totals.calls !== entries.length || totals.calls > phaseMaximum || cumulativeCalls > PLANNER_EXPERIMENT_MAX_CALLS
        || cumulativeCost > PLANNER_EXPERIMENT_MAX_COST_MICROS_CNY) {
        throw Object.assign(new Error("Planner experiment budget exceeded"), { category: "budget" });
      }
    }
    const report = { schemaVersion: `${PLANNER_EXPERIMENT_VERSION}-report`, status: "completed", corpusDigest: fixture.corpusDigest,
      factSetDigest: fixture.manifest.factSetDigest, modelId: PLANNER_EXPERIMENT_MODEL, thinking: "enabled", promptMetrics, entries, totals,
      phase: confirmation ? "confirmation" : "initial", selectedConfiguration: confirmation ? {
        promptVariant: process.env.M5E_PLANNER_EXPERIMENT_PROMPT_VARIANT, temperature: selectedTemperature } : null,
      prior: prior ? { reportFileDigest: prior.fileDigest, calls: prior.value.totals.calls, costMicrosCny: prior.value.totals.costMicrosCny } : null,
      cumulativeTotals: prior ? Object.fromEntries(COST_FIELDS.map((field) => [field, prior.value.totals[field] + totals[field]])) : totals,
      maximums: { actualAttempts: confirmation ? PLANNER_EXPERIMENT_CONFIRM_CALLS : PLANNER_EXPERIMENT_INITIAL_CALLS,
        cumulativeActualAttempts: PLANNER_EXPERIMENT_MAX_CALLS, concurrency: PLANNER_EXPERIMENT_MAX_CONCURRENCY,
        costMicrosCny: PLANNER_EXPERIMENT_MAX_COST_MICROS_CNY, outputTokens: PLANNER_EXPERIMENT_MAX_OUTPUT_TOKENS },
      braveCalls: 0, fetchCalls: 0, translationCalls: 0, qaCalls: 0, researchCalls: 0, persistenceWrites: 0 };
    await atomicJson(join(output.root, "report.json"), report); await atomicJson(join(output.root, "manifest.json"), { ...report, reportDigest: sha(report) });
    process.stdout.write(`${JSON.stringify({ status: "completed", actualAttempts: totals.calls,
      successful: entries.filter((item) => item.status === "completed").length, failed: entries.filter((item) => item.status === "failed").length,
      totals, reportDigest: sha(report), outputPermissions: "0700/0600" })}\n`);
  }
} finally { await credential?.close(); await fixture?.close(); }
