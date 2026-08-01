import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

export class BrokerProcessError extends Error {
  constructor(category) {
    super("provider broker invocation failed");
    this.name = "BrokerProcessError";
    this.category = category;
  }
}

export function invokeBrokerProcess({ request, credentialRef, credential, faultMode }, {
  entry = new URL("./broker-entry.mjs", import.meta.url), timeoutMs = 5_000, outputBytes = 4 * 1024 * 1024,
} = {}) {
  if (typeof credential !== "string" || credential.length === 0 || Buffer.byteLength(credential) > 16 * 1024) {
    throw new TypeError("broker credential is invalid");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry instanceof URL ? entry.pathname : entry], {
      cwd: tmpdir(),
      env: Object.freeze({ PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production" }),
      stdio: ["pipe", "pipe", "ignore", "pipe"],
      shell: false,
    });
    const chunks = [];
    let bytes = 0;
    let forcedCategory;
    const timer = setTimeout(() => {
      forcedCategory = "timeout";
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > outputBytes) {
        forcedCategory = "output-limit";
        child.kill("SIGKILL");
      } else chunks.push(chunk);
    });
    child.once("error", () => reject(new BrokerProcessError("spawn")));
    child.once("close", () => {
      clearTimeout(timer);
      if (forcedCategory) return reject(new BrokerProcessError(forcedCategory));
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!result.ok) return reject(new BrokerProcessError(result.error?.category ?? "provider"));
        resolve(result.response);
      } catch (error) {
        reject(error instanceof BrokerProcessError ? error : new BrokerProcessError("malformed-output"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdio[3].on("error", () => {});
    child.stdin.end(JSON.stringify({ request, credentialRef, faultMode }));
    child.stdio[3].end(credential);
  });
}
