import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { adapterManifest } from "./adapter-manifest.mjs";
import { WebAdapterError } from "./provider-web-adapters.mjs";

export function invokeResearchWebBroker({ providerId, capability, request, credentialRef, credentialFd }, {
  entry = new URL("./web-broker-entry.mjs", import.meta.url), timeoutMs = 5_000, outputBytes = 4 * 1024 * 1024,
} = {}) {
  const manifest = adapterManifest(providerId, capability);
  if (!Number.isSafeInteger(credentialFd) || credentialFd < 0 || credentialRef !== manifest.credentialRef) throw new TypeError("web broker credential scope is invalid");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry instanceof URL ? entry.pathname : entry], { cwd: tmpdir(), shell: false,
      env: Object.freeze({ PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production" }),
      stdio: ["pipe", "pipe", "ignore", credentialFd] });
    const chunks = []; let size = 0; let forced;
    const timer = setTimeout(() => { forced = "unknown-outcome"; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { size += chunk.length; if (size > outputBytes) { forced = "malformed-response"; child.kill("SIGKILL"); } else chunks.push(chunk); });
    child.once("error", () => reject(new WebAdapterError("provider")));
    child.once("close", () => {
      clearTimeout(timer);
      if (forced) return reject(new WebAdapterError(forced));
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!result.ok) return reject(new WebAdapterError(result.error?.category ?? "provider", result.error?.retryable, result.error?.providerCode));
        if (result.response?.adapterId !== providerId || result.response?.adapterVersion !== manifest.adapterVersion
          || result.response?.directWebEvidence === true || result.response?.lineage === "direct") throw new WebAdapterError("malformed-response");
        resolve(result.response);
      } catch (error) { reject(error instanceof WebAdapterError ? error : new WebAdapterError("malformed-response")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ providerId, capability, request, credentialRef }));
  });
}
