import { runnerOutputContract, RUNNER_TASK_VERSION } from "./protocol.mjs";
import { runRunnerProcess } from "./process-runner.mjs";

export async function invokeProviderThroughRunner({
  request,
  invokeProvider,
  providerOptions,
  capabilityAuthority,
  signal,
  limits = {},
  runnerIdentity,
}) {
  if (typeof invokeProvider !== "function") throw new TypeError("invokeProvider is required");
  if (!capabilityAuthority || typeof capabilityAuthority.issue !== "function" || typeof capabilityAuthority.revoke !== "function") {
    throw new TypeError("capabilityAuthority is required");
  }
  const brokerResponse = await invokeProvider(request, { ...providerOptions, signal });
  const capability = capabilityAuthority.issue({
    workspaceId: request.workspaceId,
    taskId: request.taskId,
    attemptId: request.attemptId,
    scopes: ["segment:read", "candidate:submit"],
    expiresAt: Date.now() + 60_000,
  });
  const task = Object.freeze({
    schemaVersion: RUNNER_TASK_VERSION,
    request,
    brokerResponse,
    capability: { token: capability.token },
    limits: {
      inputBytes: limits.inputBytes ?? 4 * 1024 * 1024,
      outputBytes: limits.outputBytes ?? 4 * 1024 * 1024,
      toolCalls: limits.toolCalls ?? 2,
      runtimeMs: limits.runtimeMs ?? 30_000,
    },
  });
  try {
    const output = await runRunnerProcess(task, { signal, ...runnerIdentity });
    return runnerOutputContract(output, task).response;
  } finally {
    capabilityAuthority.revoke(capability.token);
  }
}
