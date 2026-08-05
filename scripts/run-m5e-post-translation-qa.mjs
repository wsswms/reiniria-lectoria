import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import https from "node:https";
import { join } from "node:path";
import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { classifyTranslationUncertainWordsFailure } from "../src/m5e/translation-uncertain-words.mjs";
import {
  POST_TRANSLATION_QA_AUTHORIZED_CONCURRENCY, POST_TRANSLATION_QA_MAX_CONCURRENCY, POST_TRANSLATION_QA_MAX_COST_MICROS_CNY,
  POST_TRANSLATION_QA_MODEL, POST_TRANSLATION_QA_PENDING_RESERVATION_MICROS_CNY, POST_TRANSLATION_QA_TASKS,
  POST_TRANSLATION_QA_VERSION, buildPostTranslationQaBody, buildPostTranslationQaFixture,
  normalizePostTranslationQaPayload, scorePostTranslationQa,
} from "../src/m5e/post-translation-qa.mjs";

const mode = process.env.M5E_POST_TRANSLATION_QA_MODE;
if (!["dry-run", "execute", "rebuild"].includes(mode)) throw new Error("post-translation QA mode is invalid");
const ORIGIN = "https://api.deepseek.com/chat/completions"; const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REFERENCE_DIGEST = "fe09844bed580c7e4609b869f95f5752ea761febf5fbe4196722f2c0e95935eb";
const sha = (value) => `sha256:${createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex")}`;
async function privateFile(path) { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("post-translation QA input file is invalid"); return readFile(path); }
async function privateDirectory(path, create = false) { if (create) await mkdir(path, { recursive: true, mode: 0o700 }); const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("post-translation QA output directory is invalid"); return path; }
async function atomicJson(path, value) { const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, path); await chmod(path, 0o600); }
function usage(value, durationMs) { const inputTokens = value?.prompt_tokens; const outputTokens = value?.completion_tokens; const totalTokens = value?.total_tokens;
  const reasoningTokens = value?.completion_tokens_details?.reasoning_tokens ?? 0; const cacheHitTokens = value?.prompt_cache_hit_tokens ?? value?.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheMissTokens = value?.prompt_cache_miss_tokens ?? inputTokens - cacheHitTokens;
  if (![inputTokens, outputTokens, totalTokens, reasoningTokens, cacheHitTokens, cacheMissTokens].every((item) => Number.isSafeInteger(item) && item >= 0)
    || inputTokens + outputTokens !== totalTokens || cacheHitTokens + cacheMissTokens !== inputTokens || reasoningTokens > outputTokens) throw Object.assign(new Error("usage is malformed"), { category: "malformed-response" });
  const costMicrosUsd = Math.ceil(cacheHitTokens * 0.003625 + cacheMissTokens * 0.435 + outputTokens * 0.87);
  return Object.freeze({ inputTokens, outputTokens, reasoningTokens, totalTokens, cacheHitTokens, cacheMissTokens, costMicrosUsd, costMicrosCny: costMicrosUsd * 8, durationMs }); }
function request(body, credential, timeoutMs = 900_000) { const bytes = Buffer.from(JSON.stringify(body)); return new Promise((resolve, reject) => {
  const req = https.request({ protocol: "https:", hostname: "api.deepseek.com", port: 443, path: "/chat/completions", method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", "content-length": bytes.length }, timeout: timeoutMs, agent: false }, (response) => {
    const chunks = []; let size = 0; response.on("data", (chunk) => { size += chunk.length; if (size > MAX_RESPONSE_BYTES) response.destroy(Object.assign(new Error("response too large"), { category: "malformed-response" })); else chunks.push(chunk); });
    response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) })); response.on("error", reject); });
  req.on("timeout", () => req.destroy(Object.assign(new Error("request timed out"), { category: "unknown-outcome" }))); req.on("error", reject); req.end(bytes); }); }
