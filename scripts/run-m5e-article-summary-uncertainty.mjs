import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import https from "node:https";
import { join } from "node:path";
import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { classifyTranslationUncertainWordsFailure } from "../src/m5e/translation-uncertain-words.mjs";
import {
  ARTICLE_SUMMARY_UNCERTAINTY_MAX_CONCURRENCY,
  ARTICLE_SUMMARY_UNCERTAINTY_MAX_COST_MICROS_CNY,
  ARTICLE_SUMMARY_UNCERTAINTY_MAX_TASKS,
  ARTICLE_SUMMARY_UNCERTAINTY_MODEL,
  ARTICLE_SUMMARY_UNCERTAINTY_PENDING_RESERVATION_MICROS_CNY,
  ARTICLE_SUMMARY_UNCERTAINTY_VERSION,
  buildArticleSummaryBody,
  buildArticleSummaryTranslationBody,
  buildArticleSummaryUncertaintyFixture,
  normalizeArticleSummaryPayload,
  normalizeArticleSummaryTranslationPayload,
  scoreArticleSummaryUncertainty,
} from "../src/m5e/article-summary-uncertainty.mjs";

const mode = process.env.M5E_ARTICLE_SUMMARY_UNCERTAINTY_MODE;
if (!["dry-run", "execute", "execute-summaries", "resume", "rebuild"].includes(mode)) throw new Error("article summary uncertainty mode is invalid");
const promptVariant = process.env.M5E_ARTICLE_SUMMARY_UNCERTAINTY_VARIANT ?? "target-language-v1";
if (!["target-language-v1", "source-language-v2", "abstract-source-v3"].includes(promptVariant)) throw new Error("article summary uncertainty variant is invalid");
const ORIGIN = "https://api.deepseek.com/chat/completions";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REFERENCE_DIGEST = "fe09844bed580c7e4609b869f95f5752ea761febf5fbe4196722f2c0e95935eb";
const sha = (value) => `sha256:${createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex")}`;

