import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import https from "node:https";
import { join } from "node:path";
import { openCredentialFile } from "../src/provider/credential-file.mjs";
import {
  TRANSLATION_UNCERTAIN_WORDS_MAX_CONCURRENCY,
  TRANSLATION_UNCERTAIN_WORDS_MAX_COST_MICROS_CNY,
  TRANSLATION_UNCERTAIN_WORDS_MAX_OUTPUT_TOKENS,
  TRANSLATION_UNCERTAIN_WORDS_MAX_TASKS,
  TRANSLATION_UNCERTAIN_WORDS_MODEL,
  TRANSLATION_UNCERTAIN_WORDS_PENDING_RESERVATION_MICROS_CNY,
  TRANSLATION_UNCERTAIN_WORDS_VERSION,
  buildTranslationUncertainWordsBody,
  buildTranslationUncertainWordsFixture,
  classifyTranslationUncertainWordsFailure,
  normalizeTranslationUncertainWordsPayload,
  scoreTranslationUncertainWords,
} from "../src/m5e/translation-uncertain-words.mjs";

const mode = process.env.M5E_TRANSLATION_UNCERTAIN_WORDS_MODE;
if (!["dry-run", "execute", "resume", "rebuild"].includes(mode)) throw new Error("translation uncertain words mode is invalid");
const ORIGIN = "https://api.deepseek.com/chat/completions";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REFERENCE_DIGEST = "fe09844bed580c7e4609b869f95f5752ea761febf5fbe4196722f2c0e95935eb";
const sha = (value) => `sha256:${createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex")}`;

