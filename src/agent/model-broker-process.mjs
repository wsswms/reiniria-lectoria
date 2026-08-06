import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { DeepSeekAgentError } from "./deepseek-agent-provider.mjs";

export const M5P_AGENT_CREDENTIAL_REF = "external-file:deepseek/m5p-agent";

export function invokeAgentModelBroker({ request, credentialFd, credentialRef = M5P_AGENT_CREDENTIAL_REF }, {
  entry = new URL("./model-broker-entry.mjs", import.meta.url), timeoutMs = 120_000, outputBytes = 4 * 1024 * 1024,
} = {}) {
  if (!Number.isSafeInteger(credentialFd) || credentialFd < 0 || credentialRef !== M5P_AGENT_CREDENTIAL_REF) throw new TypeError("Agent broker credential scope is invalid");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry instanceof URL ? entry.pathname : entry], { cwd: tmpdir(), shell: false,
      env: Object.freeze({ PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production" }), stdio: ["pipe", "pipe", "ignore", credentialFd] });
    const chunks = []; let size = 0; let forced = null; const timer = setTimeout(() => { forced = "unknown-outcome"; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { size += chunk.length; if (size > outputBytes) { forced = "malformed-response"; child.kill("SIGKILL"); } else chunks.push(chunk); });
    child.once("error", () => { forced = "provider"; }); child.once("close", () => { clearTimeout(timer); if (forced) return reject(new DeepSeekAgentError(forced));
      try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value.ok) return reject(new DeepSeekAgentError(value.error?.category, value.error?.retryable, value.error?.providerCode)); resolve(value.response); }
      catch (error) { reject(error instanceof DeepSeekAgentError ? error : new DeepSeekAgentError("malformed-response")); } });
    child.stdin.on("error", () => {}); child.stdin.end(JSON.stringify({ request, credentialRef }));
  });
}
