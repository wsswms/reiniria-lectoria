import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

export class RunnerProcessError extends Error {
  constructor(category) {
    super(`runner ${category}`);
    this.name = "RunnerProcessError";
    this.category = category;
  }
}

export async function runRunnerProcess(task, {
  entry = new URL("./runner-entry.mjs", import.meta.url),
  args = [],
  signal,
  timeoutMs = task?.limits?.runtimeMs,
  inputBytes = task?.limits?.inputBytes,
  outputBytes = task?.limits?.outputBytes,
  killGraceMs = 100,
  uid,
  gid,
} = {}) {
  const encoded = JSON.stringify(task);
  if (!Number.isSafeInteger(inputBytes) || Buffer.byteLength(encoded) > inputBytes) throw new RunnerProcessError("input-limit");
  if (!Number.isSafeInteger(outputBytes) || outputBytes <= 0) throw new RunnerProcessError("output-limit");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RunnerProcessError("timeout");
  const hasUid = uid !== undefined;
  const hasGid = gid !== undefined;
  if (hasUid !== hasGid
    || (hasUid && (!Number.isSafeInteger(uid) || uid <= 0 || uid > 2_147_483_647
      || !Number.isSafeInteger(gid) || gid <= 0 || gid > 2_147_483_647))) {
    throw new TypeError("runner uid and gid must be positive safe integers supplied together");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry instanceof URL ? entry.pathname : entry, ...args], {
      cwd: tmpdir(),
      env: Object.freeze({ PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production" }),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      ...(hasUid ? { uid, gid } : {}),
    });
    const stdout = [];
    let stdoutBytes = 0;
    let settled = false;
    let category = "failed";

    const forceKill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const stop = (reason) => {
      category = reason;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      setTimeout(forceKill, killGraceMs).unref();
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const onAbort = () => stop("canceled");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > outputBytes) stop("output-limit");
      else stdout.push(chunk);
    });
    child.stderr.on("data", () => {});
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new RunnerProcessError("spawn"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (category !== "failed") return reject(new RunnerProcessError(category));
      if (code !== 0) return reject(new RunnerProcessError("failed"));
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
      } catch {
        reject(new RunnerProcessError("malformed-output"));
      }
    });
    child.stdin.end(encoded);
  });
}
