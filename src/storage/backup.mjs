import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import Database from "better-sqlite3";
import { assertDatabaseIntegrity, openWorkspaceDatabase } from "../db/connection.mjs";
import { CURRENT_SCHEMA_VERSION } from "../db/migrations.mjs";
import { stableJson } from "../domain/contracts.mjs";
import { rebuildDerived } from "./derived-store.mjs";

const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function files(root) {
  const output = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) output.push(relative(root, path).split(sep).join("/"));
      else throw new Error("backup contains a special file");
    }
  }
  await walk(root);
  return output.sort();
}

function manifestDigest(value) {
  const unsigned = { ...value };
  delete unsigned.manifest_digest;
  return hash(Buffer.from(stableJson(unsigned)));
}

export async function createWorkspaceBackup({ database, workspaceRoot, destination }) {
  const workspaceId = database.prepare("SELECT workspace_id AS workspaceId FROM workspace_meta").get().workspaceId;
  const temporary = `${destination}.tmp-${randomUUID()}`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(join(temporary, "objects"), { recursive: true });
  try {
    await database.backup(join(temporary, "database.sqlite3"));
    const objectRows = database.prepare("SELECT object_id AS objectId, digest, byte_length AS byteLength, relative_path AS relativePath FROM committed_objects ORDER BY object_id").all();
    for (const object of objectRows) {
      const source = join(workspaceRoot, ...object.relativePath.split("/"));
      const target = join(temporary, "objects", object.digest.slice(7));
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target);
    }
    const databaseBytes = await readFile(join(temporary, "database.sqlite3"));
    const manifest = {
      format: "reiniria-workspace-backup-v1", workspace_id: workspaceId,
      schema_version: CURRENT_SCHEMA_VERSION, database_digest: hash(databaseBytes),
      objects: objectRows.map(({ objectId, digest, byteLength }) => ({ object_id: objectId, digest, byte_length: byteLength })),
    };
    manifest.manifest_digest = manifestDigest(manifest);
    await writeFile(join(temporary, "manifest.json"), `${stableJson(manifest)}\n`, { mode: 0o600, flag: "wx" });
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
    return Object.freeze(manifest);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function validateWorkspaceBackup(backupRoot) {
  let manifest;
  try { manifest = JSON.parse(await readFile(join(backupRoot, "manifest.json"), "utf8")); } catch { throw new Error("backup validation failed"); }
  if (manifest.format !== "reiniria-workspace-backup-v1" || manifest.schema_version !== CURRENT_SCHEMA_VERSION || manifest.manifest_digest !== manifestDigest(manifest)) throw new Error("backup validation failed");
  const databaseFile = join(backupRoot, "database.sqlite3");
  if (hash(await readFile(databaseFile)) !== manifest.database_digest) throw new Error("backup validation failed");
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    const identity = database.prepare("SELECT workspace_id AS workspaceId FROM workspace_meta").all();
    if (identity.length !== 1 || identity[0].workspaceId !== manifest.workspace_id) throw new Error("backup validation failed");
    assertDatabaseIntegrity(database);
  } finally { database.close(); }
  const expected = new Set(manifest.objects.map((object) => `objects/${object.digest.slice(7)}`));
  const actual = (await files(join(backupRoot, "objects"))).map((path) => `objects/${path}`);
  if (actual.length !== expected.size || actual.some((path) => !expected.has(path))) throw new Error("backup validation failed");
  for (const object of manifest.objects) {
    const bytes = await readFile(join(backupRoot, "objects", object.digest.slice(7))).catch(() => null);
    if (!bytes || bytes.length !== object.byte_length || hash(bytes) !== object.digest) throw new Error("backup validation failed");
  }
  return Object.freeze(manifest);
}

export async function restoreWorkspaceBackup({ backupRoot, manager }) {
  const manifest = await validateWorkspaceBackup(backupRoot);
  if (manager.registry.get(manifest.workspace_id) || manager.registry.list().some((row) => row.rootKey === manifest.workspace_id)) throw new Error("workspace restore conflict");
  const finalRoot = join(manager.root, "workspaces", manifest.workspace_id);
  if (await stat(finalRoot).then(() => true, (error) => error?.code === "ENOENT" ? false : Promise.reject(error))) throw new Error("workspace restore conflict");
  const temporary = join(manager.root, "workspaces", `.restoring-${manifest.workspace_id}-${randomUUID()}`);
  let activated = false;
  await mkdir(join(temporary, "state"), { recursive: true });
  for (const directory of ["private/objects", "private/ledger", "derived", "staging"]) await mkdir(join(temporary, directory), { recursive: true });
  try {
    await cp(join(backupRoot, "database.sqlite3"), join(temporary, "state", "app.sqlite3"));
    for (const object of manifest.objects) {
      const target = join(temporary, "private", "objects", "sha256", object.digest.slice(7, 9), object.digest.slice(9));
      await mkdir(dirname(target), { recursive: true });
      await cp(join(backupRoot, "objects", object.digest.slice(7)), target);
    }
    await writeFile(join(temporary, "workspace.yaml"), `${stableJson({ schemaVersion: manifest.schema_version, workspaceId: manifest.workspace_id })}\n`);
    const database = openWorkspaceDatabase(join(temporary, "state", "app.sqlite3"), { workspaceId: manifest.workspace_id });
    await rebuildDerived(temporary, database, manifest.workspace_id);
    database.close();
    await rename(temporary, finalRoot);
    activated = true;
    const timestamp = new Date(0).toISOString();
    manager.registry.insert({ workspaceId: manifest.workspace_id, displayName: "Restored workspace", rootKey: manifest.workspace_id, state: "active", schemaVersion: manifest.schema_version, createdAt: timestamp, updatedAt: timestamp });
    return manager.get(manifest.workspace_id);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (activated) await rm(finalRoot, { recursive: true, force: true });
    throw error;
  }
}
