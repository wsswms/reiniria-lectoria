import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { AGENT_HOST_PROTOCOL_VERSION, agentDigest, encodeHostMessage, hostRequestContract } from "./host-protocol.mjs";

const LIMITS = Object.freeze({ turns: 4, toolCalls: 8, toolResultBytes: 64 * 1024, sessionBytes: 512 * 1024, runtimeMs: 120_000 });
const zero = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, costMicrosCny: 0, costMicrosUsd: 0, durationMs: 0 });
const plus = (left, right) => Object.freeze(Object.fromEntries(Object.keys(zero()).map((key) => [key, left[key] + right[key]])));

export class AgentHostProcessError extends Error {
  constructor(category = "agent-host", diagnostics = "") { super(`Agent Host ${category}${diagnostics ? ` (${diagnostics})` : ""}`); this.name = "AgentHostProcessError"; this.category = category; }
}

function defaultProviderEstimate(attempt) {
  const inputTokens = Math.max(1, Math.ceil((Buffer.byteLength(attempt.sourceText) + 4096) / 4)); const outputTokens = attempt.maxOutputTokens;
  return Object.freeze({ calls: 1, inputTokens, outputTokens, costMicrosCny: Math.ceil(inputTokens * 2.8 + outputTokens * 5.6),
    costMicrosUsd: 0, durationMs: LIMITS.runtimeMs });
}
const defaultToolEstimate = () => Object.freeze({ calls: 1, inputTokens: 4096, outputTokens: 1024, costMicrosCny: 30_000, costMicrosUsd: 100_000, durationMs: 60_000 });

