import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { backup, DatabaseSync } from "node:sqlite";

const root = await mkdtemp(join(tmpdir(), "lectoria-sqlite-compare-"));

function exercise(database, api) {
  database.exec("PRAGMA foreign_keys = ON; CREATE TABLE parent(id TEXT PRIMARY KEY) STRICT; CREATE TABLE child(id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id)) STRICT;");
  database.exec("BEGIN; INSERT INTO parent VALUES ('ok'); COMMIT;");
  let foreignKeyRejected = false;
  try {
    if (api === "better-sqlite3") database.prepare("INSERT INTO child VALUES (?, ?)").run(randomUUID(), "missing");
    else database.prepare("INSERT INTO child VALUES (?, ?)").run(randomUUID(), "missing");
  } catch {
    foreignKeyRejected = true;
  }
  const sqliteVersion = database.prepare("SELECT sqlite_version() AS version").get().version;
  return { sqliteVersion, transaction: true, foreignKeys: foreignKeyRejected };
}

try {
  const betterPath = join(root, "better.sqlite3");
  const better = new Database(betterPath);
  const betterResult = exercise(better, "better-sqlite3");
  better.close();

  const builtInPath = join(root, "builtin.sqlite3");
  const builtIn = new DatabaseSync(builtInPath);
  const builtInResult = exercise(builtIn, "node:sqlite");
  builtIn.close();

  process.stdout.write(`${JSON.stringify({
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    options: [
      {
        name: "better-sqlite3",
        version: "13.0.2",
        license: "MIT",
        stability: "mature external package",
        nativeAddon: true,
        backupApi: typeof Database.prototype.backup === "function",
        ...betterResult,
      },
      {
        name: "node:sqlite",
        version: process.versions.node,
        license: "Node.js runtime",
        stability: "experimental in Node 22.19.0",
        nativeAddon: false,
        backupApi: typeof backup === "function",
        ...builtInResult,
      },
    ],
    selected: "better-sqlite3@13.0.2",
    rationale: "stable public API, explicit version lock, synchronous transaction boundary and backup API; incompatible upstream prebuild is removed and bundled source is compiled in an isolated build stage",
  }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
