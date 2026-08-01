import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

export class SearchBrokerError extends Error {
  constructor(category, retryable = false, providerCode) {
    super("search broker invocation failed");
    this.name = "SearchBrokerError";
    this.category = category;
    this.retryable = retryable === true;
    if (providerCode !== undefined) this.providerCode = String(providerCode);
  }
}

export function invokeSearchBroker({ request, credentialRef, credentialFd }, {
  entry = new URL("./broker-entry.mjs", import.meta.url), timeoutMs = 5_000, outputBytes = 4 * 1024 * 1024,
} = {}) {
  if (!Number.isSafeInteger(credentialFd) || credentialFd < 0 || typeof credentialRef !== "string") throw new TypeError("search broker credential is invalid");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry instanceof URL ? entry.pathname : entry], {
      cwd: tmpdir(), env: Object.freeze({ PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production" }),
      stdio: ["pipe", "pipe", "ignore", credentialFd], shell: false,
    });
    const chunks = [];
    let size = 0;
    let forced;
    const timer = setTimeout(() => { forced = "unknown-outcome"; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { size += chunk.length; if (size > outputBytes) { forced = "malformed-response"; child.kill("SIGKILL"); } else chunks.push(chunk); });
    child.once("error", () => reject(new SearchBrokerError("provider")));
    child.once("close", () => {
      clearTimeout(timer);
      if (forced) return reject(new SearchBrokerError(forced));
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!result.ok) return reject(new SearchBrokerError(result.error?.category ?? "provider", result.error?.retryable, result.error?.providerCode));
        resolve(result.response);
      } catch (error) { reject(error instanceof SearchBrokerError ? error : new SearchBrokerError("malformed-response")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ request, credentialRef }));
  });
}
