import { createHash, randomUUID } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { TranslationFlowBudgetService } from "../m5c/flow-budget-service.mjs";

const SHA = /^sha256:[a-f0-9]{64}$/u;
const KINDS = new Set(["provider", "remote-tool", "local-tool"]);
const REMOTE = new Set(["provider", "remote-tool"]);
const REMOTE_TOOLS = new Set(["lookup_dictionary", "lookup_entity"]);
const ALL_TOOLS = new Set([...REMOTE_TOOLS, "calculate_number"]);
const FORBIDDEN = new Set(["thinking", "reasoning", "rawResponse", "rawBody", "credential", "secret"]);

export class AgentRuntimeConflictError extends Error {
  constructor(message) { super(message); this.name = "AgentRuntimeConflictError"; this.code = "AGENT_RUNTIME_CONFLICT"; }
}

const digest = (json) => `sha256:${createHash("sha256").update(json).digest("hex")}`;
const required = (value, name, maximum = 256) => {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maximum) throw new TypeError(`${name} is invalid`);
  return value;
};
const sha = (value, name) => { if (!SHA.test(value ?? "")) throw new TypeError(`${name} is invalid`); return value; };
const integer = (value, name, maximum) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`${name} is invalid`); return value;
};
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...keys].sort().join(",");

function assertSafeJson(value, depth = 0) {
  if (depth > 12) throw new TypeError("transcript nesting is invalid");
  if (Array.isArray(value)) { for (const item of value) assertSafeJson(item, depth + 1); return; }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN.has(key) || /(?:api[_-]?key|authorization|password)/iu.test(key)) throw new TypeError("transcript contains forbidden data");
      assertSafeJson(item, depth + 1);
    }
    return;
  }
  if (!["string", "number", "boolean"].includes(typeof value) && value !== null) throw new TypeError("transcript contains unsupported data");
}

function transcriptContract(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 128) throw new TypeError("transcript is invalid");
  for (const message of input) {
    if (!message || !["user", "assistant", "toolResult"].includes(message.role) || !Array.isArray(message.content)) throw new TypeError("transcript is invalid");
    const allowedMessageKeys = message.role === "user" ? new Set(["role", "content", "timestamp"])
      : message.role === "assistant" ? new Set(["role", "content", "api", "provider", "model", "usage", "stopReason", "responseId", "timestamp"])
        : new Set(["role", "toolCallId", "toolName", "content", "details", "isError", "usage", "timestamp"]);
    if (Object.keys(message).some((key) => !allowedMessageKeys.has(key))) throw new TypeError("transcript contains unknown fields");
    for (const block of message.content) {
      if (!block || !["text", "toolCall"].includes(block.type)) throw new TypeError("transcript is invalid");
      if (block.type === "text" && (!exact(block, ["type", "text"]) || typeof block.text !== "string" || Buffer.byteLength(block.text) > 64 * 1024)) throw new TypeError("transcript is invalid");
      if (block.type === "toolCall" && (!exact(block, ["type", "id", "name", "arguments"]) || !required(block.id, "tool call id", 128)
        || !ALL_TOOLS.has(block.name)
        || !block.arguments || typeof block.arguments !== "object" || Array.isArray(block.arguments))) throw new TypeError("transcript is invalid");
    }
    if (message.role === "assistant" && !["stop", "toolUse"].includes(message.stopReason)) throw new TypeError("transcript is invalid");
    if (message.role === "toolResult" && (!required(message.toolCallId, "tool result call id", 128) || !ALL_TOOLS.has(message.toolName))) {
      throw new TypeError("transcript is invalid");
    }
    assertSafeJson(message);
  }
  const json = stableJson(input);
  if (Buffer.byteLength(json) > 512 * 1024) throw new TypeError("transcript is too large");
  return Object.freeze({ messages: Object.freeze(structuredClone(input)), json, transcriptDigest: digest(json) });
}

function finalContract(input) {
  if (!exact(input, ["translation"]) || typeof input.translation !== "string" || input.translation.length === 0 || Buffer.byteLength(input.translation) > 256 * 1024) {
    throw new TypeError("final is invalid");
  }
  const json = stableJson(input); return Object.freeze({ final: Object.freeze({ translation: input.translation }), json, finalDigest: digest(json) });
}

