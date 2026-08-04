import { auditError, responseHeaders } from "../src/provider/llm-call-audit.mjs";
import {
  buildLexicalStageABody,
  buildLexicalStageBBody,
  LEXICAL_STAGE_A_RISK_BALANCED_PROMPT_VERSION,
  normalizeLexicalStageAPayload,
  normalizeLexicalStageBPayload,
} from "../src/m5e/lexical-two-stage.mjs";

const ORIGIN = "https://api.deepseek.com/chat/completions";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export class M5ELexicalDeepSeekError extends Error {
  constructor(category = "provider", providerCode) {
    super("M5E lexical DeepSeek invocation failed"); this.name = "M5ELexicalDeepSeekError";
    this.category = category; this.retryable = false;
    if (providerCode !== undefined) this.providerCode = String(providerCode);
  }
}

const fail = (category, providerCode) => new M5ELexicalDeepSeekError(category, providerCode);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function normalizedUsage(value, durationMs) {
  const inputTokens = value?.prompt_tokens; const outputTokens = value?.completion_tokens; const totalTokens = value?.total_tokens;
  if (![inputTokens, outputTokens, totalTokens].every((item) => Number.isSafeInteger(item) && item >= 0)
    || inputTokens + outputTokens !== totalTokens) throw fail("malformed-response", "usage");
  const reasoning = value?.completion_tokens_details?.reasoning_tokens;
  const reasoningTokens = reasoning === undefined ? 0 : reasoning;
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
  catch (error) { throw fail("malformed-response", error?.message === "lexical source quote is not exact"
    ? "non-exact-source-quote" : "lexical-schema"); }
}

function httpFailure(status) {
  if ([401, 403].includes(status)) return fail("auth", status);
  if (status === 429) return fail("rate-limit", status);
  if ([408, 504].includes(status)) return fail("timeout", status);
  return status >= 500 ? fail("provider", status) : fail("policy", status);
}

function validate(input, fetchImpl, audit) {
  if (!input || input.maximumAttempts !== 1 || typeof fetchImpl !== "function"
    || (audit !== undefined && typeof audit !== "function")) throw new TypeError("Lexical DeepSeek invocation configuration is invalid");
}

async function invoke(input, { credential, fetchImpl, audit, signal }, { stage, body, normalize }) {
  const role = `planner-lexical-stage-${stage.toLowerCase()}`; const started = Date.now(); const startedAt = new Date(started).toISOString();
  let response; let rawText = null; let raw = null; let observedUsage = null; let normalized; let caught;
  audit?.(Object.freeze({ schemaVersion: "reiniria-llm-call-audit-v1", event: "request", provider: "deepseek", role,
    thinking: "enabled", temperature: body.temperature ?? null, temperatureEffective: false, attempt: 1, maximumAttempts: 1, startedAt,
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
    rawText = bytes.toString("utf8");
    try { raw = JSON.parse(rawText); } catch { if (response.ok) throw fail("malformed-response", "outer-json"); }
    if (!response.ok) throw httpFailure(response.status);
    observedUsage = normalizedUsage(raw?.usage, Date.now() - started);
    normalized = responsePayload(raw, normalize);
  } catch (error) { caught = error instanceof M5ELexicalDeepSeekError ? error : fail("malformed-response"); }
  finally {
    const completed = Date.now(); const choice = raw?.choices?.[0];
    audit?.(Object.freeze({ schemaVersion: "reiniria-llm-call-audit-v1", event: "response", provider: "deepseek", role,
      thinking: "enabled", temperature: body.temperature ?? null, temperatureEffective: false, attempt: 1, maximumAttempts: 1, startedAt,
      completedAt: new Date(completed).toISOString(), elapsedMs: completed - started,
      response: response ? Object.freeze({ status: response.status, headers: responseHeaders(response.headers),
        bodyBytes: rawText === null ? null : Buffer.byteLength(rawText), rawBody: rawText,
        content: choice?.message?.content ?? null, reasoningContent: choice?.message?.reasoning_content ?? null,
        finishReason: choice?.finish_reason ?? null, usage: raw?.usage ?? null }) : null,
      outcome: caught ? Object.freeze({ normalized: false, error: auditError(caught), willRetry: false })
        : Object.freeze({ normalized: true }) }));
  }
  if (caught) throw caught;
  return Object.freeze({ ...normalized, usage: observedUsage });
}

export function invokeM5ELexicalStageADeepSeek(input, { credential, fetchImpl = globalThis.fetch, audit, signal } = {}) {
  validate(input, fetchImpl, audit); const body = buildLexicalStageABody(input);
  return invoke(input, { credential, fetchImpl, audit, signal }, { stage: "A", body,
    normalize: (payload) => normalizeLexicalStageAPayload(payload, input.coverage, input.approvedTerms ?? [],
      { maximumItems: input.stageAPromptVersion === LEXICAL_STAGE_A_RISK_BALANCED_PROMPT_VERSION ? 72 : 96 }) });
}

export function invokeM5ELexicalStageBDeepSeek(input, { credential, fetchImpl = globalThis.fetch, audit, signal } = {}) {
  validate(input, fetchImpl, audit); const body = buildLexicalStageBBody(input);
  return invoke(input, { credential, fetchImpl, audit, signal }, { stage: "B", body,
    normalize: (payload) => normalizeLexicalStageBPayload(payload, input.stageAResult) });
}