async function privateFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("article summary uncertainty input file is invalid");
  }
  return readFile(path);
}
async function privateDirectory(path, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("article summary uncertainty output directory is invalid");
  }
  return path;
}
async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600); await rename(temporary, path); await chmod(path, 0o600);
}
function usage(value, durationMs) {
  const inputTokens = value?.prompt_tokens; const outputTokens = value?.completion_tokens; const totalTokens = value?.total_tokens;
  const reasoningTokens = value?.completion_tokens_details?.reasoning_tokens ?? 0;
  const cacheHitTokens = value?.prompt_cache_hit_tokens ?? value?.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheMissTokens = value?.prompt_cache_miss_tokens ?? inputTokens - cacheHitTokens;
  if (![inputTokens, outputTokens, totalTokens, reasoningTokens, cacheHitTokens, cacheMissTokens].every((item) => Number.isSafeInteger(item) && item >= 0)
    || inputTokens + outputTokens !== totalTokens || cacheHitTokens + cacheMissTokens !== inputTokens || reasoningTokens > outputTokens) {
    throw Object.assign(new Error("usage is malformed"), { category: "malformed-response", providerCode: "usage" });
  }
  const costMicrosUsd = Math.ceil(cacheHitTokens * 0.003625 + cacheMissTokens * 0.435 + outputTokens * 0.87);
  return Object.freeze({ inputTokens, outputTokens, reasoningTokens, totalTokens, cacheHitTokens, cacheMissTokens,
    costMicrosUsd, costMicrosCny: costMicrosUsd * 8, durationMs });
}
function request(body, credential, timeoutMs = 900_000) {
  const bytes = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = https.request({ protocol: "https:", hostname: "api.deepseek.com", port: 443, path: "/chat/completions", method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", "content-length": bytes.length },
      timeout: timeoutMs, agent: false }, (response) => {
      const chunks = []; let size = 0;
      response.on("data", (chunk) => { size += chunk.length; if (size > MAX_RESPONSE_BYTES) response.destroy(Object.assign(new Error("response too large"), { category: "malformed-response" })); else chunks.push(chunk); });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("request timed out"), { category: "unknown-outcome" })));
    req.on("error", reject); req.end(bytes);
  });
}
const errorCategory = (status, error) => classifyTranslationUncertainWordsFailure(status, error?.category);
function bodyFor(task, summaries) {
  if (task.kind === "summary") return buildArticleSummaryBody(task, promptVariant);
  return buildArticleSummaryTranslationBody(task, task.arm === "summary" ? summaries.get(task.articleRef) : undefined, promptVariant);
}
function normalizeFor(payload, task) {
  return task.kind === "summary" ? normalizeArticleSummaryPayload(payload, task, promptVariant) : normalizeArticleSummaryTranslationPayload(payload, task);
}
async function invoke(task, summaries, credential, auditPath) {
  const body = bodyFor(task, summaries); const audit = await open(auditPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  await chmod(auditPath, 0o600); const started = Date.now(); const startedAt = new Date(started).toISOString();
  const append = async (value) => audit.appendFile(`${JSON.stringify(value)}\n`); let response; let rawText = null; let caught; let normalized; let normalizedUsage;
  await append({ event: "request", startedAt, taskId: task.taskId, kind: task.kind, arm: task.arm ?? null,
    request: { url: ORIGIN, method: "POST", headers: { "content-type": "application/json" }, body, bodyDigest: sha(body) } });
  try {
    response = await request(body, credential); rawText = response.bytes.toString("utf8"); let outer;
    try { outer = JSON.parse(rawText); } catch { throw Object.assign(new Error("outer response JSON is malformed"), { category: "malformed-response" }); }
    if (response.status !== 200) throw Object.assign(new Error("DeepSeek HTTP failure"), { category: errorCategory(response.status), providerCode: response.status });
    const choice = outer?.choices?.[0];
    if (!outer || typeof outer.id !== "string" || !Array.isArray(outer.choices) || outer.choices.length !== 1 || choice.index !== 0
      || choice.finish_reason !== "stop" || typeof choice.message?.content !== "string") {
      throw Object.assign(new Error("response envelope is malformed"), { category: "malformed-response" });
    }
    normalizedUsage = usage(outer.usage, Date.now() - started);
    let payload; try { payload = JSON.parse(choice.message.content); } catch { throw Object.assign(new Error("response payload JSON is malformed"), { category: "malformed-response" }); }
    try { normalized = normalizeFor(payload, task); } catch { throw Object.assign(new Error("response payload schema is malformed"), { category: "malformed-response" }); }
  } catch (error) { caught = error; }
  await append({ event: "response", completedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
    response: response ? { status: response.status, headers: { "content-type": response.headers["content-type"] ?? null }, bodyBytes: response.bytes.length, rawBody: rawText } : null,
    outcome: caught ? { normalized: false, category: errorCategory(response?.status, caught), providerCode: caught.providerCode ?? null } : { normalized: true },
    usage: normalizedUsage ?? null }); await audit.close();
  if (caught) throw Object.assign(new Error("article summary uncertainty direct HTTP invocation failed"),
    { category: errorCategory(response?.status, caught), providerCode: caught.providerCode });
  return Object.freeze({ taskId: task.taskId, kind: task.kind, arm: task.arm ?? null, normalized, usage: normalizedUsage,
    status: "completed", auditFile: auditPath.split("/").at(-1) });
}
async function inputs() {
  const corpusBytes = await privateFile(process.env.M5E_ARTICLE_SUMMARY_UNCERTAINTY_CORPUS);
  const referenceBytes = await privateFile(process.env.M5E_ARTICLE_SUMMARY_UNCERTAINTY_REFERENCE);
  if (sha(referenceBytes) !== `sha256:${REFERENCE_DIGEST}`) throw new Error("article summary uncertainty reference digest changed");
  return Object.freeze({ fixture: buildArticleSummaryUncertaintyFixture(JSON.parse(corpusBytes), JSON.parse(referenceBytes)),
    corpusDigest: sha(corpusBytes), referenceDigest: sha(referenceBytes) });
}
function totals(records) {
  const value = { calls: records.length, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0,
    cacheHitTokens: 0, cacheMissTokens: 0, costMicrosUsd: 0, costMicrosCny: 0, durationMs: 0, unknownUsageCalls: 0 };
  for (const record of records) {
    if (!record.usage) { value.unknownUsageCalls += 1; continue; }
    for (const key of Object.keys(value).filter((item) => !["calls", "unknownUsageCalls"].includes(item))) value[key] += record.usage[key];
  }
  return value;
}
async function eventsFor(path) {
  try { return (await privateFile(path)).toString("utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
async function restored(paths, fixture) {
  const records = []; const summaries = new Map();
  for (const task of fixture.tasks) {
    const name = `${task.taskId}.jsonl`; const events = await eventsFor(join(paths.calls, name)); if (!events) continue;
    const requestEvent = events.find((item) => item.event === "request"); const responseEvent = events.find((item) => item.event === "response");
    const expectedBody = bodyFor(task, summaries);
    if (requestEvent?.taskId !== task.taskId || requestEvent.request?.url !== ORIGIN || requestEvent.request?.bodyDigest !== sha(expectedBody)) {
      throw new Error("article summary uncertainty request audit drifted");
    }
    let normalized = null; let normalizedUsage = responseEvent?.usage ?? null; let status = "unknown-outcome";
    if (responseEvent?.response?.rawBody) {
      try {
        const outer = JSON.parse(responseEvent.response.rawBody);
        if (responseEvent.response.status === 200) {
          normalizedUsage = usage(outer.usage, responseEvent.elapsedMs ?? 0);
          normalized = normalizeFor(JSON.parse(outer.choices[0].message.content), task); status = "completed";
        } else status = errorCategory(responseEvent.response.status);
      } catch { status = "malformed-response"; }
    }
    const record = Object.freeze({ taskId: task.taskId, kind: task.kind, arm: task.arm ?? null, normalized, usage: normalizedUsage, status, auditFile: name });
    records.push(record); if (task.kind === "summary" && normalized) summaries.set(task.articleRef, normalized);
  }
  return records;
}
function summaryMap(records) {
  return new Map(records.filter((record) => record.kind === "summary" && record.normalized).map((record) => [record.normalized.articleRef, record.normalized]));
}
async function writeReport(paths, source, records, status) {
  const translations = records.filter((item) => item.kind === "translation" && item.normalized).map((item) => item.normalized);
  const aggregate = totals(records); const score = scoreArticleSummaryUncertainty(source.fixture, translations);
  const report = { schemaVersion: `${ARTICLE_SUMMARY_UNCERTAINTY_VERSION}-report`, status, modelId: ARTICLE_SUMMARY_UNCERTAINTY_MODEL,
    corpusDigest: source.corpusDigest, referenceDigest: source.referenceDigest, fixtureDigest: source.fixture.fixtureDigest,
    maximumLogicalCalls: ARTICLE_SUMMARY_UNCERTAINTY_MAX_TASKS, maximumConcurrency: ARTICLE_SUMMARY_UNCERTAINTY_MAX_CONCURRENCY,
    maximumCostMicrosCny: ARTICLE_SUMMARY_UNCERTAINTY_MAX_COST_MICROS_CNY,
    pendingReservationMicrosCny: ARTICLE_SUMMARY_UNCERTAINTY_PENDING_RESERVATION_MICROS_CNY,
    promptVariant, automaticRetries: 0, unknownRetry: false, temperatureSent: false,
    logical: source.fixture.tasks.map((task) => ({ taskId: task.taskId, kind: task.kind, arm: task.arm ?? null,
      status: records.find((item) => item.taskId === task.taskId)?.status ?? "not-started" })), totals: aggregate,
    budgetExposureMicrosCny: aggregate.costMicrosCny + aggregate.unknownUsageCalls * ARTICLE_SUMMARY_UNCERTAINTY_PENDING_RESERVATION_MICROS_CNY,
    score, historicalEnabledCriticalFamilies: 8, searchCalls: 0, fetchCalls: 0, researchCalls: 0,
    retranslationCalls: 0, qaCalls: 0, persistenceWrites: 0 };
  await atomicJson(join(paths.root, "report.json"), { ...report, reportDigest: sha(report) });
  await atomicJson(join(paths.root, "blind-review.json"), { schemaVersion: `${ARTICLE_SUMMARY_UNCERTAINTY_VERSION}-blind-review`,
    status: "pending-user-review", summaries: records.filter((item) => item.kind === "summary" && item.normalized).map((item) => item.normalized),
    outputs: records.filter((item) => item.kind === "translation" && item.normalized).map((item) => ({ taskId: item.taskId, arm: item.arm,
      segments: item.normalized.segments })) });
  return report;
}

let credential;
try {
  const source = await inputs();
  if (mode === "dry-run") {
    process.stdout.write(`${JSON.stringify({ status: "ready-offline-api-closed", modelId: ARTICLE_SUMMARY_UNCERTAINTY_MODEL,
      criticalFamilies: source.fixture.families.length, articleSegments: source.fixture.articles.map((item) => item.segments.length),
      selectedSegments: source.fixture.packets.reduce((sum, packet) => sum + packet.segments.length, 0),
      packetSizes: source.fixture.packets.map((item) => item.segments.length), summaryCalls: source.fixture.summaryTasks.length,
      controlTranslationCalls: source.fixture.translationTasks.filter((item) => item.arm === "control").length,
      summaryTranslationCalls: source.fixture.translationTasks.filter((item) => item.arm === "summary").length,
      logicalCalls: source.fixture.tasks.length, maximumConcurrency: ARTICLE_SUMMARY_UNCERTAINTY_MAX_CONCURRENCY,
      maximumCostMicrosCny: ARTICLE_SUMMARY_UNCERTAINTY_MAX_COST_MICROS_CNY,
      pendingReservationMicrosCny: ARTICLE_SUMMARY_UNCERTAINTY_PENDING_RESERVATION_MICROS_CNY,
      promptVariant, temperatureSent: false, automaticRetries: 0, unknownRetry: false, credentialRead: false, directHttps: true,
      searchCalls: 0, fetchCalls: 0, researchCalls: 0, retranslationCalls: 0, qaCalls: 0, persistenceWrites: 0 })}\n`);
  } else {
    const root = process.env.M5E_ARTICLE_SUMMARY_UNCERTAINTY_OUTPUT_DIR;
    if (["execute", "execute-summaries"].includes(mode)) await mkdir(root, { mode: 0o700 });
    const paths = { root: await privateDirectory(root), calls: await privateDirectory(join(root, "llm-calls"), ["execute", "execute-summaries"].includes(mode)) };
    let records = await restored(paths, source.fixture); let status = mode === "rebuild"
      ? records.some((item) => item.status === "unknown-outcome") ? "unknown-stopped"
        : records.length === source.fixture.tasks.length ? records.every((item) => item.status === "completed") ? "completed" : "evidence-complete-with-failure"
          : "evidence-partial" : "completed";
    if (["execute", "execute-summaries", "resume"].includes(mode)) {
      if (["execute", "execute-summaries"].includes(mode) && records.length !== 0) throw new Error("article summary uncertainty execute requires an empty audit root");
      if (mode === "resume" && records.length === 0) throw new Error("article summary uncertainty resume requires existing audit evidence");
      credential = await openCredentialFile(process.env.DEEPSEEK_KEY_FILE); const secret = (await credential.readFile({ encoding: "utf8" })).trim();
      if (!secret || /\s/u.test(secret)) throw new Error("article summary uncertainty credential is invalid");
      status = "completed"; let knownFailure = records.some((item) => item.status !== "completed");
      const stages = mode === "execute-summaries" ? [source.fixture.summaryTasks] : [source.fixture.summaryTasks,
        source.fixture.translationTasks.filter((item) => item.arm === "control"), source.fixture.translationTasks.filter((item) => item.arm === "summary")];
      for (const stage of stages) {
        const summaries = summaryMap(records);
        if (stage.some((task) => task.arm === "summary") && summaries.size !== source.fixture.summaryTasks.length) { knownFailure = true; break; }
        const remaining = stage.filter((task) => !records.some((record) => record.taskId === task.taskId));
        for (let offset = 0; offset < remaining.length; offset += ARTICLE_SUMMARY_UNCERTAINTY_MAX_CONCURRENCY) {
          const wave = remaining.slice(offset, offset + ARTICLE_SUMMARY_UNCERTAINTY_MAX_CONCURRENCY); const aggregate = totals(records);
          if (aggregate.costMicrosCny + aggregate.unknownUsageCalls * ARTICLE_SUMMARY_UNCERTAINTY_PENDING_RESERVATION_MICROS_CNY
            + wave.length * ARTICLE_SUMMARY_UNCERTAINTY_PENDING_RESERVATION_MICROS_CNY > ARTICLE_SUMMARY_UNCERTAINTY_MAX_COST_MICROS_CNY) {
            status = "budget-stopped"; break;
          }
          const settled = await Promise.allSettled(wave.map((task) => invoke(task, summaries, secret, join(paths.calls, `${task.taskId}.jsonl`))));
          records = await restored(paths, source.fixture);
          if (settled.some((item) => item.status === "rejected" && item.reason?.category === "unknown-outcome")) { status = "unknown-stopped"; break; }
          if (settled.some((item) => item.status === "rejected")) knownFailure = true;
        }
        if (["budget-stopped", "unknown-stopped"].includes(status)) break;
      }
      if (mode === "execute-summaries" && status === "completed" && records.length === source.fixture.summaryTasks.length && !knownFailure) status = "summary-review-checkpoint";
      else if (status === "completed" && (knownFailure || records.length !== source.fixture.tasks.length)) status = "evidence-complete-with-failure";
    }
    const report = await writeReport(paths, source, records, status); process.stdout.write(`${JSON.stringify({ status: report.status,
      completedLogical: report.logical.filter((item) => item.status === "completed").length, totals: report.totals,
      budgetExposureMicrosCny: report.budgetExposureMicrosCny, score: report.score })}\n`);
  }
} finally { await credential?.close(); }
