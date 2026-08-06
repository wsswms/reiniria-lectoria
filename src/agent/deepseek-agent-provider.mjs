const ORIGIN = "https://api.deepseek.com";
const ALLOWED_TOOLS = Object.freeze(["lookup_dictionary", "lookup_entity", "calculate_number"]);
const TOOL_SET = new Set(ALLOWED_TOOLS);
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const referenceProperties = Object.freeze({
  schemaVersion: { type: "string" }, term: { type: "string", minLength: 1, maxLength: 256 },
  sourceLanguage: { type: "string", minLength: 2, maxLength: 64 }, targetLanguage: { type: "string", minLength: 2, maxLength: 64 },
  context: { type: "string", minLength: 1, maxLength: 2048 },
});
const TOOL_SCHEMAS = Object.freeze({
  lookup_dictionary: Object.freeze({ type: "object", additionalProperties: false,
    required: ["schemaVersion", "term", "sourceLanguage", "targetLanguage", "context", "partOfSpeech", "requestedFields"],
    properties: { ...referenceProperties, schemaVersion: { const: "dictionary-lookup-request-v1" },
      partOfSpeech: { type: ["string", "null"], maxLength: 64 }, requestedFields: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 64 } } } }),
  lookup_entity: Object.freeze({ type: "object", additionalProperties: false,
    required: ["schemaVersion", "term", "sourceLanguage", "targetLanguage", "context", "entityType", "requestedFacts", "timeHint"],
    properties: { ...referenceProperties, schemaVersion: { const: "entity-lookup-request-v1" }, entityType: { type: ["string", "null"], maxLength: 64 },
      requestedFacts: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 128 } },
      timeHint: { type: ["string", "null"], maxLength: 128 } } }),
  calculate_number: Object.freeze({ type: "object", additionalProperties: false,
    required: ["schemaVersion", "operation", "value", "from", "to", "precision", "rounding"],
    properties: { schemaVersion: { const: "number-calculation-request-v1" }, operation: { enum: ["scale", "convert-unit"] },
      value: { type: "string", pattern: "^-?(?:0|[1-9][0-9]{0,99})(?:\\.[0-9]{1,30})?$" }, from: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9-]{0,63}$" },
      to: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9-]{0,63}$" }, precision: { type: "integer", minimum: 0, maximum: 18 },
      rounding: { enum: ["half-up", "half-even", "down"] } } }),
});

export class DeepSeekAgentError extends Error {
  constructor(category = "provider", retryable = false, providerCode) {
    super(`DeepSeek Agent ${category}`); this.name = "DeepSeekAgentError"; this.category = category; this.retryable = retryable === true;
    if (providerCode !== undefined) this.providerCode = String(providerCode);
  }
}

const fail = (category, retryable = false, code) => new DeepSeekAgentError(category, retryable, code);
const exactObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const textOf = (content) => Array.isArray(content) ? content.filter((item) => item?.type === "text").map((item) => item.text).join("")
  : typeof content === "string" ? content : "";

function requestContract(input) {
  if (!exactObject(input) || !MODEL.test(input.modelId ?? "") || !["normal", "final-only"].includes(input.mode)
    || !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > 1_000_000
    || !exactObject(input.context) || typeof input.context.systemPrompt !== "string" || !Array.isArray(input.context.messages)
    || !Array.isArray(input.toolNames) || new Set(input.toolNames).size !== input.toolNames.length
    || input.toolNames.some((name) => !TOOL_SET.has(name)) || (input.mode === "final-only" && input.toolNames.length)) throw fail("policy");
  if (Buffer.byteLength(JSON.stringify(input.context)) > 512 * 1024) throw fail("policy");
  return Object.freeze({ modelId: input.modelId, mode: input.mode, context: input.context,
    toolNames: Object.freeze([...input.toolNames]), maxOutputTokens: input.maxOutputTokens });
}

function piMessages(context) {
  const messages = [{ role: "system", content: context.systemPrompt }];
  for (const message of context.messages) {
    if (message?.role === "user") messages.push({ role: "user", content: textOf(message.content) });
    else if (message?.role === "assistant") {
      const text = textOf(message.content); const calls = message.content.filter((item) => item?.type === "toolCall").map((item) => {
        if (typeof item.id !== "string" || !TOOL_SET.has(item.name) || !exactObject(item.arguments)) throw fail("policy");
        return { id: item.id, type: "function", function: { name: item.name, arguments: JSON.stringify(item.arguments) } };
      });
      messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (message?.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || !TOOL_SET.has(message.toolName)) throw fail("policy");
      messages.push({ role: "tool", tool_call_id: message.toolCallId, content: textOf(message.content) });
    } else throw fail("policy");
  }
  return messages;
}

export function buildDeepSeekAgentRequest(input) {
  const request = requestContract(input);
  const tools = request.toolNames.map((name) => ({ type: "function", function: { name, description: `Bounded translation ${name} tool`,
    strict: true, parameters: TOOL_SCHEMAS[name] } }));
  return Object.freeze({ url: `${ORIGIN}/chat/completions`, body: Object.freeze({ model: request.modelId, messages: piMessages(request.context),
    ...(tools.length ? { tools, tool_choice: "auto" } : {}), thinking: { type: "disabled" }, temperature: 0,
    max_tokens: request.maxOutputTokens, stream: false }) });
}

