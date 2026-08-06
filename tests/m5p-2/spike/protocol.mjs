import { createHash } from "node:crypto";

export const VERSION = "m5p-spike-v1";
export const ALLOWED_TOOLS = Object.freeze(["lookup_dictionary", "lookup_entity", "calculate_number"]);

export class ProtocolError extends Error {
  constructor(message, category = "protocol") {
    super(message);
    this.name = "ProtocolError";
    this.category = category;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export const digestJson = (value) => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const text = (value, maximum = 512) => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maximum;
const sequence = (value) => Number.isSafeInteger(value) && value > 0;

function envelope(input, keys = ["version", "sequence", "correlationId", "type", "payload"]) {
  if (!exact(input, keys) || input.version !== VERSION || !sequence(input.sequence)
    || !text(input.correlationId, 128) || !text(input.type, 64) || !input.payload || typeof input.payload !== "object") {
    throw new ProtocolError("invalid protocol envelope");
  }
  return input;
}

function usage(value) {
  if (!exact(value, ["input", "output", "cacheRead", "cacheWrite", "totalTokens"])) throw new ProtocolError("invalid usage");
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new ProtocolError("invalid usage");
  }
  if (value.totalTokens !== value.input + value.output + value.cacheRead + value.cacheWrite) throw new ProtocolError("invalid usage total");
  return value;
}

function assistantMessage(value) {
  if (!value || value.role !== "assistant" || !Array.isArray(value.content) || !text(value.provider, 128)
    || !text(value.model, 128) || !text(value.api, 128) || !["stop", "toolUse"].includes(value.stopReason)) {
    throw new ProtocolError("invalid assistant message");
  }
  for (const block of value.content) {
    if (!block || typeof block !== "object" || !["text", "toolCall"].includes(block.type)) throw new ProtocolError("invalid assistant content");
    if (block.type === "text" && typeof block.text !== "string") throw new ProtocolError("invalid assistant text");
    if (block.type === "toolCall" && (!text(block.id, 128) || !ALLOWED_TOOLS.includes(block.name)
      || !block.arguments || typeof block.arguments !== "object" || Array.isArray(block.arguments))) throw new ProtocolError("invalid assistant tool call");
  }
  return value;
}

export function strictStart(input) {
  const message = envelope(input);
  if (message.sequence !== 1 || message.type !== "start" || message.correlationId !== "start") throw new ProtocolError("invalid start");
  const value = message.payload;
  if (!exact(value, ["attempt", "limits", "resumeCheckpoint"]) || !exact(value.attempt,
    ["attemptId", "taskId", "providerId", "modelId", "sourceLanguage", "targetLanguage", "sourceText"])
    || !text(value.attempt.attemptId, 128) || !text(value.attempt.taskId, 128) || value.attempt.providerId !== "deepseek"
    || !text(value.attempt.modelId, 128) || !text(value.attempt.sourceText, 64 * 1024)) throw new ProtocolError("invalid start payload");
  if (!exact(value.limits, ["turns", "toolCalls", "toolResultBytes", "sessionBytes"])
    || value.limits.turns !== 4 || value.limits.toolCalls !== 8 || value.limits.toolResultBytes !== 64 * 1024
    || value.limits.sessionBytes !== 512 * 1024) throw new ProtocolError("invalid limits");
  if (value.resumeCheckpoint !== null) {
    const checkpoint = value.resumeCheckpoint;
    if (!exact(checkpoint, ["ordinal", "messages", "transcriptDigest"]) || !sequence(checkpoint.ordinal)
      || !Array.isArray(checkpoint.messages) || digestJson(checkpoint.messages) !== checkpoint.transcriptDigest) throw new ProtocolError("invalid checkpoint");
  }
  return message;
}

export function strictHostRequest(input, { expectedSequence } = {}) {
  const message = envelope(input);
  if (expectedSequence !== undefined && message.sequence !== expectedSequence) throw new ProtocolError("host sequence mismatch");
  const value = message.payload;
  if (!text(value.attemptId, 128)) throw new ProtocolError("invalid attempt identity");
  if (message.type === "provider.request") {
    if (!exact(value, ["attemptId", "providerId", "modelId", "ordinal", "mode", "agentInstanceId", "context", "contextDigest", "toolNames"])
      || value.providerId !== "deepseek" || !text(value.modelId, 128) || !sequence(value.ordinal)
      || !["normal", "final-only"].includes(value.mode) || !text(value.agentInstanceId, 128)
      || !value.context || digestJson(value.context) !== value.contextDigest || !Array.isArray(value.toolNames)
      || value.toolNames.some((name) => !ALLOWED_TOOLS.includes(name)) || (value.mode === "final-only" && value.toolNames.length !== 0)) {
      throw new ProtocolError("invalid provider request");
    }
  } else if (message.type === "tool.request") {
    if (!exact(value, ["attemptId", "toolName", "toolCallId", "arguments", "requestDigest"])
      || !ALLOWED_TOOLS.includes(value.toolName) || !text(value.toolCallId, 128)
      || !value.arguments || typeof value.arguments !== "object" || Array.isArray(value.arguments)
      || digestJson({ toolName: value.toolName, arguments: value.arguments }) !== value.requestDigest) throw new ProtocolError("invalid tool request");
  } else if (message.type === "checkpoint.request") {
    if (!exact(value, ["attemptId", "ordinal", "messages", "transcriptDigest"]) || !sequence(value.ordinal)
      || !Array.isArray(value.messages) || digestJson(value.messages) !== value.transcriptDigest) throw new ProtocolError("invalid checkpoint request");
  } else if (message.type === "final.request") {
    if (!exact(value, ["attemptId", "final", "transcriptDigest"]) || !exact(value.final, ["translation"])
      || typeof value.final.translation !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.transcriptDigest)) throw new ProtocolError("invalid final request");
  } else if (message.type === "terminal.event") {
    if (!exact(value, ["attemptId", "status", "category"]) || !["completed", "canceled", "failed"].includes(value.status)
      || !(value.category === null || text(value.category, 64))) throw new ProtocolError("invalid terminal event");
  } else throw new ProtocolError("unknown host request");
  return message;
}

