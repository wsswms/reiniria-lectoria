import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

export class M5EBoundedBrokerProcessError extends Error {
  constructor(category = "provider", providerCode, localDiagnostic) {
    super("M5E bounded broker process failed"); this.name = "M5EBoundedBrokerProcessError";
    this.category = category; this.retryable = false;
    if (providerCode !== undefined) this.providerCode = String(providerCode).slice(0, 128);
    if (localDiagnostic !== undefined) this.localDiagnostic = String(localDiagnostic).slice(0, 2_048);
  }
}

export function invokeM5EBoundedBrokerProcess({ request, credentialFd, auditFd }, {
  entry = new URL("./m5e-bounded-adjudication-broker-entry.mjs", import.meta.url), timeoutMs = 900_000,
  outputBytes = 32 * 1024 * 1024, diagnosticBytes = 8 * 1024,
} = {}) {
  if (!Number.isSafeInteger(credentialFd) || credentialFd < 0 || !Number.isSafeInteger(auditFd) || auditFd < 0
    || auditFd === credentialFd) throw new TypeError("bounded broker descriptor scope is invalid");
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(process.execPath, [entry instanceof URL ? entry.pathname : entry], { cwd: tmpdir(), shell: false,
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production" },
      stdio: ["pipe", "pipe", "pipe", credentialFd, auditFd] }); }
    catch (error) { reject(new M5EBoundedBrokerProcessError("provider", error?.code,
      `broker-spawn-sync:${error?.name ?? "Error"}:${error?.message ?? "failure"}`)); return; }
    const chunks = []; const diagnostics = []; let size = 0; let diagnosticSize = 0; let forced;
    const timer = setTimeout(() => { forced = "unknown-outcome"; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { size += chunk.length; if (size > outputBytes) { forced = "malformed-response"; child.kill("SIGKILL"); }
      else chunks.push(chunk); });
    child.stderr.on("data", (chunk) => { if (diagnosticSize >= diagnosticBytes) return; const bounded = chunk.subarray(0, diagnosticBytes - diagnosticSize);
      diagnosticSize += bounded.length; diagnostics.push(bounded); });
    child.once("error", (error) => reject(new M5EBoundedBrokerProcessError("provider", error?.code, "broker-spawn")));
    child.once("close", (code) => {
      clearTimeout(timer); const localDiagnostic = Buffer.concat(diagnostics).toString("utf8").replace(/[\r\n\t]+/gu, " ").trim();
      if (forced) return reject(new M5EBoundedBrokerProcessError(forced, "broker-forced", localDiagnostic));
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!result.ok) return reject(new M5EBoundedBrokerProcessError(result.error?.category,
          result.error?.providerCode ?? `broker-exit-${code}`, localDiagnostic));
        resolve(result.response);
      } catch (error) {
        reject(error instanceof M5EBoundedBrokerProcessError ? error
          : new M5EBoundedBrokerProcessError("malformed-response", `broker-exit-${code}`, localDiagnostic));
      }
    });
    child.stdin.on("error", () => {}); child.stdin.end(JSON.stringify({ request,
      credentialRef: "external-file:deepseek/m5c-role", auditEnabled: true }));
  });
}
