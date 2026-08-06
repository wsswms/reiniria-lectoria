import { spawn } from "node:child_process";
import { digestJson, encode, strictHostRequest, VERSION } from "./protocol.mjs";

const limits = Object.freeze({ turns: 4, toolCalls: 8, toolResultBytes: 64 * 1024, sessionBytes: 512 * 1024 });
const zeroUsage = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });

export async function runSpikeHost({ attempt, providerFixtures, executeTool, resumeCheckpoint = null, fault = null }) {
  const child = spawn(process.execPath, [new URL("./host-entry.mjs", import.meta.url).pathname], {
    cwd: "/tmp", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: "test" }, stdio: ["pipe", "pipe", "pipe"], shell: false,
  });
  child.stdin.on("error", () => {});
  const outcome = { attempt, status: "failed", category: "unknown", providerRequests: [], toolRequests: [], checkpoints: [],
    final: null, transcriptDigest: null, terminalEvents: 0, autoRetries: 0, diagnostics: "" };
  let parentSequence = 2; let hostSequence = 1; let providerIndex = 0; let buffer = ""; let settled = false; let terminating = false;
  const cache = new Map();
  const send = (request, type, payload, { raw, sequenceOffset = 0, correlationId = request.correlationId } = {}) => {
    const message = { version: VERSION, sequence: parentSequence + sequenceOffset, correlationId, type, ok: true, payload };
    if (!sequenceOffset) parentSequence += 1;
    child.stdin.write(raw ?? encode(message));
  };
  const cancel = () => {
    if (!child.stdin.destroyed) child.stdin.write(encode({ version: VERSION, sequence: parentSequence++, correlationId: "cancel", type: "cancel", payload: { attemptId: attempt.attemptId } }));
  };

  const handle = async (raw) => {
    let request;
    try { request = strictHostRequest(JSON.parse(raw), { expectedSequence: hostSequence++ }); }
    catch (error) { outcome.diagnostics = `controller: ${error?.stack ?? error}\nraw: ${raw.slice(0, 2048)}`; child.stdin.end(); return; }
    if (request.type === "provider.request") {
      if (terminating) return;
      outcome.providerRequests.push(request.payload);
      if (["sigterm", "sigkill"].includes(fault)) return child.kill(fault === "sigterm" ? "SIGTERM" : "SIGKILL");
      if (fault === "parent-exit") return child.stdin.end();
      const fixture = providerFixtures[providerIndex++];
      const assistantMessage = JSON.parse(JSON.stringify(typeof fixture === "function" ? await fixture(request.payload) : fixture));
      const payload = { attemptId: attempt.attemptId, providerId: attempt.providerId, modelId: attempt.modelId,
        ordinal: request.payload.ordinal, assistantMessage, usage: zeroUsage, responseDigest: digestJson(assistantMessage) };
      if (fault === "half-line") return send(request, "provider.response", payload, { raw: JSON.stringify({ version: VERSION, sequence: parentSequence,
        correlationId: request.correlationId, type: "provider.response", ok: true, payload }) }), child.stdin.end();
      if (fault === "reordered-response") return send(request, "provider.response", payload, { sequenceOffset: 1 });
      if (fault === "late-response") return send(request, "provider.response", payload, { correlationId: "late-rpc" });
      if (fault === "cancel-first") { cancel(); return; }
      if (fault === "output-limit") {
        payload.assistantMessage.content[0] = { type: "text", text: "x".repeat(600 * 1024) };
        payload.responseDigest = digestJson(payload.assistantMessage);
        const oversized = { version: VERSION, sequence: parentSequence++, correlationId: request.correlationId,
          type: "provider.response", ok: true, payload };
        child.stdin.write(`${JSON.stringify(oversized)}\n`);
        return;
      }
      send(request, "provider.response", payload);
      if (fault === "duplicate-response") send(request, "provider.response", payload, { sequenceOffset: -1 });
      if (fault === "response-first") setTimeout(cancel, 20).unref();
    } else if (request.type === "tool.request") {
      if (fault === "tool-parent-exit") { outcome.toolRequests.push({ ...request.payload, cacheHit: false }); child.stdin.end(); return; }
      const key = request.payload.requestDigest; const cacheHit = cache.has(key);
      const result = cacheHit ? cache.get(key) : await executeTool(request.payload);
      if (!cacheHit) cache.set(key, result);
      outcome.toolRequests.push({ ...request.payload, cacheHit });
      send(request, "tool.response", { attemptId: attempt.attemptId, toolName: request.payload.toolName, toolCallId: request.payload.toolCallId,
        result, resultDigest: digestJson(result), cacheHit });
    } else if (request.type === "checkpoint.request") {
      const checkpoint = { ordinal: request.payload.ordinal, messages: request.payload.messages, transcriptDigest: request.payload.transcriptDigest };
      outcome.checkpoints.push(checkpoint);
      send(request, "checkpoint.response", { attemptId: attempt.attemptId, ordinal: request.payload.ordinal,
        transcriptDigest: request.payload.transcriptDigest, accepted: true });
      const killOrdinal = fault?.startsWith?.("kill-after-checkpoint-") ? Number(fault.slice("kill-after-checkpoint-".length)) : null;
      if (fault === "kill-after-checkpoint" || killOrdinal === request.payload.ordinal) { terminating = true; child.kill("SIGKILL"); }
    } else if (request.type === "final.request") {
      outcome.final = request.payload.final; outcome.transcriptDigest = request.payload.transcriptDigest;
      send(request, "final.response", { attemptId: attempt.attemptId, transcriptDigest: request.payload.transcriptDigest, accepted: true });
    } else if (request.type === "terminal.event") {
      outcome.terminalEvents += 1; outcome.status = request.payload.status; outcome.category = request.payload.category; settled = true;
    }
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { outcome.diagnostics = `${outcome.diagnostics}${chunk}`.slice(-4096); });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (line) void handle(line);
    }
  });
  child.stdin.write(encode({ version: VERSION, sequence: 1, correlationId: "start", type: "start",
    payload: { attempt, limits, resumeCheckpoint } }));

  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
    child.on("close", () => { clearTimeout(timer); resolve(); });
  });
  if (!settled) {
    outcome.status = "failed";
    outcome.category = ["half-line", "duplicate-response", "late-response", "reordered-response", "output-limit"].includes(fault) ? "protocol" : "unknown";
  }
  return Object.freeze(outcome);
}
