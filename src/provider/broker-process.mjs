import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

export class BrokerProcessError extends Error {
  constructor(category, retryable = false, providerCode) {
    super("provider broker invocation failed");
    this.name = "BrokerProcessError";
    this.category = category;
    this.retryable = retryable === true;
    if (providerCode !== undefined) this.providerCode = String(providerCode);
  }
}

export function invokeBrokerProcess({ request, credentialRef, credential, credentialFd, auditFd, evaluationScope, faultMode }, {
  entry = new URL("./broker-entry.mjs", import.meta.url), timeoutMs = 5_000, outputBytes = 4 * 1024 * 1024,
} = {}) {
  const stringCredential = typeof credential === "string";
  const descriptorCredential = Number.isSafeInteger(credentialFd) && credentialFd >= 0;
  if (stringCredential === descriptorCredential
    || (stringCredential && (credential.length === 0 || Buffer.byteLength(credential) > 16 * 1024))) {
    throw new TypeError("broker credential is invalid");
  }
  if (auditFd !== undefined && (!Number.isSafeInteger(auditFd) || auditFd < 0 || auditFd === credentialFd)) throw new TypeError("broker audit descriptor is invalid");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry instanceof URL ? entry.pathname : entry], {
      cwd: tmpdir(),
      env: Object.freeze({ PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production" }),
      stdio: ["pipe", "pipe", "ignore", descriptorCredential ? credentialFd : "pipe", auditFd === undefined ? "ignore" : auditFd],
      shell: false,
    });
    const chunks = [];
    let bytes = 0;
    let forcedCategory;
    const timer = setTimeout(() => {
      forcedCategory = "unknown-outcome";
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > outputBytes) {
        forcedCategory = "malformed-response";
        child.kill("SIGKILL");
      } else chunks.push(chunk);
    });
    child.once("error", () => reject(new BrokerProcessError("provider")));
    child.once("close", () => {
      clearTimeout(timer);
      if (forcedCategory) return reject(new BrokerProcessError(forcedCategory));
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!result.ok) return reject(new BrokerProcessError(
          result.error?.category ?? "provider",
          result.error?.retryable === true,
          result.error?.providerCode,
        ));
        resolve(result.response);
      } catch (error) {
        reject(error instanceof BrokerProcessError ? error : new BrokerProcessError("malformed-response"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdio[3]?.on("error", () => {});
    child.stdin.end(JSON.stringify({ request, credentialRef, faultMode, auditEnabled: auditFd !== undefined,
      ...(evaluationScope === undefined ? {} : { evaluationScope }) }));
    if (stringCredential) child.stdio[3].end(credential);
  });
}
