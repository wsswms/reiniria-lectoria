import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { M5P_AGENT_TOOLS } from "./deepseek-agent-provider.mjs";

export const AGENT_HOST_PROTOCOL_VERSION = "m5p-agent-host-v1";
const TOOL_SET = new Set(M5P_AGENT_TOOLS);
const SHA = /^sha256:[a-f0-9]{64}$/u;
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const bounded = (value, maximum = 128) => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maximum;
export const agentDigest = (value) => `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;

export class AgentHostProtocolError extends Error {
  constructor(message, category = "protocol") { super(message); this.name = "AgentHostProtocolError"; this.category = category; }
}

function envelope(input, response = false) {
  const keys = response ? ["version", "sequence", "correlationId", "type", "ok", "payload"] : ["version", "sequence", "correlationId", "type", "payload"];
  if (!exact(input, keys) || input.version !== AGENT_HOST_PROTOCOL_VERSION || !Number.isSafeInteger(input.sequence) || input.sequence < 1
    || !bounded(input.correlationId) || !bounded(input.type, 64) || !input.payload || typeof input.payload !== "object") throw new AgentHostProtocolError("invalid envelope");
  return input;
}

export function hostStartContract(input) {
  const message = envelope(input); const value = message.payload;
  if (message.sequence !== 1 || message.correlationId !== "start" || message.type !== "start"
    || !exact(value, ["attempt", "limits", "resumeCheckpoint"]) || !exact(value.attempt,
      ["attemptId", "taskId", "providerId", "modelId", "targetLanguage", "sourceText", "protected", "toolNames", "maxOutputTokens"])
    || !bounded(value.attempt.attemptId) || !bounded(value.attempt.taskId) || value.attempt.providerId !== "deepseek" || !bounded(value.attempt.modelId)
    || !bounded(value.attempt.targetLanguage, 64) || typeof value.attempt.sourceText !== "string" || Buffer.byteLength(value.attempt.sourceText) > 64 * 1024
    || !Array.isArray(value.attempt.protected) || !Array.isArray(value.attempt.toolNames) || new Set(value.attempt.toolNames).size !== value.attempt.toolNames.length
    || value.attempt.toolNames.some((name) => !TOOL_SET.has(name)) || !Number.isSafeInteger(value.attempt.maxOutputTokens) || value.attempt.maxOutputTokens < 1
    || !exact(value.limits, ["turns", "toolCalls", "toolResultBytes", "sessionBytes", "runtimeMs"])
    || value.limits.turns !== 4 || value.limits.toolCalls !== 8 || value.limits.toolResultBytes !== 64 * 1024 || value.limits.sessionBytes !== 512 * 1024
    || !Number.isSafeInteger(value.limits.runtimeMs) || value.limits.runtimeMs < 1 || value.limits.runtimeMs > 300_000) throw new AgentHostProtocolError("invalid start");
  if (value.resumeCheckpoint !== null && (!exact(value.resumeCheckpoint, ["ordinal", "messages", "transcriptDigest"])
    || !Number.isSafeInteger(value.resumeCheckpoint.ordinal) || value.resumeCheckpoint.ordinal < 1 || value.resumeCheckpoint.ordinal > 4
    || !Array.isArray(value.resumeCheckpoint.messages) || agentDigest(value.resumeCheckpoint.messages) !== value.resumeCheckpoint.transcriptDigest)) throw new AgentHostProtocolError("invalid resume checkpoint");
  return message;
}

export function hostRequestContract(input, expectedSequence) {
  const message = envelope(input); const value = message.payload;
  if (message.sequence !== expectedSequence || !bounded(value.attemptId)) throw new AgentHostProtocolError("host sequence or identity mismatch");
  if (message.type === "provider.request") {
    if (!exact(value, ["attemptId", "providerId", "modelId", "ordinal", "mode", "context", "contextDigest", "toolNames"])
      || value.providerId !== "deepseek" || !bounded(value.modelId) || !Number.isSafeInteger(value.ordinal) || value.ordinal < 1 || value.ordinal > 5
      || !["normal", "final-only"].includes(value.mode) || !value.context || agentDigest(value.context) !== value.contextDigest
      || !Array.isArray(value.toolNames) || value.toolNames.some((name) => !TOOL_SET.has(name)) || value.mode === "final-only" && value.toolNames.length) throw new AgentHostProtocolError("invalid provider request");
  } else if (message.type === "tool.request") {
    if (!exact(value, ["attemptId", "toolName", "toolCallId", "arguments", "requestDigest"])
      || !TOOL_SET.has(value.toolName) || !bounded(value.toolCallId) || !value.arguments || typeof value.arguments !== "object" || Array.isArray(value.arguments)
      || value.requestDigest !== agentDigest({ toolName: value.toolName, arguments: value.arguments })) throw new AgentHostProtocolError("invalid tool request");
  } else if (message.type === "checkpoint.request") {
    if (!exact(value, ["attemptId", "ordinal", "messages", "transcriptDigest"]) || !Number.isSafeInteger(value.ordinal) || value.ordinal < 1 || value.ordinal > 5
      || !Array.isArray(value.messages) || value.transcriptDigest !== agentDigest(value.messages)) throw new AgentHostProtocolError("invalid checkpoint request");
  } else if (message.type === "final.request") {
    if (!exact(value, ["attemptId", "final", "checkpointDigest"]) || !exact(value.final, ["translation"])
      || typeof value.final.translation !== "string" || !SHA.test(value.checkpointDigest)) throw new AgentHostProtocolError("invalid final request");
  } else if (message.type === "terminal.event") {
    if (!exact(value, ["attemptId", "status", "category"]) || !["completed", "failed", "canceled"].includes(value.status)
      || value.category !== null && !bounded(value.category, 64)) throw new AgentHostProtocolError("invalid terminal event");
  } else throw new AgentHostProtocolError("unknown host request");
  return message;
}

export function parentResponseContract(input, expected) {
  const message = envelope(input, true); const value = message.payload;
  if (message.ok !== true || message.sequence !== expected.sequence || message.correlationId !== expected.correlationId || message.type !== expected.type)
    throw new AgentHostProtocolError("parent response mismatch");
  if (message.type === "provider.response") {
    if (!exact(value, ["attemptId", "providerId", "modelId", "ordinal", "assistantMessage", "usage", "responseDigest"])
      || value.attemptId !== expected.attemptId || value.providerId !== "deepseek" || value.modelId !== expected.modelId || value.ordinal !== expected.ordinal
      || value.responseDigest !== agentDigest(value.assistantMessage) || !exact(value.usage, ["calls", "inputTokens", "outputTokens", "costMicrosCny", "costMicrosUsd", "durationMs"])
      || Object.values(value.usage).some((item) => !Number.isSafeInteger(item) || item < 0)) throw new AgentHostProtocolError("invalid provider response");
  } else if (message.type === "tool.response") {
    if (!exact(value, ["attemptId", "toolName", "toolCallId", "result", "resultDigest", "cacheHit"])
      || value.attemptId !== expected.attemptId || value.toolName !== expected.toolName || value.toolCallId !== expected.toolCallId
      || typeof value.cacheHit !== "boolean" || !value.result || !Array.isArray(value.result.content) || value.resultDigest !== agentDigest(value.result)) throw new AgentHostProtocolError("invalid tool response");
  } else if (message.type === "checkpoint.response") {
    if (!exact(value, ["attemptId", "ordinal", "transcriptDigest", "accepted"]) || value.attemptId !== expected.attemptId
      || value.ordinal !== expected.ordinal || value.transcriptDigest !== expected.transcriptDigest || value.accepted !== true) throw new AgentHostProtocolError("invalid checkpoint response");
  } else if (message.type === "final.response") {
    if (!exact(value, ["attemptId", "checkpointDigest", "accepted"]) || value.attemptId !== expected.attemptId
      || value.checkpointDigest !== expected.checkpointDigest || value.accepted !== true) throw new AgentHostProtocolError("invalid final response");
  } else throw new AgentHostProtocolError("unknown parent response");
  return message;
}

export function encodeHostMessage(value, maximum = 512 * 1024) {
  const encoded = `${JSON.stringify(value)}\n`; if (Buffer.byteLength(encoded) > maximum) throw new AgentHostProtocolError("message limit", "output-limit"); return encoded;
}
