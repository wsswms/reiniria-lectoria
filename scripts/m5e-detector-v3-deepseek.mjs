import { auditError, responseHeaders } from "../src/provider/llm-call-audit.mjs";
import { buildDetectorV3DeepSeekBody, normalizeDetectorV3Payload } from "../src/m5e/detector-v3.mjs";
import { buildDetectorV3LiteDeepSeekBody, normalizeDetectorV3LitePayload } from "../src/m5e/detector-v3-lite.mjs";

const ORIGIN = "https://api.deepseek.com/chat/completions";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export class M5EDetectorV3Error extends Error {
  constructor(category = "provider", providerCode) {
    super("M5E Detector v3 DeepSeek invocation failed"); this.name = "M5EDetectorV3Error"; this.category = category; this.retryable = false;
    if (providerCode !== undefined) this.providerCode = String(providerCode);
  }
}

const fail = (category, code) => new M5EDetectorV3Error(category, code);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function usage(value, durationMs = 0) {
  const inputTokens = value?.prompt_tokens, outputTokens = value?.completion_tokens, totalTokens = value?.total_tokens;
  if (![inputTokens, outputTokens, totalTokens].every((item) => Number.isSafeInteger(item) && item >= 0) || inputTokens + outputTokens !== totalTokens) {
    throw fail("malformed-response", "usage");
  }
  const reasoningTokens = Number.isSafeInteger(value?.completion_tokens_details?.reasoning_tokens) ? value.completion_tokens_details.reasoning_tokens : 0;
  if (reasoningTokens < 0 || reasoningTokens > outputTokens) throw fail("malformed-response", "reasoning-usage");
  return Object.freeze({ calls: 1, inputTokens, outputTokens, reasoningTokens, totalTokens,
    costMicrosCny: Math.ceil((inputTokens * 28 + outputTokens * 56) / 10), durationMs });
}
function addUsage(left, right) {
  if (!left) return right; return Object.freeze(Object.fromEntries(Object.keys(right).map((key) => [key, left[key] + right[key]])));
}
function payload(value, coverage, promptVariant) {
  if (!object(value) || typeof value.id !== "string" || !Array.isArray(value.choices) || value.choices.length !== 1) throw fail("malformed-response", "envelope");
  const choice = value.choices[0];
  if (choice?.index !== 0 || choice?.finish_reason !== "stop" || typeof choice?.message?.content !== "string") {
    throw fail(choice?.finish_reason === "content_filter" ? "policy" : "malformed-response", `finish-${String(choice?.finish_reason ?? "missing")}`);
  }
  let decoded; try { decoded = JSON.parse(choice.message.content); } catch { throw fail("malformed-response", "payload-json"); }
  try { return Object.freeze({ responseId: value.id,
    ...(promptVariant === "lite-v1" ? normalizeDetectorV3LitePayload(decoded, coverage) : normalizeDetectorV3Payload(decoded, coverage)) }); }
  catch (error) {
    const code = error?.message === "source span segment is invalid" ? "invalid-segment-id"
      : error?.message === "source span must be a bounded exact quote" ? "non-exact-source-quote"
        : / issue is invalid$/u.test(error?.message ?? "") ? "invalid-issue-enum" : "detector-v3-schema";
    throw fail("malformed-response", code);
  }
}
function http(status) {
  if ([401, 403].includes(status)) return fail("auth", status); if (status === 429) return fail("rate-limit", status);
  if ([408, 504].includes(status)) return fail("timeout", status); return status >= 500 ? fail("provider", status) : fail("policy", status);
}