export class AgentRuntimeLedgerService {
  constructor(database, trustedWorkspaceId, { id = () => randomUUID(), now = () => new Date(), inject = () => {}, flowBudgets } = {}) {
    this.database = database; this.workspaceId = required(trustedWorkspaceId, "trustedWorkspaceId", 128);
    this.id = id; this.now = now; this.inject = inject;
    this.flowBudgets = flowBudgets ?? new TranslationFlowBudgetService(database, trustedWorkspaceId, { id, now });
  }

  beginCall(input) {
    const attempt = this.#attempt(input.attemptId);
    const normalized = this.#callInput(input, attempt);
    const existing = this.database.prepare("SELECT * FROM agent_runtime_calls WHERE workspace_id = ? AND call_id = ?")
      .get(this.workspaceId, normalized.callId);
    if (existing) {
      if (!this.#sameCall(existing, normalized)) throw new AgentRuntimeConflictError("call idempotency conflict");
      if (REMOTE.has(normalized.kind) && stableJson(this.#reservedUsage(existing)) !== stableJson(normalized.estimate)) {
        throw new AgentRuntimeConflictError("call budget estimate conflict");
      }
      return Object.freeze({ ...this.#callView(existing), reused: true });
    }
    const open = this.#openCall(attempt.attempt_id); if (open) throw new AgentRuntimeConflictError("unfinished call prevents another RPC");
    const next = this.database.prepare("SELECT coalesce(max(call_sequence), 0) + 1 AS value FROM agent_runtime_calls WHERE workspace_id = ? AND attempt_id = ?")
      .get(this.workspaceId, attempt.attempt_id).value;
    if (normalized.callSequence !== next) throw new AgentRuntimeConflictError("call sequence mismatch");
    this.inject("before-call");
    this.database.transaction(() => {
      if (REMOTE.has(normalized.kind)) this.flowBudgets.reserve(attempt.workflow_id, "translation", normalized.budgetReservationId,
        normalized.estimate, { attemptId: attempt.attempt_id, callId: normalized.callId, kind: normalized.kind });
      this.database.prepare("INSERT INTO agent_runtime_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, normalized.callId, attempt.attempt_id, attempt.task_id, attempt.workflow_id, normalized.callSequence,
          normalized.turnOrdinal, normalized.kind, normalized.name, normalized.toolCallId, normalized.requestDigest,
          normalized.budgetReservationId, this.now().toISOString());
    }).immediate();
    this.inject("after-call");
    return Object.freeze({ ...normalized, workflowId: attempt.workflow_id, reused: false });
  }

  completeCall(callIdInput, input) {
    const callId = required(callIdInput, "callId", 128); const call = this.#call(callId);
    const resultDigest = sha(input?.resultDigest, "resultDigest");
    const receiptDigest = input?.receiptDigest === undefined ? null : sha(input.receiptDigest, "receiptDigest");
    if (call.kind === "local-tool" && !receiptDigest) throw new TypeError("local receipt digest is required");
    if (REMOTE.has(call.kind) && !input?.actualUsage) throw new TypeError("actualUsage is required");
    if (REMOTE.has(call.kind)) {
      const reserved = this.#reservedUsage(call);
      const keys = ["calls", "inputTokens", "outputTokens", "costMicrosCny", "costMicrosUsd", "durationMs"];
      if (keys.some((key) => input.actualUsage[key] > reserved[key])) {
        const unknown = this.markUnknown(callId, { reason: "actual-over-reservation" });
        return Object.freeze({ ...unknown, overrun: true });
      }
    }
    const usageJson = input?.actualUsage ? stableJson(input.actualUsage) : null;
    const existing = this.#outcome(callId);
    if (existing) {
      if (existing.outcome !== "completed" || existing.result_digest !== resultDigest || existing.receipt_digest !== receiptDigest
        || existing.usage_json !== usageJson) throw new AgentRuntimeConflictError("outcome conflict");
      return Object.freeze({ outcome: "completed", resultDigest, reused: true });
    }
    this.inject("before-outcome");
    this.database.transaction(() => {
      if (REMOTE.has(call.kind)) this.flowBudgets.settle(call.workflow_id, call.budget_reservation_id, input.actualUsage,
        { attemptId: call.attempt_id, callId });
      this.#insertOutcome(call, "completed", { resultDigest, receiptDigest, usageJson, details: {} });
    }).immediate();
    this.inject("after-outcome");
    return Object.freeze({ outcome: "completed", resultDigest, reused: false });
  }

  markUnknown(callIdInput, details = {}) {
    const callId = required(callIdInput, "callId", 128); const call = this.#call(callId);
    if (!REMOTE.has(call.kind)) throw new AgentRuntimeConflictError("local work cannot become unknown");
    const existing = this.#outcome(callId);
    if (existing) {
      if (existing.outcome !== "unknown") throw new AgentRuntimeConflictError("outcome conflict");
      return Object.freeze({ outcome: "unknown", reused: true });
    }
    const safeDetails = { reason: required(details.reason ?? "unknown", "unknown reason", 128) };
    this.database.transaction(() => {
      this.flowBudgets.unknown(call.workflow_id, call.budget_reservation_id,
        { attemptId: call.attempt_id, callId, pauseReason: "agent-runtime-unknown-outcome", ...safeDetails });
      this.#insertOutcome(call, "unknown", { details: safeDetails });
      this.database.prepare("UPDATE translation_attempts SET state = 'unknown-outcome', version = version + 1, completed_at = ? WHERE workspace_id = ? AND attempt_id = ? AND state IN ('leased','running')")
        .run(this.now().toISOString(), this.workspaceId, call.attempt_id);
      this.database.prepare("UPDATE attempt_runtime_states SET provider_call_state = 'unknown', error_category = 'unknown-outcome', lease_holder = NULL, lease_expires_at = NULL, heartbeat_at = NULL WHERE workspace_id = ? AND attempt_id = ?")
        .run(this.workspaceId, call.attempt_id);
      this.database.prepare("UPDATE translation_tasks SET state = 'paused', version = version + 1, updated_at = ? WHERE workspace_id = ? AND task_id = ? AND state IN ('queued','running')")
        .run(this.now().toISOString(), this.workspaceId, call.task_id);
    }).immediate();
    return Object.freeze({ outcome: "unknown", reused: false });
  }

  releaseUnissued(callIdInput, details = {}) {
    const callId = required(callIdInput, "callId", 128); const call = this.#call(callId);
    if (!REMOTE.has(call.kind) || details.definitelyUnissued !== true) throw new AgentRuntimeConflictError("release requires definite non-issuance");
    const existing = this.#outcome(callId); if (existing) {
      if (existing.outcome !== "released") throw new AgentRuntimeConflictError("outcome conflict");
      return Object.freeze({ outcome: "released", reused: true });
    }
    this.database.transaction(() => {
      this.flowBudgets.release(call.workflow_id, call.budget_reservation_id, { attemptId: call.attempt_id, callId, reason: "definitely-unissued" });
      this.#insertOutcome(call, "released", { details: { definitelyUnissued: true } });
    }).immediate();
    return Object.freeze({ outcome: "released", reused: false });
  }

  acceptCheckpoint(attemptIdInput, input) {
    const attempt = this.#attempt(attemptIdInput); if (this.#openCall(attempt.attempt_id)) throw new AgentRuntimeConflictError("unfinished call prevents checkpoint");
    const ordinal = integer(input?.ordinal, "checkpoint ordinal", 4); const transcript = transcriptContract(input?.messages);
    const existing = this.database.prepare("SELECT * FROM agent_runtime_checkpoints WHERE workspace_id = ? AND attempt_id = ? AND kind = 'turn' AND ordinal = ?")
      .get(this.workspaceId, attempt.attempt_id, ordinal);
    if (existing) {
      if (existing.transcript_digest !== transcript.transcriptDigest) throw new AgentRuntimeConflictError("checkpoint conflict");
      return Object.freeze({ ordinal, messages: transcript.messages, transcriptDigest: transcript.transcriptDigest, reused: true });
    }
    const next = this.database.prepare("SELECT coalesce(max(ordinal), 0) + 1 AS value FROM agent_runtime_checkpoints WHERE workspace_id = ? AND attempt_id = ? AND kind = 'turn'")
      .get(this.workspaceId, attempt.attempt_id).value;
    if (ordinal !== next) throw new AgentRuntimeConflictError("checkpoint ordinal mismatch");
    this.inject("before-checkpoint");
    this.database.prepare("INSERT INTO agent_runtime_checkpoints VALUES (?, ?, ?, ?, ?, 'turn', ?, ?, NULL, NULL, ?)")
      .run(this.workspaceId, this.id(), attempt.attempt_id, attempt.task_id, ordinal, transcript.json, transcript.transcriptDigest, this.now().toISOString());
    this.inject("after-checkpoint");
    return Object.freeze({ ordinal, messages: transcript.messages, transcriptDigest: transcript.transcriptDigest, reused: false });
  }

  acceptFinal(attemptIdInput, input) {
    const attempt = this.#attempt(attemptIdInput); if (this.#openCall(attempt.attempt_id)) throw new AgentRuntimeConflictError("unfinished call prevents final");
    const final = finalContract(input?.final);
    const checkpoint = this.database.prepare("SELECT * FROM agent_runtime_checkpoints WHERE workspace_id = ? AND attempt_id = ? AND kind = 'turn' ORDER BY ordinal DESC LIMIT 1")
      .get(this.workspaceId, attempt.attempt_id);
    if (!checkpoint || checkpoint.transcript_digest !== input?.checkpointDigest) throw new AgentRuntimeConflictError("final checkpoint mismatch");
    const existing = this.database.prepare("SELECT * FROM agent_runtime_checkpoints WHERE workspace_id = ? AND attempt_id = ? AND kind = 'final'")
      .get(this.workspaceId, attempt.attempt_id);
    if (existing) {
      if (existing.final_digest !== final.finalDigest || existing.transcript_digest !== checkpoint.transcript_digest) throw new AgentRuntimeConflictError("final conflict");
      return Object.freeze({ final: final.final, finalDigest: final.finalDigest, reused: true });
    }
    this.database.prepare("INSERT INTO agent_runtime_checkpoints VALUES (?, ?, ?, ?, ?, 'final', ?, ?, ?, ?, ?)")
      .run(this.workspaceId, this.id(), attempt.attempt_id, attempt.task_id, checkpoint.ordinal, checkpoint.transcript_json,
        checkpoint.transcript_digest, final.json, final.finalDigest, this.now().toISOString());
    return Object.freeze({ final: final.final, finalDigest: final.finalDigest, reused: false });
  }

  recover(attemptIdInput) {
    const attempt = this.#attempt(attemptIdInput); const open = this.#openCall(attempt.attempt_id);
    if (open) {
      // The first ledger schema deliberately stores only a digest for local-tool
      // arguments. After a control-plane crash that digest is insufficient to
      // reconstruct the request, so fail closed instead of guessing or replaying.
      if (open.kind === "local-tool") return Object.freeze({ action: "paused-local-replay", call: this.#callView(open) });
      this.markUnknown(open.call_id, { reason: "interrupted-after-start" });
      return Object.freeze({ action: "paused-unknown", call: this.#callView(open) });
    }
    const calls = this.database.prepare(`SELECT call.*, outcome.outcome, outcome.result_digest AS resultDigest,
      outcome.receipt_digest AS receiptDigest, outcome.usage_json AS usageJson FROM agent_runtime_calls call
      LEFT JOIN agent_runtime_outcomes outcome ON outcome.workspace_id = call.workspace_id AND outcome.call_id = call.call_id
      WHERE call.workspace_id = ? AND call.attempt_id = ? ORDER BY call.call_sequence`).all(this.workspaceId, attempt.attempt_id);
    if (calls.some((call) => call.outcome === "unknown")) return Object.freeze({ action: "paused-unknown", calls: Object.freeze(calls) });
    const final = this.database.prepare("SELECT * FROM agent_runtime_checkpoints WHERE workspace_id = ? AND attempt_id = ? AND kind = 'final'")
      .get(this.workspaceId, attempt.attempt_id);
    const checkpoint = this.database.prepare("SELECT * FROM agent_runtime_checkpoints WHERE workspace_id = ? AND attempt_id = ? AND kind = 'turn' ORDER BY ordinal DESC LIMIT 1")
      .get(this.workspaceId, attempt.attempt_id);
    return Object.freeze({ action: final ? "persist-candidate" : checkpoint ? "resume-host" : "start-host", calls: Object.freeze(calls),
      checkpoint: checkpoint ? Object.freeze({ ordinal: checkpoint.ordinal, messages: JSON.parse(checkpoint.transcript_json), transcriptDigest: checkpoint.transcript_digest }) : null,
      final: final ? Object.freeze(JSON.parse(final.final_json)) : null });
  }

  #attempt(attemptIdInput) {
    const attemptId = required(attemptIdInput, "attemptId", 128);
    const row = this.database.prepare("SELECT * FROM translation_attempts WHERE workspace_id = ? AND attempt_id = ?")
      .get(this.workspaceId, attemptId);
    if (!row) throw new AgentRuntimeConflictError("attempt scope mismatch"); return row;
  }
  #call(callId) {
    const row = this.database.prepare("SELECT * FROM agent_runtime_calls WHERE workspace_id = ? AND call_id = ?").get(this.workspaceId, callId);
    if (!row) throw new AgentRuntimeConflictError("call scope mismatch"); return row;
  }
  #outcome(callId) { return this.database.prepare("SELECT * FROM agent_runtime_outcomes WHERE workspace_id = ? AND call_id = ?").get(this.workspaceId, callId) ?? null; }
  #openCall(attemptId) { return this.database.prepare(`SELECT call.* FROM agent_runtime_calls call LEFT JOIN agent_runtime_outcomes outcome
    ON outcome.workspace_id = call.workspace_id AND outcome.call_id = call.call_id
    WHERE call.workspace_id = ? AND call.attempt_id = ? AND outcome.call_id IS NULL ORDER BY call.call_sequence LIMIT 1`).get(this.workspaceId, attemptId) ?? null; }
  #callInput(input, attempt) {
    const kind = KINDS.has(input?.kind) ? input.kind : (() => { throw new TypeError("call kind is invalid"); })();
    const toolCallId = kind === "provider" ? null : required(input.toolCallId, "toolCallId", 128);
    const budgetReservationId = REMOTE.has(kind) ? required(input.budgetReservationId, "budgetReservationId", 128) : null;
    if (REMOTE.has(kind) && (!input.estimate || typeof input.estimate !== "object")) throw new TypeError("estimate is required");
    if (kind === "provider" && input.name !== attempt.provider_id) throw new AgentRuntimeConflictError("provider identity mismatch");
    if (kind === "remote-tool" && !REMOTE_TOOLS.has(input.name)) throw new AgentRuntimeConflictError("remote tool identity mismatch");
    if (kind === "local-tool" && input.name !== "calculate_number") throw new AgentRuntimeConflictError("local tool identity mismatch");
    return Object.freeze({ callId: required(input.callId, "callId", 128), callSequence: integer(input.callSequence, "callSequence", 64),
      turnOrdinal: integer(input.turnOrdinal, "turnOrdinal", 5), kind, name: required(input.name, "name", 128), toolCallId,
      requestDigest: sha(input.requestDigest, "requestDigest"), budgetReservationId, estimate: input.estimate ?? null, attemptId: attempt.attempt_id });
  }
  #sameCall(row, input) { return row.attempt_id === input.attemptId && row.call_sequence === input.callSequence && row.turn_ordinal === input.turnOrdinal
    && row.kind === input.kind && row.name === input.name && row.tool_call_id === input.toolCallId && row.request_digest === input.requestDigest
    && row.budget_reservation_id === input.budgetReservationId; }
  #callView(row) { return Object.freeze({ callId: row.call_id, attemptId: row.attempt_id, taskId: row.task_id, workflowId: row.workflow_id,
    callSequence: row.call_sequence, turnOrdinal: row.turn_ordinal, kind: row.kind, name: row.name, toolCallId: row.tool_call_id,
    requestDigest: row.request_digest, budgetReservationId: row.budget_reservation_id }); }
  #reservedUsage(call) {
    const row = this.database.prepare("SELECT usage_json AS usageJson FROM flow_budget_ledger WHERE workspace_id = ? AND workflow_id = ? AND reservation_id = ? AND entry_type = 'reserved'")
      .get(this.workspaceId, call.workflow_id, call.budget_reservation_id);
    if (!row) throw new AgentRuntimeConflictError("call budget reservation is missing");
    return JSON.parse(row.usageJson).requested;
  }
  #insertOutcome(call, outcome, { resultDigest = null, receiptDigest = null, usageJson = null, details = {} }) {
    this.database.prepare("INSERT INTO agent_runtime_outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.workspaceId, this.id(), call.call_id, call.attempt_id, outcome, resultDigest, receiptDigest, usageJson,
        stableJson(details), this.now().toISOString());
  }
}
