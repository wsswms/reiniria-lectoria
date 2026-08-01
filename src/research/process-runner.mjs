import { runRunnerProcess } from "../runner/process-runner.mjs";
import { researchRunnerOutputContract, researchRunnerTaskContract } from "./runner-protocol.mjs";

export async function runResearchProcess(taskInput, options = {}) {
  const task = researchRunnerTaskContract(taskInput);
  const output = await runRunnerProcess(task, { entry: new URL("./runner-entry.mjs", import.meta.url), ...options });
  return researchRunnerOutputContract(output, task);
}
