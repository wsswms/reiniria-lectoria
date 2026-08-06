import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import Database from "better-sqlite3";
import { assertDatabaseIntegrity, openWorkspaceDatabase } from "../db/connection.mjs";
import { CURRENT_SCHEMA_VERSION } from "../db/migrations.mjs";
import { opaqueId, stableJson } from "../domain/contracts.mjs";
import { validateRelativeWorkspacePath } from "../workspace/path-guard.mjs";
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

const PORTABLE_FACT_DIRECTORIES = Object.freeze(["dictionary", "style", "knowledge"]);

function portableFactPath(value) {
  const parts = validateRelativeWorkspacePath(value);
  if (!PORTABLE_FACT_DIRECTORIES.includes(parts[0]) || parts.length !== 3 || !parts[2].endsWith(".json")) throw new Error("backup validation failed");
  return parts.join("/");
}

async function portableFacts(database, workspaceRoot) {
  const actual = [];
  for (const directory of PORTABLE_FACT_DIRECTORIES) {
    for (const path of await files(join(workspaceRoot, directory))) actual.push(portableFactPath(`${directory}/${path}`));
  }
  actual.sort();
  const rows = database.prepare(`
    SELECT source_path AS path, content_digest AS digest
    FROM knowledge_fact_revisions ORDER BY source_path
  `).all();
  const expected = rows.map((row) => portableFactPath(row.path));
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) throw new Error("backup validation failed");
  for (const row of rows) {
    const bytes = await readFile(join(workspaceRoot, ...portableFactPath(row.path).split("/")));
    if (hash(bytes) !== row.digest) throw new Error("backup validation failed");
  }
  return expected;
}

