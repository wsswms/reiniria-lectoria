import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDatabaseIntegrity, openWorkspaceDatabase } from "../src/db/connection.mjs";

let passed = 0;
let foreignKeyRejected = 0;
for (let index = 0; index < 20; index += 1) {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m2-1-measure-"));
  const workspaceId = randomUUID();
  try {
    const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId });
    assertDatabaseIntegrity(database);
    try {
      database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)")
        .run(workspaceId, randomUUID(), randomUUID(), "sha256:" + "0".repeat(64), "sha256:" + "1".repeat(64), new Date(0).toISOString());
    } catch {
      foreignKeyRejected += 1;
    }
    database.close();
    passed += 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

process.stdout.write(`${JSON.stringify({
  stage: "M2.1",
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  initialization_attempts: 20,
  initialization_passed: passed,
  foreign_key_violation_attempts: 20,
  foreign_key_violations_rejected: foreignKeyRejected,
  selected_driver: "better-sqlite3@13.0.2",
}, null, 2)}\n`);