export async function invokeM5EDetectorV3DeepSeek(input, { credential, fetchImpl = globalThis.fetch, audit, signal } = {}) {
  const promptVariant = input?.promptVariant ?? "current-v1"; const temperature = input?.temperature ?? 0;
  if (!input || !Number.isSafeInteger(input.maximumAttempts) || input.maximumAttempts < 1 || input.maximumAttempts > 2
    || !["current-v1", "lite-v1"].includes(promptVariant) || ![0, 1].includes(temperature)
    || typeof fetchImpl !== "function" || (audit !== undefined && typeof audit !== "function")) throw new TypeError("Detector v3 invocation configuration is invalid");
  const baseBody = promptVariant === "lite-v1" ? buildDetectorV3LiteDeepSeekBody({ ...input, temperature })
    : buildDetectorV3DeepSeekBody({ ...input, temperature }); let priorUsage = null; let repairCode = null;
  for (let attempt = 1; attempt <= input.maximumAttempts; attempt += 1) {
    const body = attempt === 1 ? baseBody : Object.freeze({ ...baseBody, messages: Object.freeze([...baseBody.messages, Object.freeze({ role: "user",
      content: `The previous JSON response was rejected with ${repairCode ?? "detector-v3-schema"}. Regenerate the complete JSON object. Copy every segmentId exactly from the input and verify every sourceSpans.text is a byte-for-byte substring of that same segment; omit any item you cannot anchor exactly. Verify kind, impact, and issue independently. issue must be one of preferred-translation, official-name, identity-verification, technical-meaning, fact-verification, relation-preservation, measurement-ambiguity, or consistency; issue is never style, term, entity, fact, relation, or measurement.` })]) });
    const started = Date.now(); const startedAt = new Date(started).toISOString(); let response; let rawText = null; let raw = null;
    let normalized; let observedUsage = null; let caught; let willRetry = false;
    audit?.(Object.freeze({ schemaVersion: "reiniria-llm-call-audit-v1", event: "request", provider: "deepseek", role: "planner-detector-v3",
      thinking: "enabled", promptVariant, temperature, attempt, maximumAttempts: input.maximumAttempts, startedAt,
      request: Object.freeze({ url: ORIGIN, method: "POST", headers: Object.freeze({ "content-type": "application/json" }), body,
        bodyBytes: Buffer.byteLength(JSON.stringify(body)) }) }));
    try {
      if (typeof credential !== "string" || credential.length < 1 || /\s/u.test(credential)) throw fail("auth");
      try { response = await fetchImpl(ORIGIN, { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify(body), redirect: "error", signal }); }
      catch (error) { throw signal?.aborted || error?.name === "AbortError" ? fail("canceled") : fail("unknown-outcome", error?.cause?.code ?? error?.code); }
      if (!response || typeof response.status !== "number") throw fail("malformed-response", "response");
      const declared = Number(response.headers?.get?.("content-length")); if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw fail("malformed-response", "response-size");
      const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > MAX_RESPONSE_BYTES) throw fail("malformed-response", "response-size");
      rawText = bytes.toString("utf8"); try { raw = JSON.parse(rawText); } catch { if (response.ok) throw fail("malformed-response", "outer-json"); }
      if (!response.ok) throw http(response.status);
      try { observedUsage = usage(raw?.usage, Date.now() - started); } catch {}
      normalized = payload(raw, input.coverage, promptVariant); observedUsage = usage(raw.usage, Date.now() - started);
    } catch (error) {
      caught = error instanceof M5EDetectorV3Error ? error : fail("malformed-response"); const choice = raw?.choices?.[0];
      willRetry = attempt < input.maximumAttempts && caught.category === "malformed-response" && response?.ok === true && observedUsage !== null
        && choice?.index === 0 && choice?.finish_reason === "stop" && typeof choice?.message?.content === "string";
    } finally {
      const completed = Date.now(); const choice = raw?.choices?.[0];
      audit?.(Object.freeze({ schemaVersion: "reiniria-llm-call-audit-v1", event: "response", provider: "deepseek", role: "planner-detector-v3",
        thinking: "enabled", promptVariant, temperature, attempt, maximumAttempts: input.maximumAttempts, startedAt, completedAt: new Date(completed).toISOString(), elapsedMs: completed - started,
        response: response ? Object.freeze({ status: response.status, headers: responseHeaders(response.headers), bodyBytes: rawText === null ? null : Buffer.byteLength(rawText),
          rawBody: rawText, content: choice?.message?.content ?? null, reasoningContent: choice?.message?.reasoning_content ?? null,
          finishReason: choice?.finish_reason ?? null, usage: raw?.usage ?? null }) : null,
        outcome: caught ? Object.freeze({ normalized: false, error: auditError(caught), willRetry }) : Object.freeze({ normalized: true }) }));
    }
    if (!caught) return Object.freeze({ ...normalized, usage: addUsage(priorUsage, observedUsage) });
    if (!willRetry) throw caught; priorUsage = addUsage(priorUsage, observedUsage); repairCode = caught.providerCode ?? "detector-v3-schema";
  }
  throw fail("malformed-response");
}