async function privateFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("translation uncertain words input file is invalid");
  return readFile(path);
}
async function privateDirectory(path, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("translation uncertain words output directory is invalid");
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
function errorCategory(status, error) {
  return classifyTranslationUncertainWordsFailure(status, error?.category);
}
async function invoke(task, credential, auditPath) {
  const body = buildTranslationUncertainWordsBody(task); const audit = await open(auditPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  await chmod(auditPath, 0o600); const started = Date.now(); const startedAt = new Date(started).toISOString();
  const append = async (value) => audit.appendFile(`${JSON.stringify(value)}\n`); let response; let rawText = null; let caught; let normalized; let normalizedUsage;
  await append({ event: "request", startedAt, taskId: task.taskId, thinking: task.thinking, request: { url: ORIGIN, method: "POST",
    headers: { "content-type": "application/json" }, body, bodyDigest: sha(body) } });
  try {
    response = await request(body, credential); rawText = response.bytes.toString("utf8"); let outer;
    try { outer = JSON.parse(rawText); } catch { throw Object.assign(new Error("outer response JSON is malformed"), { category: "malformed-response" }); }
    if (response.status !== 200) throw Object.assign(new Error("DeepSeek HTTP failure"), { category: errorCategory(response.status), providerCode: response.status });
    const choice = outer?.choices?.[0];
    if (!outer || typeof outer.id !== "string" || !Array.isArray(outer.choices) || outer.choices.length !== 1 || choice.index !== 0
      || choice.finish_reason !== "stop" || typeof choice.message?.content !== "string") throw Object.assign(new Error("response envelope is malformed"), { category: "malformed-response" });
    normalizedUsage = usage(outer.usage, Date.now() - started);
    let payload; try { payload = JSON.parse(choice.message.content); } catch { throw Object.assign(new Error("response payload JSON is malformed"), { category: "malformed-response" }); }
    try { normalized = normalizeTranslationUncertainWordsPayload(payload, task); }
    catch { throw Object.assign(new Error("response payload schema is malformed"), { category: "malformed-response" }); }
  } catch (error) { caught = error; }
  await append({ event: "response", completedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
    response: response ? { status: response.status, headers: { "content-type": response.headers["content-type"] ?? null }, bodyBytes: response.bytes.length,
      rawBody: rawText } : null, outcome: caught ? { normalized: false, category: errorCategory(response?.status, caught), providerCode: caught.providerCode ?? null }
      : { normalized: true }, usage: normalizedUsage ?? null }); await audit.close();
  if (caught) throw Object.assign(new Error("translation uncertain words direct HTTP invocation failed"), { category: errorCategory(response?.status, caught), providerCode: caught.providerCode });
  return Object.freeze({ normalized, usage: normalizedUsage, auditFile: auditPath.split("/").at(-1) });
}
async function inputs() {
  const corpusBytes = await privateFile(process.env.M5E_TRANSLATION_UNCERTAIN_WORDS_CORPUS);
  const referenceBytes = await privateFile(process.env.M5E_TRANSLATION_UNCERTAIN_WORDS_REFERENCE);
  if (sha(referenceBytes) !== `sha256:${REFERENCE_DIGEST}`) throw new Error("translation uncertain words reference digest changed");
  return Object.freeze({ fixture: buildTranslationUncertainWordsFixture(JSON.parse(corpusBytes), JSON.parse(referenceBytes)),
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
async function restored(paths, fixture) {
  const records = [];
  for (const name of (await readdir(paths.calls)).filter((item) => item.endsWith(".jsonl")).sort()) {
    const events = (await privateFile(join(paths.calls, name))).toString("utf8").trim().split("\n").map(JSON.parse);
    const requestEvent = events.find((item) => item.event === "request"); const responseEvent = events.find((item) => item.event === "response");
    const task = fixture.tasks.find((item) => item.taskId === requestEvent?.taskId);
    if (!task || requestEvent.request?.url !== ORIGIN || requestEvent.request?.bodyDigest !== sha(buildTranslationUncertainWordsBody(task))) throw new Error("translation uncertain words request audit drifted");
    let normalized = null; let normalizedUsage = responseEvent?.usage ?? null; let status = "unknown-outcome";
    if (responseEvent?.response?.rawBody) {
      try {
        const outer = JSON.parse(responseEvent.response.rawBody);
        if (responseEvent.response.status === 200) {
          normalizedUsage = usage(outer.usage, responseEvent.elapsedMs ?? 0);
          normalized = normalizeTranslationUncertainWordsPayload(JSON.parse(outer.choices[0].message.content), task); status = "completed";
        } else status = errorCategory(responseEvent.response.status);
      } catch { status = "malformed-response"; }
    }
    records.push(Object.freeze({ taskId: task.taskId, thinking: task.thinking, normalized, usage: normalizedUsage,
      status, auditFile: name }));
  }
  return records;
}
async function writeReport(paths, source, records, status) {
  const completed = records.filter((item) => item.normalized); const aggregate = totals(records); const score = scoreTranslationUncertainWords(source.fixture, completed.map((item) => item.normalized));
  const report = { schemaVersion: `${TRANSLATION_UNCERTAIN_WORDS_VERSION}-report`, status, modelId: TRANSLATION_UNCERTAIN_WORDS_MODEL,
    corpusDigest: source.corpusDigest, referenceDigest: source.referenceDigest, fixtureDigest: source.fixture.fixtureDigest,
    maximumLogicalCalls: TRANSLATION_UNCERTAIN_WORDS_MAX_TASKS, maximumConcurrency: TRANSLATION_UNCERTAIN_WORDS_MAX_CONCURRENCY,
    maximumCostMicrosCny: TRANSLATION_UNCERTAIN_WORDS_MAX_COST_MICROS_CNY, pendingReservationMicrosCny: TRANSLATION_UNCERTAIN_WORDS_PENDING_RESERVATION_MICROS_CNY,
    automaticRetries: 0, unknownRetry: false, temperatureSent: false, logical: source.fixture.tasks.map((task) => ({ taskId: task.taskId, thinking: task.thinking,
      status: records.find((item) => item.taskId === task.taskId)?.status ?? "not-started" })), totals: aggregate,
    budgetExposureMicrosCny: aggregate.costMicrosCny + aggregate.unknownUsageCalls * TRANSLATION_UNCERTAIN_WORDS_PENDING_RESERVATION_MICROS_CNY,
    score, searchCalls: 0, fetchCalls: 0, researchCalls: 0, retranslationCalls: 0, qaCalls: 0, persistenceWrites: 0 };
  await atomicJson(join(paths.root, "report.json"), { ...report, reportDigest: sha(report) });
  await atomicJson(join(paths.root, "blind-review.json"), { schemaVersion: `${TRANSLATION_UNCERTAIN_WORDS_VERSION}-blind-review`, status: "pending-user-review",
    outputs: completed.map((record) => ({ taskId: record.taskId, thinking: record.thinking, segments: record.normalized.segments })) });
  return report;
}

let credential;
try {
  const source = await inputs();
  if (mode === "dry-run") {
    process.stdout.write(`${JSON.stringify({ status: "ready-offline-api-closed", modelId: TRANSLATION_UNCERTAIN_WORDS_MODEL,
      criticalFamilies: source.fixture.families.length, sourceSegments: source.fixture.segments.length, logicalCalls: source.fixture.tasks.length,
      maximumConcurrency: TRANSLATION_UNCERTAIN_WORDS_MAX_CONCURRENCY, maximumCostMicrosCny: TRANSLATION_UNCERTAIN_WORDS_MAX_COST_MICROS_CNY,
      pendingReservationMicrosCny: TRANSLATION_UNCERTAIN_WORDS_PENDING_RESERVATION_MICROS_CNY, thinkingModes: ["disabled", "enabled"],
      temperatureSent: false, automaticRetries: 0, unknownRetry: false, credentialRead: false, directHttps: true,
      searchCalls: 0, fetchCalls: 0, researchCalls: 0, retranslationCalls: 0, qaCalls: 0, persistenceWrites: 0 })}\n`);
  } else {
    const root = process.env.M5E_TRANSLATION_UNCERTAIN_WORDS_OUTPUT_DIR;
    if (mode === "execute") await mkdir(root, { mode: 0o700 });
    const paths = { root: await privateDirectory(root), calls: await privateDirectory(join(root, "llm-calls"), mode === "execute") };
    let records = await restored(paths, source.fixture); let status = mode === "rebuild"
      ? records.some((item) => item.status === "unknown-outcome") ? "unknown-stopped"
        : records.length === source.fixture.tasks.length
          ? records.every((item) => item.status === "completed") ? "completed" : "evidence-complete-with-failure"
          : "evidence-partial"
      : "completed";
    if (["execute", "resume"].includes(mode)) {
      if (mode === "execute" && records.length !== 0) throw new Error("translation uncertain words execute requires an empty audit root");
      if (mode === "resume" && records.length === 0) throw new Error("translation uncertain words resume requires existing audit evidence");
      credential = await openCredentialFile(process.env.DEEPSEEK_KEY_FILE); const secret = (await credential.readFile({ encoding: "utf8" })).trim();
      if (!secret || /\s/u.test(secret)) throw new Error("translation uncertain words credential is invalid");
      status = "completed"; let knownFailure = records.some((item) => item.status !== "completed");
      const remaining = source.fixture.tasks.filter((task) => !records.some((record) => record.taskId === task.taskId));
      for (let offset = 0; offset < remaining.length; offset += TRANSLATION_UNCERTAIN_WORDS_MAX_CONCURRENCY) {
        const wave = remaining.slice(offset, offset + TRANSLATION_UNCERTAIN_WORDS_MAX_CONCURRENCY); const aggregate = totals(records);
        if (aggregate.costMicrosCny + aggregate.unknownUsageCalls * TRANSLATION_UNCERTAIN_WORDS_PENDING_RESERVATION_MICROS_CNY
          + wave.length * TRANSLATION_UNCERTAIN_WORDS_PENDING_RESERVATION_MICROS_CNY > TRANSLATION_UNCERTAIN_WORDS_MAX_COST_MICROS_CNY) { status = "budget-stopped"; break; }
        const settled = await Promise.allSettled(wave.map((task) => invoke(task, secret, join(paths.calls, `${task.taskId}.jsonl`))));
        records = await restored(paths, source.fixture);
        if (settled.some((item) => item.status === "rejected" && item.reason?.category === "unknown-outcome")) { status = "unknown-stopped"; break; }
        if (settled.some((item) => item.status === "rejected")) knownFailure = true;
      }
      if (status === "completed" && knownFailure) status = "evidence-complete-with-failure";
    }
    const report = await writeReport(paths, source, records, status); process.stdout.write(`${JSON.stringify({ status: report.status,
      completedLogical: report.logical.filter((item) => item.status === "completed").length, totals: report.totals,
      budgetExposureMicrosCny: report.budgetExposureMicrosCny, score: report.score })}\n`);
  }
} finally { await credential?.close(); }
