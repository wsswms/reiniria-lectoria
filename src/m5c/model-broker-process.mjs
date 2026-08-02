import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { M5CDeepSeekRoleError } from "./deepseek-role-adapter.mjs";

export function invokeM5CModelBroker({ request, credentialFd, credentialRef = "external-file:deepseek/m5c-role" }, {
  entry = new URL("./model-broker-entry.mjs", import.meta.url), timeoutMs = 60_000, outputBytes = 4 * 1024 * 1024,
} = {}) {
  if (!Number.isSafeInteger(credentialFd) || credentialFd < 0 || credentialRef !== "external-file:deepseek/m5c-role") throw new TypeError("M5C model broker credential scope is invalid");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry instanceof URL ? entry.pathname : entry], { cwd: tmpdir(), shell: false,
      env: Object.freeze({ PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production" }), stdio: ["pipe", "pipe", "ignore", credentialFd] });
    const chunks = []; let size = 0; let forced; const timer = setTimeout(() => { forced = "unknown-outcome"; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { size += chunk.length; if (size > outputBytes) { forced = "malformed-response"; child.kill("SIGKILL"); } else chunks.push(chunk); });
    child.once("error", () => reject(new M5CDeepSeekRoleError("provider")));
    child.once("close", () => { clearTimeout(timer); if (forced) return reject(new M5CDeepSeekRoleError(forced));
      try { const result = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!result.ok) return reject(new M5CDeepSeekRoleError(result.error?.category, result.error?.retryable, result.error?.providerCode)); resolve(result.response); }
      catch (error) { reject(error instanceof M5CDeepSeekRoleError ? error : new M5CDeepSeekRoleError("malformed-response")); } });
    child.stdin.on("error", () => {}); child.stdin.end(JSON.stringify({ request, credentialRef }));
  });
}
