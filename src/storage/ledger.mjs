import { appendFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { stableJson } from "../domain/contracts.mjs";
import { sanitizeRecord } from "./sanitize.mjs";
import { ensureWorkspaceDirectory, resolveWorkspaceFile } from "../workspace/path-guard.mjs";

export class PrivateLedger {
  constructor(root, { now = () => new Date() } = {}) { this.root = root; this.now = now; }

  async append(event) {
    const directory = await ensureWorkspaceDirectory(this.root, "private/ledger");
    const day = this.now().toISOString().slice(0, 10);
    const record = sanitizeRecord({ ...event, recorded_at: this.now().toISOString() });
    await appendFile(join(directory, `${day}.jsonl`), `${stableJson(record)}\n`, { mode: 0o600 });
    return Object.freeze(record);
  }

  async readDay(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new TypeError("invalid ledger day");
    return readFile(await resolveWorkspaceFile(this.root, `private/ledger/${day}.jsonl`), "utf8");
  }

  async enforceRetention(cutoffDay) {
    const directory = await ensureWorkspaceDirectory(this.root, "private/ledger");
    let removed = 0;
    for (const name of await readdir(directory).catch(() => [])) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) < cutoffDay) {
        await rm(join(directory, name));
        removed += 1;
      }
    }
    return removed;
  }
}