function normalizedUsage(raw) {
  const inputTokens = raw?.prompt_tokens; const outputTokens = raw?.completion_tokens; const totalTokens = raw?.total_tokens;
  const cached = raw?.prompt_cache_hit_tokens ?? 0;
  if (![inputTokens, outputTokens, totalTokens, cached].every((value) => Number.isSafeInteger(value) && value >= 0)
    || inputTokens + outputTokens !== totalTokens || cached > inputTokens) throw fail("malformed-response");
  return Object.freeze({ calls: 1, inputTokens, outputTokens,
    costMicrosCny: Math.ceil(inputTokens * 2.8 + outputTokens * 5.6), costMicrosUsd: 0, durationMs: 0, cachedInputTokens: cached });
}

export function normalizeDeepSeekAgentResponse(input, requestInput, { now = Date.now } = {}) {
  const request = requestContract(requestInput);
  if (!exactObject(input) || typeof input.id !== "string" || !Array.isArray(input.choices) || input.choices.length !== 1) throw fail("malformed-response");
  const choice = input.choices[0]; const message = choice?.message;
  if (choice?.index !== 0 || !exactObject(message)) throw fail("malformed-response");
  if (message.reasoning_content !== undefined && message.reasoning_content !== null && message.reasoning_content !== "") throw fail("policy", false, "reasoning-content");
  const usage = normalizedUsage(input.usage); let content; let stopReason;
  if (choice.finish_reason === "tool_calls") {
    if (request.mode === "final-only" || !Array.isArray(message.tool_calls) || message.tool_calls.length < 1 || message.tool_calls.length > 8) throw fail("policy");
    content = message.tool_calls.map((call) => {
      if (!exactObject(call) || call.type !== "function" || typeof call.id !== "string" || call.id.length < 1 || call.id.length > 128
        || !exactObject(call.function) || !request.toolNames.includes(call.function.name) || typeof call.function.arguments !== "string") throw fail("malformed-response");
      let arguments_; try { arguments_ = JSON.parse(call.function.arguments); } catch { throw fail("malformed-response"); }
      if (!exactObject(arguments_)) throw fail("malformed-response");
      return Object.freeze({ type: "toolCall", id: call.id, name: call.function.name, arguments: Object.freeze(arguments_) });
    }); stopReason = "toolUse";
  } else if (choice.finish_reason === "stop" && typeof message.content === "string") {
    content = [Object.freeze({ type: "text", text: message.content })]; stopReason = "stop";
  } else throw fail(choice?.finish_reason === "content_filter" ? "policy" : "malformed-response");
  const piUsage = Object.freeze({ input: usage.inputTokens - usage.cachedInputTokens, output: usage.outputTokens,
    cacheRead: usage.cachedInputTokens, cacheWrite: 0, totalTokens: usage.inputTokens + usage.outputTokens,
    cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }) });
  return Object.freeze({ responseId: input.id, assistantMessage: Object.freeze({ role: "assistant", content: Object.freeze(content),
    api: "openai-completions", provider: "deepseek", model: request.modelId, responseId: input.id,
    usage: piUsage, stopReason, timestamp: now() }),
  usage: Object.freeze({ calls: usage.calls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    costMicrosCny: usage.costMicrosCny, costMicrosUsd: usage.costMicrosUsd, durationMs: usage.durationMs }) });
}

function http(status) {
  if ([401, 403].includes(status)) return fail("auth", false, status); if (status === 429) return fail("rate-limit", true, status);
  if ([408, 504].includes(status)) return fail("timeout", true, status); return status >= 500 ? fail("provider", true, status) : fail("policy", false, status);
}

export class DeepSeekAgentProvider {
  constructor({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required"); this.fetchImpl = fetchImpl; this.now = now;
  }
  async invoke(input, { credential, signal } = {}) {
    const request = requestContract(input); const outbound = buildDeepSeekAgentRequest(request);
    if (typeof credential !== "string" || credential.length < 1 || /\s/u.test(credential)) throw fail("auth");
    let response;
    try { response = await this.fetchImpl(outbound.url, { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify(outbound.body), redirect: "error", signal }); }
    catch (error) { throw signal?.aborted || error?.name === "AbortError" ? fail("canceled") : fail("unknown-outcome"); }
    if (!response || typeof response.status !== "number") throw fail("malformed-response");
    const declared = Number(response.headers?.get?.("content-length")); if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw fail("malformed-response");
    let bytes; try { bytes = Buffer.from(await response.arrayBuffer()); } catch { throw fail("unknown-outcome"); }
    if (bytes.length > MAX_RESPONSE_BYTES) throw fail("malformed-response");
    let raw; try { raw = JSON.parse(bytes.toString("utf8")); } catch { if (response.ok) throw fail("malformed-response"); }
    if (!response.ok) throw http(response.status);
    return normalizeDeepSeekAgentResponse(raw, request, { now: this.now });
  }
}

export { ALLOWED_TOOLS as M5P_AGENT_TOOLS };
