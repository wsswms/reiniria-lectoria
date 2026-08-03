import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const safe = (value) => {
  const output = String(value ?? "").toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (output.length < 1 || output.length > 120) throw new Error("Detector v3 audit label is invalid"); return output;
};
async function privateDirectory(path) {
  await mkdir(path, { recursive: false, mode: 0o700 }); const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("Detector v3 calls directory is invalid");
}
export class M5EDetectorV3AuditSession {
  static async create(root) {
    const callsRoot = join(root, "llm-calls"); await privateDirectory(callsRoot);
    const value = new M5EDetectorV3AuditSession(root, callsRoot); await value.writeManifest(); return value;
  }
  constructor(root, callsRoot) { this.root = root; this.callsRoot = callsRoot; this.entries = []; this.sequence = 0; }
  async writeManifest() {
    const value = { schemaVersion: "m5e-detector-v3-llm-audit-manifest-v1", dataClass: "user-provided-public-articles-and-provider-content",
      rawContentLocation: "repository-external-current-user-0600", entries: this.entries };
    const target = join(this.root, "llm-audit-manifest.json"); const temporary = join(this.root, `.llm-audit-${process.pid}.tmp`);
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await chmod(temporary, 0o600);
    await rename(temporary, target); await chmod(target, 0o600);
  }
  async invoke(label, metadata, operation) {
    const sequence = ++this.sequence; const filename = `${String(sequence).padStart(4, "0")}-${safe(label)}.jsonl`; const path = join(this.callsRoot, filename);
    const entry = { sequence, filename, ...metadata, status: "started", inputDigest: null, outputDigest: null, fileDigest: null,
      eventCount: 0, actualAttempts: 0, requestBytes: null, responseBytes: null, finishReason: null, usage: null, elapsedMs: null, normalized: null };
    this.entries.push(entry); await this.writeManifest(); const handle = await open(path, "wx", 0o600); await chmod(path, 0o600);
    let result; let invocationError; let auditFailure; try { result = await operation(handle.fd); } catch (error) { invocationError = error; } finally { await handle.close(); }
    try {
      const bytes = await readFile(path); const lines = bytes.toString("utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const requests = lines.filter((event) => event?.event === "request"); const responses = lines.filter((event) => event?.event === "response"); const final = responses.at(-1);
      if (requests.length < 1 || requests.length > 2 || requests.length !== responses.length || !requests[0]?.request?.body || !final) throw new Error("Detector v3 audit sequence is incomplete");
      entry.status = invocationError ? "failed" : "completed"; entry.eventCount = lines.length; entry.actualAttempts = requests.length; entry.fileDigest = digest(bytes);
      entry.inputDigest = digest(JSON.stringify(requests[0].request.body)); entry.requestBytes = requests[0].request.bodyBytes;
      entry.outputDigest = digest(final.response?.rawBody ?? ""); entry.responseBytes = final.response?.bodyBytes ?? null;
      entry.finishReason = final.response?.finishReason ?? null; entry.usage = responses.map((event) => event.response?.usage ?? null);
      entry.elapsedMs = responses.reduce((sum, event) => sum + (event.elapsedMs ?? 0), 0); entry.normalized = final.outcome?.normalized === true;
    } catch (error) { auditFailure = error; entry.status = "audit-failed"; }
    await this.writeManifest(); if (auditFailure) throw auditFailure; if (invocationError) throw invocationError; return result;
  }
  async summary() {
    const manifest = await readFile(join(this.root, "llm-audit-manifest.json"));
    return Object.freeze({ logicalCalls: this.entries.length, actualAttempts: this.entries.reduce((sum, item) => sum + item.actualAttempts, 0),
      manifestDigest: digest(manifest), entries: Object.freeze(this.entries.map((entry) => Object.freeze({ ...entry }))) });
  }
}
