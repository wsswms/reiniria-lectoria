import { RUNNER_OUTPUT_VERSION, runnerOutputContract, runnerTaskContract } from "./protocol.mjs";

async function readInput(maximum = 4 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > maximum) throw new Error("runner input limit exceeded"); chunks.push(chunk); }
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const raw = await readInput(); const task = runnerTaskContract(JSON.parse(raw));
  if (task.brokerResponse === undefined) throw Object.assign(new Error("legacy transfer is removed"), { category: "policy" });
  // runnerTaskContract has already normalized and validated the Broker result;
  // reuse that immutable value instead of reparsing it in the low-privilege child.
  const response = task.brokerResponse;
  const output = runnerOutputContract({ schemaVersion: RUNNER_OUTPUT_VERSION, status: "completed", taskId: task.request.taskId,
    attemptId: task.request.attemptId, providerId: task.request.providerId, modelId: task.request.modelId, response, toolReceiptDigests: [],
    runtime: "pi-agent-core@0.83.0" }, task);
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ schemaVersion: RUNNER_OUTPUT_VERSION, status: "failed", category: error?.category ?? "runner" })}\n`); process.exitCode = 1;
}
