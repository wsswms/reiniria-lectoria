import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ensureWorkspaceDirectory, resolveWorkspaceFile } from "../workspace/path-guard.mjs";

export class ObjectIntegrityError extends Error {
  constructor() { super("object integrity check failed"); this.name = "ObjectIntegrityError"; this.code = "OBJECT_INTEGRITY_ERROR"; }
}

const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export class ObjectStore {
  constructor(root, database, trustedWorkspaceId, { now = () => new Date(), inject = () => {} } = {}) {
    this.root = root;
    this.database = database;
    this.workspaceId = trustedWorkspaceId;
    this.now = now;
    this.inject = inject;
  }

  async commit(content, { objectId = randomUUID() } = {}) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const digest = sha(bytes);
    const hex = digest.slice("sha256:".length);
    const directory = await ensureWorkspaceDirectory(this.root, `private/objects/sha256/${hex.slice(0, 2)}`);
    const filename = join(directory, hex.slice(2));
    const relativePath = `private/objects/sha256/${hex.slice(0, 2)}/${hex.slice(2)}`;
    const temporary = join(directory, `.tmp-${randomUUID()}`);
    let handle;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle?.close(); }
    this.inject("after-temp", { objectId, digest });
    try { await rename(temporary, filename); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await rm(temporary, { force: true });
    }
    this.inject("after-rename", { objectId, digest });
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO committed_objects VALUES (?, ?, ?, ?, ?, ?)")
        .run(this.workspaceId, objectId, digest, bytes.length, relativePath, this.now().toISOString());
      this.inject("after-db-insert", { objectId, digest });
    })();
    this.inject("after-db-commit", { objectId, digest });
    return Object.freeze({ objectId, digest, byteLength: bytes.length, relativePath });
  }

  async read(objectId) {
    const record = this.database.prepare("SELECT digest, byte_length AS byteLength, relative_path AS relativePath FROM committed_objects WHERE workspace_id = ? AND object_id = ?")
      .get(this.workspaceId, objectId);
    if (!record) throw new ObjectIntegrityError();
    try {
      const filename = await resolveWorkspaceFile(this.root, record.relativePath);
      const info = await stat(filename);
      if (!info.isFile() || info.size !== record.byteLength) throw new ObjectIntegrityError();
      const bytes = await readFile(filename);
      if (sha(bytes) !== record.digest) throw new ObjectIntegrityError();
      return bytes;
    } catch (error) {
      if (error instanceof ObjectIntegrityError) throw error;
      throw new ObjectIntegrityError();
    }
  }

  async inspect() {
    const records = this.database.prepare("SELECT object_id AS objectId FROM committed_objects WHERE workspace_id = ? ORDER BY object_id").all(this.workspaceId);
    const failures = [];
    for (const record of records) {
      try { await this.read(record.objectId); } catch { failures.push(record.objectId); }
    }
    return Object.freeze({ committed: records.length, failures: Object.freeze(failures) });
  }
}