export function strictParentMessage(input, expected) {
  const message = envelope(input, ["version", "sequence", "correlationId", "type", "ok", "payload"]);
  if (message.sequence !== expected.expectedSequence || message.correlationId !== expected.expectedCorrelationId
    || message.type !== expected.expectedType || message.ok !== true) throw new ProtocolError("parent response mismatch");
  const value = message.payload;
  if (message.type === "provider.response") {
    if (!exact(value, ["attemptId", "providerId", "modelId", "ordinal", "assistantMessage", "usage", "responseDigest"])
      || value.attemptId !== expected.attemptId || value.providerId !== expected.providerId || value.modelId !== expected.modelId
      || value.ordinal !== expected.ordinal) throw new ProtocolError("forged provider response identity");
    assistantMessage(value.assistantMessage); usage(value.usage);
    if (digestJson(value.assistantMessage) !== value.responseDigest) throw new ProtocolError("provider response digest mismatch");
  } else if (message.type === "tool.response") {
    if (!exact(value, ["attemptId", "toolName", "toolCallId", "result", "resultDigest", "cacheHit"])
      || value.attemptId !== expected.attemptId || value.toolName !== expected.toolName || value.toolCallId !== expected.toolCallId
      || typeof value.cacheHit !== "boolean" || !value.result || !Array.isArray(value.result.content)
      || digestJson(value.result) !== value.resultDigest) throw new ProtocolError("forged tool response");
  } else if (message.type === "checkpoint.response") {
    if (!exact(value, ["attemptId", "ordinal", "transcriptDigest", "accepted"]) || value.attemptId !== expected.attemptId
      || value.ordinal !== expected.ordinal || value.transcriptDigest !== expected.transcriptDigest || value.accepted !== true) throw new ProtocolError("checkpoint response mismatch");
  } else if (message.type === "final.response") {
    if (!exact(value, ["attemptId", "transcriptDigest", "accepted"]) || value.attemptId !== expected.attemptId
      || value.transcriptDigest !== expected.transcriptDigest || value.accepted !== true) throw new ProtocolError("final response mismatch");
  } else throw new ProtocolError("unknown parent response");
  return message;
}

export function encode(message, maximum = 512 * 1024) {
  const value = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(value) > maximum) throw new ProtocolError("session output limit", "output-limit");
  return value;
}