export async function runAgentHostProcess({ attempt, ledger, invokeRound, executeTool, resumeCheckpoint = null, signal,
  estimateProvider = defaultProviderEstimate, estimateTool = defaultToolEstimate, entry = new URL("./host-entry.mjs", import.meta.url), uid, gid } = {}) {
  if (!attempt || attempt.providerId !== "deepseek" || typeof invokeRound !== "function" || typeof executeTool !== "function"
    || !ledger || typeof ledger.beginCall !== "function" || typeof ledger.completeCall !== "function") throw new TypeError("Agent Host dependencies are invalid");
  const hasIdentity = uid !== undefined || gid !== undefined; if (hasIdentity && (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1)) throw new TypeError("Agent Host identity is invalid");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry instanceof URL ? entry.pathname : entry], { cwd: tmpdir(), shell: false,
      env: Object.freeze({ PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production" }), stdio: ["pipe", "pipe", "pipe"],
      ...(hasIdentity ? { uid, gid } : {}) });
    child.stdin.on("error", () => {}); let parentSequence = 2; let hostSequence = 1; let callSequence = 0; let buffer = ""; let chain = Promise.resolve();
    let settled = false; let forced = null; let diagnostics = ""; let providerUsage = zero(); const receipts = []; const checkpoints = []; let final = null;
    const timer = setTimeout(() => { forced = "timeout"; child.kill("SIGKILL"); }, LIMITS.runtimeMs);
    const abort = () => { if (!child.stdin.destroyed) child.stdin.write(encodeHostMessage({ version: AGENT_HOST_PROTOCOL_VERSION, sequence: parentSequence++, correlationId: "cancel",
      type: "cancel", payload: { attemptId: attempt.attemptId } })); };
    signal?.addEventListener("abort", abort, { once: true });
    const send = (request, type, payload) => child.stdin.write(encodeHostMessage({ version: AGENT_HOST_PROTOCOL_VERSION, sequence: parentSequence++,
      correlationId: request.correlationId, type, ok: true, payload }));
    const handle = async (line) => {
      const request = hostRequestContract(JSON.parse(line), hostSequence++); const value = request.payload;
      if (value.attemptId !== attempt.attemptId) throw new AgentHostProcessError("identity");
      if (request.type === "provider.request") {
        const estimate = estimateProvider(attempt, value); const sequence = ++callSequence; const callId = `agent:${attempt.attemptId}:${sequence}`;
        ledger.beginCall({ attemptId: attempt.attemptId, callId, callSequence: sequence, turnOrdinal: value.ordinal, kind: "provider", name: "deepseek",
          requestDigest: value.contextDigest, budgetReservationId: `agent-budget:${attempt.attemptId}:${sequence}`, estimate });
        let response; try { response = await invokeRound({ modelId: attempt.modelId, mode: value.mode, context: value.context,
          toolNames: value.toolNames, maxOutputTokens: attempt.maxOutputTokens }, { signal }); }
        catch (error) { ledger.markUnknown(callId, { reason: "provider-no-trusted-result" }); throw error; }
        ledger.completeCall(callId, { resultDigest: agentDigest(response.assistantMessage), actualUsage: response.usage });
        providerUsage = plus(providerUsage, response.usage); send(request, "provider.response", { attemptId: attempt.attemptId, providerId: "deepseek",
          modelId: attempt.modelId, ordinal: value.ordinal, assistantMessage: response.assistantMessage, usage: response.usage,
          responseDigest: agentDigest(response.assistantMessage) });
      } else if (request.type === "tool.request") {
        if (!attempt.toolNames.includes(value.toolName)) throw new AgentHostProcessError("tool-policy"); const local = value.toolName === "calculate_number";
        const sequence = ++callSequence; const callId = `agent:${attempt.attemptId}:${sequence}`; const estimate = local ? null : estimateTool(attempt, value);
        ledger.beginCall({ attemptId: attempt.attemptId, callId, callSequence: sequence, turnOrdinal: Math.min(LIMITS.turns + 1, Math.max(1, checkpoints.length + 1)),
          kind: local ? "local-tool" : "remote-tool", name: value.toolName, toolCallId: value.toolCallId, requestDigest: value.requestDigest,
          ...(local ? {} : { budgetReservationId: `agent-budget:${attempt.attemptId}:${sequence}`, estimate }) });
        let output; try { output = await executeTool(value, { signal }); }
        catch (error) { if (!local) ledger.markUnknown(callId, { reason: "tool-no-trusted-result" }); throw error; }
        if (!output || !output.result || !Array.isArray(output.result.content) || typeof output.cacheHit !== "boolean") throw new AgentHostProcessError("tool-result");
        const resultDigest = agentDigest(output.result); if (local) {
          if (typeof output.receiptDigest !== "string") throw new AgentHostProcessError("tool-receipt"); ledger.completeCall(callId, { resultDigest, receiptDigest: output.receiptDigest }); receipts.push(output.receiptDigest);
        } else ledger.completeCall(callId, { resultDigest, actualUsage: output.usage ?? zero() });
        send(request, "tool.response", { attemptId: attempt.attemptId, toolName: value.toolName, toolCallId: value.toolCallId,
          result: output.result, resultDigest, cacheHit: output.cacheHit });
      } else if (request.type === "checkpoint.request") {
        const accepted = ledger.acceptCheckpoint(attempt.attemptId, { ordinal: value.ordinal, messages: value.messages }); checkpoints.push(accepted);
        send(request, "checkpoint.response", { attemptId: attempt.attemptId, ordinal: value.ordinal, transcriptDigest: accepted.transcriptDigest, accepted: true });
      } else if (request.type === "final.request") {
        const accepted = ledger.acceptFinal(attempt.attemptId, { final: value.final, checkpointDigest: value.checkpointDigest }); final = accepted.final;
        send(request, "final.response", { attemptId: attempt.attemptId, checkpointDigest: value.checkpointDigest, accepted: true });
      } else if (request.type === "terminal.event") { settled = value.status === "completed"; if (!settled) forced = value.category ?? "agent-host"; child.stdin.end(); }
    };
    child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { buffer += chunk; for (let at; (at = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line) chain = chain.then(() => handle(line)).catch((error) => { forced = error?.category ?? "protocol"; child.kill("SIGKILL"); }); } });
    child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-1024); });
    child.once("error", () => { forced = "spawn"; }); child.once("close", () => { clearTimeout(timer); signal?.removeEventListener("abort", abort);
      void chain.finally(() => { if (settled && final) resolve(Object.freeze({ status: "completed", final, providerUsage, toolReceiptDigests: Object.freeze(receipts), checkpoints: Object.freeze(checkpoints) }));
        else reject(new AgentHostProcessError(forced ?? (buffer ? "half-line" : "unknown"), diagnostics.trim())); }); });
    child.stdin.write(encodeHostMessage({ version: AGENT_HOST_PROTOCOL_VERSION, sequence: 1, correlationId: "start", type: "start",
      payload: { attempt, limits: LIMITS, resumeCheckpoint } }));
  });
}
