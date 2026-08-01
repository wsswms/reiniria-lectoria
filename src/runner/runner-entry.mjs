import { createHash } from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import { contentText, createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { providerResponseContract } from "../provider/contracts.mjs";
import { RUNNER_OUTPUT_VERSION, runnerOutputContract, runnerTaskContract } from "./protocol.mjs";

async function readInput(maximum = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maximum) throw new Error("runner input limit exceeded");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function responseFor(request) {
  const inputTokens = request.segments.reduce((total, segment) => total + Math.max(1, Math.ceil(segment.sourceText.length / 4)), 0);
  const candidates = request.segments.map((segment) => ({ segmentId: segment.segmentId, text: `${request.targetLanguage}:${segment.sourceText}` }));
  const outputTokens = candidates.reduce((total, candidate) => total + Math.max(1, Math.ceil(candidate.text.length / 4)), 0);
  return providerResponseContract({
    responseId: `runner-fake-${createHash("sha256").update(request.attemptId).digest("hex").slice(0, 24)}`,
    providerId: request.providerId,
    modelId: request.modelId,
    candidates,
    usage: { inputTokens, outputTokens, cachedInputTokens: 0, totalTokens: inputTokens + outputTokens },
  }, request);
}

try {
  const raw = await readInput();
  const task = runnerTaskContract(JSON.parse(raw));
  if (Buffer.byteLength(raw) > task.limits.inputBytes) throw new Error("runner input limit exceeded");
  const response = responseFor(task.request);
  const faux = createFauxCore({ provider: "lectoria-broker-fake", models: [{ id: "fixture-model-v1" }] });
  faux.setResponses([fauxAssistantMessage(JSON.stringify(response))]);
  const agent = new Agent({
    initialState: { systemPrompt: "Return only the supplied structured translation response.", model: faux.getModel(), tools: [] },
    streamFn: faux.streamSimple,
    toolExecution: "sequential",
  });
  await agent.prompt(JSON.stringify({ attemptId: task.request.attemptId, response }));
  const assistant = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
  const brokerResponse = JSON.parse(contentText(assistant.content));
  const output = runnerOutputContract({
    schemaVersion: RUNNER_OUTPUT_VERSION,
    status: "completed",
    taskId: task.request.taskId,
    attemptId: task.request.attemptId,
    providerId: task.request.providerId,
    modelId: task.request.modelId,
    response: brokerResponse,
    toolReceiptDigests: [],
    runtime: "pi-agent-core@0.83.0",
  }, task);
  const encoded = `${JSON.stringify(output)}\n`;
  if (Buffer.byteLength(encoded) > task.limits.outputBytes) throw new Error("runner output limit exceeded");
  process.stdout.write(encoded);
} catch {
  process.stdout.write(`${JSON.stringify({ schemaVersion: RUNNER_OUTPUT_VERSION, status: "failed", category: "runner" })}\n`);
  process.exitCode = 1;
}
