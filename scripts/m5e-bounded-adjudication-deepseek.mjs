import { auditError, responseHeaders } from "../src/provider/llm-call-audit.mjs";
import {
  buildCandidateAdjudicationBody,
  buildGoalConsolidationBody,
  normalizeCandidateAdjudicationPayload,
  normalizeGoalConsolidationPayload,
} from "../src/m5e/lexical-bounded-adjudication.mjs";

const ORIGIN = "https://api.deepseek.com/chat/completions";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export class M5EBoundedAdjudicationDeepSeekError extends Error {
  constructor(category = "provider", providerCode) {
    super("M5E bounded adjudication DeepSeek invocation failed"); this.name = "M5EBoundedAdjudicationDeepSeekError";
    this.category = category; this.retryable = false;
    if (providerCode !== undefined) this.providerCode = String(providerCode);
  }
}
const fail = (category, providerCode) => new M5EBoundedAdjudicationDeepSeekError(category, providerCode);

function normalizedUsage(value, durationMs) {
  const inputTokens = value?.prompt_tokens; const outputTokens = value?.completion_tokens; const totalTokens = value?.total_tokens;
  if (![inputTokens, outputTokens, totalTokens].every((item) => Number.isSafeInteger(item) && item >= 0)
    || inputTokens + outputTokens !== totalTokens) throw fail("malformed-response", "usage");
  const reasoningTokens = value?.completion_tokens_details?.reasoning_tokens ?? 0;
  if (!Number.isSafeInteger(reasoningTokens) || reasoningTokens < 0 || reasoningTokens > outputTokens) {
    throw fail("malformed-response", "reasoning-usage");
  }
  return Object.freeze({ calls: 1, inputTokens, outputTokens, reasoningTokens, totalTokens,
    costMicrosCny: Math.ceil((inputTokens * 28 + outputTokens * 56) / 10), durationMs });
}
function responsePayload(value, normalize) {
  if (!object(value) || typeof value.id !== "string" || !Array.isArray(value.choices) || value.choices.length !== 1) {
    throw fail("malformed-response", "envelope");
  }
  const choice = value.choices[0];
  if (choice?.index !== 0 || choice?.finish_reason !== "stop" || typeof choice?.message?.content !== "string") {
    throw fail(choice?.finish_reason === "content_filter" ? "policy" : "malformed-response",
      `finish-${String(choice?.finish_reason ?? "missing")}`);
  }
  let decoded; try { decoded = JSON.parse(choice.message.content); } catch { throw fail("malformed-response", "payload-json"); }
  try { return Object.freeze({ responseId: value.id, ...normalize(decoded) }); }
  catch { throw fail("malformed-response", "bounded-schema"); }
}
function httpFailure(status) {
  if ([401, 403].includes(status)) return fail("auth", status);
  if (status === 429) return fail("rate-limit", status);
  if ([408, 504].includes(status)) return fail("timeout", status);
  return status >= 500 ? fail("provider", status) : fail("policy", status);
}
function validate(input, fetchImpl, audit) {
  if (!input || input.maximumAttempts !== 1 || typeof fetchImpl !== "function"
    || (audit !== undefined && typeof audit !== "function")) throw new TypeError("Bounded adjudication invocation configuration is invalid");
}
async function invoke(input, { credential, fetchImpl, audit, signal }, { role, body, normalize }) {
  const started = Date.now(); const startedAt = new Date(started).toISOString();
  let response; let rawText = null; let raw = null; let usage = null; let normalized; let caught;
  audit?.(Object.freeze({ schemaVersion: "reiniria-llm-call-audit-v1", event: "request", provider: "deepseek", role,
    thinking: "enabled", temperature: null, temperatureEffective: false, attempt: 1, maximumAttempts: 1, startedAt,
    request: Object.freeze({ url: ORIGIN, method: "POST", headers: Object.freeze({ "content-type": "application/json" }), body,
      bodyBytes: Buffer.byteLength(JSON.stringify(body)) }) }));
  try {
    if (typeof credential !== "string" || credential.length < 1 || /\s/u.test(credential)) throw fail("auth");
    try { response = await fetchImpl(ORIGIN, { method: "POST", headers: { authorization: `Bearer ${credential}`,
      "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal }); }
    catch (error) { throw signal?.aborted || error?.name === "AbortError" ? fail("canceled")
      : fail("unknown-outcome", error?.cause?.code ?? error?.code); }
    if (!response || typeof response.status !== "number") throw fail("malformed-response", "response");
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw fail("malformed-response", "response-size");
    let bytes; try { bytes = Buffer.from(await response.arrayBuffer()); }
    catch (error) { throw signal?.aborted || error?.name === "AbortError" ? fail("canceled")
      : fail("unknown-outcome", error?.cause?.code ?? error?.code); }
    if (bytes.length > MAX_RESPONSE_BYTES) throw fail("malformed-response", "response-size");
    rawText = bytes.toString("utf8"); try { raw = JSON.parse(rawText); } catch { if (response.ok) throw fail("malformed-response", "outer-json"); }
    if (!response.ok) throw httpFailure(response.status);
    usage = normalizedUsage(raw?.usage, Date.now() - started); normalized = responsePayload(raw, normalize);
  } catch (error) { caught = error instanceof M5EBoundedAdjudicationDeepSeekError ? error : fail("malformed-response"); }
  finally {
    const completed = Date.now(); const choice = raw?.choices?.[0];
    audit?.(Object.freeze({ schemaVersion: "reiniria-llm-call-audit-v1", event: "response", provider: "deepseek", role,
      thinking: "enabled", temperature: null, temperatureEffective: false, attempt: 1, maximumAttempts: 1, startedAt,
      completedAt: new Date(completed).toISOString(), elapsedMs: completed - started,
      response: response ? Object.freeze({ status: response.status, headers: responseHeaders(response.headers),
        bodyBytes: rawText === null ? null : Buffer.byteLength(rawText), rawBody: rawText,
        content: choice?.message?.content ?? null, reasoningContent: choice?.message?.reasoning_content ?? null,
        finishReason: choice?.finish_reason ?? null, usage: raw?.usage ?? null }) : null,
      outcome: caught ? Object.freeze({ normalized: false, error: auditError(caught), willRetry: false })
        : Object.freeze({ normalized: true }) }));
  }
  if (caught) throw caught;
  return Object.freeze({ ...normalized, usage });
}

export function invokeM5ECandidateAdjudicationDeepSeek(input, { credential, fetchImpl = globalThis.fetch, audit, signal } = {}) {
  validate(input, fetchImpl, audit); const body = buildCandidateAdjudicationBody(input);
  return invoke(input, { credential, fetchImpl, audit, signal }, { role: "planner-candidate-adjudication", body,
    normalize: (payload) => normalizeCandidateAdjudicationPayload(payload, input.task) });
}
export function invokeM5EGoalConsolidationDeepSeek(input, { credential, fetchImpl = globalThis.fetch, audit, signal } = {}) {
  validate(input, fetchImpl, audit); const body = buildGoalConsolidationBody(input);
  return invoke(input, { credential, fetchImpl, audit, signal }, { role: "planner-goal-consolidation", body,
    normalize: (payload) => normalizeGoalConsolidationPayload(payload, input.task) });
}
