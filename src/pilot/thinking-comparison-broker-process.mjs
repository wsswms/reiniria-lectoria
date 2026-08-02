import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

export function invokeDeepSeekThinkingComparison({ request, credentialFd }, { timeoutMs = 90_000, outputBytes = 8 * 1024 * 1024,
  entry = new URL("./thinking-comparison-broker-entry.mjs", import.meta.url) } = {}) {
  if (!Number.isSafeInteger(credentialFd) || credentialFd < 0) throw new TypeError("credential descriptor is invalid");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry instanceof URL ? entry.pathname : entry], { cwd: tmpdir(), shell: false,
      env: Object.freeze({ PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production" }), stdio: ["pipe", "pipe", "ignore", credentialFd] });
    const chunks = []; let size = 0; let forced = null;
    const timer = setTimeout(() => { forced = "unknown-outcome"; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { size += chunk.length; if (size > outputBytes) { forced = "output-limit"; child.kill("SIGKILL"); } else chunks.push(chunk); });
    child.once("error", () => reject(Object.assign(new Error("comparison broker failed"), { category: "provider" })));
    child.once("close", () => { clearTimeout(timer); if (forced) return reject(Object.assign(new Error("comparison broker failed"), { category: forced }));
      try { const result = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!result.ok) throw Object.assign(new Error("comparison broker failed"), { category: result.category }); resolve(result.result); }
      catch (error) { reject(Object.assign(new Error("comparison broker failed"), { category: error?.category ?? "malformed-response" })); } });
    child.stdin.on("error", () => {}); child.stdin.end(JSON.stringify({ request, credentialRef: "external-file:deepseek/thinking-comparison" }));
  });
}
