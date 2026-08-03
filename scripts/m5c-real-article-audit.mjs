import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const safe = (value) => {
  const output = String(value ?? "").toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (output.length < 1 || output.length > 120) throw new Error("audit call label is invalid"); return output;
};

async function privateDirectory(path) {
  await mkdir(path, { recursive: false, mode: 0o700 }); const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("audit directory must be a newly created current-user 0700 directory");
  }
}

export class RealArticleAuditSession {
  static async create(root) {
    const callsRoot = join(root, "llm-calls"); await privateDirectory(callsRoot);
    const session = new RealArticleAuditSession(root, callsRoot); await session.#writeManifest(); return session;
  }

  constructor(root, callsRoot) { this.root = root; this.callsRoot = callsRoot; this.entries = []; this.sequence = 0; }

  async #writeManifest() {
    const value = { schemaVersion: "m5c-real-article-llm-audit-manifest-v1", dataClass: "user-provided-public-articles-and-provider-content",
      rawContentLocation: "repository-external-current-user-0600", entries: this.entries };
    const target = join(this.root, "llm-audit-manifest.json"); const temporary = join(this.root, `.llm-audit-manifest-${process.pid}.tmp`);
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, target); await chmod(target, 0o600);
  }

  async invoke(label, metadata, operation) {
    if (typeof operation !== "function" || !metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new TypeError("audit operation is invalid");
    const sequence = ++this.sequence; const filename = `${String(sequence).padStart(4, "0")}-${safe(label)}.jsonl`; const path = join(this.callsRoot, filename);
    const entry = { sequence, filename, ...metadata, status: "started", inputDigest: null, outputDigest: null, fileDigest: null,
      eventCount: 0, requestBytes: null, responseBytes: null, finishReason: null, usage: null, elapsedMs: null, normalized: null };
    this.entries.push(entry); await this.#writeManifest();
    const handle = await open(path, "wx", 0o600); await chmod(path, 0o600); let result; let invocationError; let auditError;
    try { result = await operation(handle.fd); } catch (error) { invocationError = error; }
    finally { await handle.close(); }
    try {
      const bytes = await readFile(path); const text = bytes.toString("utf8"); const lines = text.trim().length === 0 ? [] : text.trim().split("\n");
      const events = lines.map((line) => JSON.parse(line)); const request = events.find((event) => event?.event === "request");
      const response = [...events].reverse().find((event) => event?.event === "response");
      if (!request?.request?.body) throw new Error("LLM audit request event is missing");
      entry.status = invocationError ? "failed" : "completed"; entry.eventCount = events.length; entry.fileDigest = digest(bytes);
      entry.inputDigest = digest(JSON.stringify(request.request.body)); entry.requestBytes = request.request.bodyBytes ?? Buffer.byteLength(JSON.stringify(request.request.body));
      if (response) {
        entry.outputDigest = digest(response.response?.rawBody ?? ""); entry.responseBytes = response.response?.bodyBytes ?? null;
        entry.finishReason = response.response?.finishReason ?? null; entry.usage = response.response?.usage ?? null;
        entry.elapsedMs = response.elapsedMs ?? null; entry.normalized = response.outcome?.normalized === true;
      }
      if (!response && !invocationError) throw new Error("LLM audit response event is missing");
    } catch (error) { auditError = error; entry.status = "audit-failed"; }
    await this.#writeManifest();
    if (auditError) throw auditError; if (invocationError) throw invocationError; return result;
  }

  async summary() {
    const manifest = await readFile(join(this.root, "llm-audit-manifest.json"));
    return Object.freeze({ calls: this.entries.length, manifestDigest: digest(manifest), entries: Object.freeze(this.entries.map((entry) => Object.freeze({ ...entry }))) });
  }
}
