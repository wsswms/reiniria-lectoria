import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openWorkspaceDatabase } from "../db/connection.mjs";
import { CURRENT_SCHEMA_VERSION } from "../db/migrations.mjs";
import { stableJson } from "../domain/contracts.mjs";
import { ResourceNotFoundError } from "./errors.mjs";
import { resolveWorkspaceFile, writeWorkspaceFile } from "./path-guard.mjs";
import { WorkspaceRegistry } from "./registry.mjs";
import { ScopedWorkspaceStore } from "./scoped-store.mjs";

const DIRECTORIES = ["state", "private/objects", "private/ledger", "derived", "staging"];

export class WorkspaceManager {
  constructor(root, { now = () => new Date(), id = () => randomUUID(), inject = () => {} } = {}) {
    this.root = root;
    this.now = now;
    this.id = id;
    this.inject = inject;
    this.registry = new WorkspaceRegistry(join(root, "registry.sqlite3"));
  }

  static async create(root, options) {
    await mkdir(root, { recursive: true });
    return new WorkspaceManager(root, options);
  }

  async createWorkspace(displayName) {
    if (typeof displayName !== "string" || displayName.trim().length === 0) throw new TypeError("displayName is required");
    const workspaceId = this.id();
    const rootKey = workspaceId;
    const timestamp = this.now().toISOString();
    const record = { workspaceId, displayName, rootKey, state: "creating", schemaVersion: CURRENT_SCHEMA_VERSION, createdAt: timestamp, updatedAt: timestamp };
    this.registry.insert(record);
    const workspaceRoot = join(this.root, "workspaces", rootKey);
    try {
      for (const directory of DIRECTORIES) await mkdir(join(workspaceRoot, directory), { recursive: true });
      await writeFile(join(workspaceRoot, "workspace.yaml"), `${stableJson({ schemaVersion: CURRENT_SCHEMA_VERSION, workspaceId })}\n`, { mode: 0o600, flag: "wx" });
      const database = openWorkspaceDatabase(join(workspaceRoot, "state", "app.sqlite3"), { workspaceId, now: this.now });
      database.close();
      this.registry.updateWithAudit(workspaceId, { state: "active", updatedAt: timestamp }, this.#event(workspaceId, "created", timestamp));
      return this.get(workspaceId);
    } catch (error) {
      this.registry.update(workspaceId, { state: "deleting", updatedAt: timestamp });
      await rm(workspaceRoot, { recursive: true, force: true });
      this.registry.delete(workspaceId);
      throw error;
    }
  }

  get(workspaceId) {
    const record = this.registry.get(workspaceId);
    if (!record || !["active", "archived"].includes(record.state)) throw new ResourceNotFoundError();
    return Object.freeze(record);
  }

  list() { return this.registry.list().filter((record) => ["active", "archived"].includes(record.state)).map(Object.freeze); }

  rename(workspaceId, displayName) {
    const record = this.get(workspaceId);
    if (record.state !== "active" || typeof displayName !== "string" || displayName.trim().length === 0) throw new ResourceNotFoundError();
    const timestamp = this.now().toISOString();
    this.registry.updateWithAudit(workspaceId, { displayName, updatedAt: timestamp }, this.#event(workspaceId, "renamed", timestamp));
    return this.get(workspaceId);
  }

  archive(workspaceId) {
    const record = this.get(workspaceId);
    if (record.state !== "active") throw new ResourceNotFoundError();
    this.inject("archive:before-state", record);
    const timestamp = this.now().toISOString();
    this.registry.updateWithAudit(workspaceId, { state: "archived", updatedAt: timestamp }, this.#event(workspaceId, "archived", timestamp));
    this.inject("archive:after-state", record);
    return this.get(workspaceId);
  }

  reopen(workspaceId) {
    const record = this.get(workspaceId);
    if (record.state !== "archived") throw new ResourceNotFoundError();
    const timestamp = this.now().toISOString();
    this.registry.updateWithAudit(workspaceId, { state: "active", updatedAt: timestamp }, this.#event(workspaceId, "reopened", timestamp));
    return this.get(workspaceId);
  }

  open(workspaceId) {
    const record = this.get(workspaceId);
    if (record.state !== "active") throw new ResourceNotFoundError();
    const workspaceRoot = this.#trustedRoot(record);
    const database = openWorkspaceDatabase(join(workspaceRoot, "state", "app.sqlite3"), { workspaceId });
    return Object.freeze({
      record,
      root: workspaceRoot,
      database,
      store: new ScopedWorkspaceStore(database, workspaceId),
      resolveFile: (path) => resolveWorkspaceFile(workspaceRoot, path),
      writeFile: (path, content) => writeWorkspaceFile(workspaceRoot, path, content),
    });
  }

  async delete(workspaceId) {
    const record = this.get(workspaceId);
    const timestamp = this.now().toISOString();
    this.inject("delete:before-state", record);
    this.registry.updateWithAudit(workspaceId, { state: "deleting", updatedAt: timestamp }, this.#event(workspaceId, "delete-started", timestamp));
    this.inject("delete:after-state", record);
    const workspaceRoot = join(this.root, "workspaces", record.rootKey);
    const tombstone = join(this.root, "workspaces", `.deleting-${record.rootKey}`);
    await rename(workspaceRoot, tombstone);
    this.inject("delete:after-rename", record);
    await rm(tombstone, { recursive: true, force: true });
    this.registry.delete(workspaceId);
    this.registry.audit(this.#event(workspaceId, "deleted", this.now().toISOString()));
  }

  #event(workspaceId, action, occurredAt) {
    return { eventId: randomUUID(), workspaceId, action, occurredAt };
  }

  #trustedRoot(record) {
    try {
      const canonicalRoot = realpathSync(this.root);
      const workspaceRoot = join(canonicalRoot, "workspaces", record.rootKey);
      const workspaceInfo = lstatSync(workspaceRoot);
      const stateInfo = lstatSync(join(workspaceRoot, "state"));
      const databaseInfo = lstatSync(join(workspaceRoot, "state", "app.sqlite3"));
      if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory()) throw new Error();
      if (stateInfo.isSymbolicLink() || !stateInfo.isDirectory()) throw new Error();
      if (databaseInfo.isSymbolicLink() || !databaseInfo.isFile()) throw new Error();
      return workspaceRoot;
    } catch {
      throw new ResourceNotFoundError();
    }
  }

  close() { this.registry.close(); }
}