const category = (status, error) => classifyTranslationUncertainWordsFailure(status, error?.category);
async function invoke(task, credential, auditPath) { const body = buildPostTranslationQaBody(task); const audit = await open(auditPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await chmod(auditPath, 0o600);
  const started = Date.now(); const append = async (value) => audit.appendFile(`${JSON.stringify(value)}\n`); let response; let rawText = null; let normalized; let normalizedUsage; let caught;
  await append({ event: "request", startedAt: new Date(started).toISOString(), taskId: task.taskId, request: { url: ORIGIN, method: "POST", headers: { "content-type": "application/json" }, body, bodyDigest: sha(body) } });
  try { response = await request(body, credential); rawText = response.bytes.toString("utf8"); const outer = JSON.parse(rawText); if (response.status !== 200) throw Object.assign(new Error("DeepSeek HTTP failure"), { category: category(response.status), providerCode: response.status });
    const choice = outer?.choices?.[0]; if (!outer || typeof outer.id !== "string" || !Array.isArray(outer.choices) || outer.choices.length !== 1 || choice.index !== 0 || choice.finish_reason !== "stop" || typeof choice.message?.content !== "string") throw Object.assign(new Error("response envelope is malformed"), { category: "malformed-response" });
    normalizedUsage = usage(outer.usage, Date.now() - started); normalized = normalizePostTranslationQaPayload(JSON.parse(choice.message.content), task);
  } catch (error) { caught = Object.assign(error, { category: category(response?.status, error) }); }
  await append({ event: "response", completedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
    response: response ? { status: response.status, headers: { "content-type": response.headers["content-type"] ?? null }, bodyBytes: response.bytes.length, rawBody: rawText } : null,
    outcome: caught ? { normalized: false, category: caught.category, providerCode: caught.providerCode ?? null } : { normalized: true }, usage: normalizedUsage ?? null }); await audit.close();
  if (caught) throw caught; return Object.freeze({ taskId: task.taskId, repeat: task.repeat, normalized, usage: normalizedUsage, status: "completed", auditFile: auditPath.split("/").at(-1) }); }
async function inputs() { const corpusBytes = await privateFile(process.env.M5E_POST_TRANSLATION_QA_CORPUS); const referenceBytes = await privateFile(process.env.M5E_POST_TRANSLATION_QA_REFERENCE);
  const baselineBytes = await privateFile(process.env.M5E_POST_TRANSLATION_QA_BASELINE); if (sha(referenceBytes) !== `sha256:${REFERENCE_DIGEST}`) throw new Error("post-translation QA reference digest changed");
  return Object.freeze({ fixture: buildPostTranslationQaFixture(JSON.parse(corpusBytes), JSON.parse(referenceBytes), JSON.parse(baselineBytes)), corpusDigest: sha(corpusBytes), referenceDigest: sha(referenceBytes), baselineDigest: sha(baselineBytes) }); }
function totals(records) { const total = { calls: records.length, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, costMicrosUsd: 0, costMicrosCny: 0, durationMs: 0, unknownUsageCalls: 0 };
  for (const record of records) { if (!record.usage) { total.unknownUsageCalls += 1; continue; } for (const key of Object.keys(total).filter((item) => !["calls", "unknownUsageCalls"].includes(item))) total[key] += record.usage[key]; } return total; }
async function restored(paths, fixture) { const records = []; for (const name of (await readdir(paths.calls)).filter((item) => item.endsWith(".jsonl")).sort()) {
  const events = (await privateFile(join(paths.calls, name))).toString("utf8").trim().split("\n").map(JSON.parse); const requestEvent = events.find((item) => item.event === "request"); const responseEvent = events.find((item) => item.event === "response");
  const task = fixture.tasks.find((item) => item.taskId === requestEvent?.taskId); if (!task || requestEvent.request?.url !== ORIGIN || requestEvent.request?.bodyDigest !== sha(buildPostTranslationQaBody(task))) throw new Error("post-translation QA request audit drifted");
  let normalized = null; let normalizedUsage = responseEvent?.usage ?? null; let status = "unknown-outcome"; if (responseEvent?.response?.rawBody) try { const outer = JSON.parse(responseEvent.response.rawBody); if (responseEvent.response.status === 200) { normalizedUsage = usage(outer.usage, responseEvent.elapsedMs ?? 0); normalized = normalizePostTranslationQaPayload(JSON.parse(outer.choices[0].message.content), task); status = "completed"; } else status = category(responseEvent.response.status); } catch { status = "malformed-response"; }
  records.push(Object.freeze({ taskId: task.taskId, repeat: task.repeat, normalized, usage: normalizedUsage, status, auditFile: name })); } return records; }
async function report(paths, source, records, status) { const aggregate = totals(records); const completed = records.filter((item) => item.normalized); const score = scorePostTranslationQa(source.fixture, completed.map((item) => item.normalized));
  const value = { schemaVersion: `${POST_TRANSLATION_QA_VERSION}-report`, status, modelId: POST_TRANSLATION_QA_MODEL, corpusDigest: source.corpusDigest, referenceDigest: source.referenceDigest, baselineDigest: source.baselineDigest, fixtureDigest: source.fixture.fixtureDigest,
    maximumLogicalCalls: POST_TRANSLATION_QA_TASKS, maximumConcurrency: POST_TRANSLATION_QA_MAX_CONCURRENCY, authorizedConcurrency: POST_TRANSLATION_QA_AUTHORIZED_CONCURRENCY, maximumCostMicrosCny: POST_TRANSLATION_QA_MAX_COST_MICROS_CNY,
    pendingReservationMicrosCny: POST_TRANSLATION_QA_PENDING_RESERVATION_MICROS_CNY, automaticRetries: 0, unknownRetry: false, temperatureSent: false,
    logical: source.fixture.tasks.map((task) => ({ taskId: task.taskId, status: records.find((item) => item.taskId === task.taskId)?.status ?? "not-started" })), totals: aggregate,
    budgetExposureMicrosCny: aggregate.costMicrosCny + aggregate.unknownUsageCalls * POST_TRANSLATION_QA_PENDING_RESERVATION_MICROS_CNY, score,
    searchCalls: 0, fetchCalls: 0, researchCalls: 0, retranslationCalls: 0, persistenceWrites: 0 };
  await atomicJson(join(paths.root, "report.json"), { ...value, reportDigest: sha(value) }); await atomicJson(join(paths.root, "blind-review.json"), { schemaVersion: `${POST_TRANSLATION_QA_VERSION}-blind-review`, status: "pending-user-review", outputs: completed.map((item) => item.normalized) }); return value; }

let credential; try { const source = await inputs(); if (mode === "dry-run") process.stdout.write(`${JSON.stringify({ status: "ready-offline-api-closed", modelId: POST_TRANSLATION_QA_MODEL, criticalFamilies: source.fixture.families.length, segments: source.fixture.segments.length, logicalCalls: source.fixture.tasks.length, maximumConcurrency: POST_TRANSLATION_QA_MAX_CONCURRENCY, authorizedConcurrency: POST_TRANSLATION_QA_AUTHORIZED_CONCURRENCY, maximumCostMicrosCny: POST_TRANSLATION_QA_MAX_COST_MICROS_CNY, credentialRead: false, directHostHttps: true, automaticRetries: 0, unknownRetry: false })}\n`);
  else { const root = process.env.M5E_POST_TRANSLATION_QA_OUTPUT_DIR; if (mode === "execute") await mkdir(root, { recursive: true, mode: 0o700 }); const paths = { root: await privateDirectory(root), calls: await privateDirectory(join(root, "llm-calls"), mode === "execute") };
    let records = await restored(paths, source.fixture); let status; if (mode === "execute") { if (records.length) throw new Error("post-translation QA execute requires empty audit root");
      if (POST_TRANSLATION_QA_TASKS * POST_TRANSLATION_QA_PENDING_RESERVATION_MICROS_CNY > POST_TRANSLATION_QA_MAX_COST_MICROS_CNY) throw new Error("post-translation QA pending wave exceeds budget");
      credential = await openCredentialFile(process.env.DEEPSEEK_KEY_FILE); const secret = (await credential.readFile({ encoding: "utf8" })).trim(); if (!secret || /\s/u.test(secret)) throw new Error("post-translation QA credential is invalid");
      await Promise.allSettled(source.fixture.tasks.map((task) => invoke(task, secret, join(paths.calls, `${task.taskId}.jsonl`)))); records = await restored(paths, source.fixture);
      status = records.some((item) => item.status === "unknown-outcome") ? "unknown-stopped" : records.every((item) => item.status === "completed") ? "completed" : "evidence-complete-with-failure";
    } else status = records.some((item) => item.status === "unknown-outcome") ? "unknown-stopped" : records.length === POST_TRANSLATION_QA_TASKS ? records.every((item) => item.status === "completed") ? "completed" : "evidence-complete-with-failure" : "evidence-partial";
    const value = await report(paths, source, records, status); process.stdout.write(`${JSON.stringify({ status: value.status, totals: value.totals, budgetExposureMicrosCny: value.budgetExposureMicrosCny, score: value.score })}\n`); }
} finally { await credential?.close(); }