export async function createWorkspaceBackup({ database, workspaceRoot, destination }) {
  const workspaceId = database.prepare("SELECT workspace_id AS workspaceId FROM workspace_meta").get().workspaceId;
  const temporary = `${destination}.tmp-${randomUUID()}`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(join(temporary, "objects"), { recursive: true });
  await mkdir(join(temporary, "facts"), { recursive: true });
  try {
    await database.backup(join(temporary, "database.sqlite3"));
    const objectRows = database.prepare("SELECT object_id AS objectId, digest, byte_length AS byteLength, relative_path AS relativePath FROM committed_objects ORDER BY object_id").all();
    for (const object of objectRows) {
      const source = join(workspaceRoot, ...object.relativePath.split("/"));
      const target = join(temporary, "objects", object.digest.slice(7));
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target);
    }
    const factRows = [];
    for (const path of await portableFacts(database, workspaceRoot)) {
      const bytes = await readFile(join(workspaceRoot, ...path.split("/")));
      const target = join(temporary, "facts", ...path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await cp(join(workspaceRoot, ...path.split("/")), target);
      factRows.push({ path, digest: hash(bytes), byte_length: bytes.length });
    }
    const databaseBytes = await readFile(join(temporary, "database.sqlite3"));
    const manifest = {
      format: "reiniria-workspace-backup-v1", workspace_id: workspaceId,
      schema_version: CURRENT_SCHEMA_VERSION, database_digest: hash(databaseBytes),
      objects: objectRows.map(({ objectId, digest, byteLength }) => ({ object_id: objectId, digest, byte_length: byteLength })),
      portable_facts: factRows,
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
  if (manifest.format !== "reiniria-workspace-backup-v1" || manifest.schema_version !== CURRENT_SCHEMA_VERSION || !Array.isArray(manifest.objects) || !Array.isArray(manifest.portable_facts) || manifest.manifest_digest !== manifestDigest(manifest)) throw new Error("backup validation failed");
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
  const expectedFacts = new Set(manifest.portable_facts.map((fact) => `facts/${portableFactPath(fact.path)}`));
  const actualFacts = (await files(join(backupRoot, "facts"))).map((path) => `facts/${path}`);
  if (actualFacts.length !== expectedFacts.size || actualFacts.some((path) => !expectedFacts.has(path))) throw new Error("backup validation failed");
  for (const fact of manifest.portable_facts) {
    const path = portableFactPath(fact.path);
    const bytes = await readFile(join(backupRoot, "facts", ...path.split("/"))).catch(() => null);
    if (!bytes || bytes.length !== fact.byte_length || hash(bytes) !== fact.digest) throw new Error("backup validation failed");
  }
  return Object.freeze(manifest);
}

function quoteIdentifier(value) { return `"${value.replaceAll('"', '""')}"`; }

function rebindWorkspaceDatabase(filename, sourceWorkspaceId, targetWorkspaceId) {
  if (sourceWorkspaceId === targetWorkspaceId) return;
  opaqueId(targetWorkspaceId, "targetWorkspaceId");
  const database = new Database(filename);
  try {
    database.pragma("foreign_keys = OFF");
    const triggers = database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL ORDER BY name").all();
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    database.transaction(() => {
      for (const trigger of triggers) database.exec(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`);
      for (const table of tables) {
        const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`).all();
        if (columns.some((column) => column.name === "workspace_id")) {
          database.prepare(`UPDATE ${quoteIdentifier(table.name)} SET workspace_id = ? WHERE workspace_id = ?`).run(targetWorkspaceId, sourceWorkspaceId);
        }
      }
      for (const trigger of triggers) database.exec(trigger.sql);
    })();
    database.pragma("foreign_keys = ON");
    assertDatabaseIntegrity(database);
    const identity = database.prepare("SELECT workspace_id AS workspaceId FROM workspace_meta").all();
    if (identity.length !== 1 || identity[0].workspaceId !== targetWorkspaceId) throw new Error("workspace restore rebind failed");
  } finally { database.close(); }
}

export async function restoreWorkspaceBackup({ backupRoot, manager, targetWorkspaceId = null }) {
  const manifest = await validateWorkspaceBackup(backupRoot);
  const workspaceId = targetWorkspaceId === null ? manifest.workspace_id : opaqueId(targetWorkspaceId, "targetWorkspaceId");
  if (manager.registry.get(workspaceId) || manager.registry.list().some((row) => row.rootKey === workspaceId)) throw new Error("workspace restore conflict");
  const finalRoot = join(manager.root, "workspaces", workspaceId);
  if (await stat(finalRoot).then(() => true, (error) => error?.code === "ENOENT" ? false : Promise.reject(error))) throw new Error("workspace restore conflict");
  const temporary = join(manager.root, "workspaces", `.restoring-${workspaceId}-${randomUUID()}`);
  let activated = false;
  await mkdir(join(temporary, "state"), { recursive: true });
  for (const directory of ["private/objects", "private/ledger", "derived", "staging", ...PORTABLE_FACT_DIRECTORIES]) await mkdir(join(temporary, directory), { recursive: true });
  try {
    await cp(join(backupRoot, "database.sqlite3"), join(temporary, "state", "app.sqlite3"));
    rebindWorkspaceDatabase(join(temporary, "state", "app.sqlite3"), manifest.workspace_id, workspaceId);
    for (const object of manifest.objects) {
      const target = join(temporary, "private", "objects", "sha256", object.digest.slice(7, 9), object.digest.slice(9));
      await mkdir(dirname(target), { recursive: true });
      await cp(join(backupRoot, "objects", object.digest.slice(7)), target);
    }
    for (const fact of manifest.portable_facts) {
      const path = portableFactPath(fact.path);
      const target = join(temporary, ...path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await cp(join(backupRoot, "facts", ...path.split("/")), target);
    }
    await writeFile(join(temporary, "workspace.yaml"), `${stableJson({ schemaVersion: manifest.schema_version, workspaceId })}\n`);
    const database = openWorkspaceDatabase(join(temporary, "state", "app.sqlite3"), { workspaceId });
    await rebuildDerived(temporary, database, workspaceId);
    database.close();
    await rename(temporary, finalRoot);
    activated = true;
    const timestamp = new Date(0).toISOString();
    manager.registry.insert({ workspaceId, displayName: "Restored workspace", rootKey: workspaceId, state: "active", schemaVersion: manifest.schema_version, createdAt: timestamp, updatedAt: timestamp });
    return manager.get(workspaceId);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (activated) await rm(finalRoot, { recursive: true, force: true });
    throw error;
  }
}
