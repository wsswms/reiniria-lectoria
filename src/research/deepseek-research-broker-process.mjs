import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { providerResearchResultContract, researchCaseContract } from "./deepseek-server-research-contracts.mjs";
import { DeepSeekServerResearchError } from "./deepseek-server-research-adapter.mjs";

export const DEEPSEEK_RESEARCH_CREDENTIAL_REF = "external-file:deepseek-server-research/m5f.1";

export function invokeDeepSeekResearchBroker({ researchCase, credentialRef, credentialFd, signal }, {
  entry = new URL("./deepseek-research-broker-entry.mjs", import.meta.url), timeoutMs = 180_000, outputBytes = 4 * 1024 * 1024,
} = {}) {
  const value = researchCaseContract(researchCase);
  if (credentialRef !== DEEPSEEK_RESEARCH_CREDENTIAL_REF || !Number.isSafeInteger(credentialFd) || credentialFd < 0
    || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) throw new TypeError("DeepSeek research broker scope is invalid");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry instanceof URL ? fileURLToPath(entry) : entry], { cwd: tmpdir(), shell: false,
      env: Object.freeze({ PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production" }),
      stdio: ["pipe", "pipe", "ignore", credentialFd] });
    const chunks = []; let size = 0; let forced;
    const abort = () => { forced = "canceled"; child.kill("SIGKILL"); };
    signal?.addEventListener?.("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => { forced = "unknown-outcome"; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { size += chunk.length;
      if (size > outputBytes) { forced = "malformed-response"; child.kill("SIGKILL"); } else chunks.push(chunk); });
    child.once("error", () => reject(new DeepSeekServerResearchError("provider", true)));
    child.once("close", () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abort);
      if (forced) return reject(new DeepSeekServerResearchError(forced, false));
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!result.ok) return reject(new DeepSeekServerResearchError(result.error?.category ?? "provider",
          result.error?.retryable === true, result.error?.providerStatus));
        resolve(providerResearchResultContract(result.response));
      } catch (error) { reject(error instanceof DeepSeekServerResearchError ? error : new DeepSeekServerResearchError("malformed-response", false)); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ schemaVersion: "deepseek-research-broker-envelope-v1", credentialRef, researchCase: value }));
  });
}
