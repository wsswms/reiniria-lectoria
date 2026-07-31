import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openWorkspaceDatabase } from "../../src/db/connection.mjs";
import { stableJson } from "../../src/domain/contracts.mjs";
import { rebuildDerived } from "../../src/storage/derived-store.mjs";
import { generateGitIgnore, normalizeGitPolicies } from "../../src/storage/git-policy.mjs";
import { PrivateLedger } from "../../src/storage/ledger.mjs";
import { ObjectIntegrityError, ObjectStore } from "../../src/storage/object-store.mjs";
import { stageAtomicOutput } from "../../src/storage/staging.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function workspace(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  for (const path of ["private/objects", "private/ledger", "derived", "staging"]) await (await import("node:fs/promises")).mkdir(join(root, path), { recursive: true });
  const workspaceId = randomUUID();
  const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId });
  return { root, workspaceId, database, close: async () => { database.close(); await rm(root, { recursive: true, force: true }); } };
}

test("every object commit cut point converges without dangling committed facts", async () => {
  for (const point of ["after-temp", "after-rename", "after-db-insert", "after-db-commit"]) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const fixture = await workspace("lectoria-m2-4-fault-");
      const objectId = randomUUID();
      const store = new ObjectStore(fixture.root, fixture.database, fixture.workspaceId, { inject(current) { if (current === point) throw new Error(`injected ${point}`); } });
      try {
        await assert.rejects(store.commit(`content-${point}-${attempt}`, { objectId }), /injected/);
        const count = fixture.database.prepare("SELECT count(*) AS total FROM committed_objects").get().total;
        if (point === "after-db-commit") {
          assert.equal(count, 1);
          assert.equal((await store.read(objectId)).toString(), `content-${point}-${attempt}`);
        } else {
          assert.equal(count, 0);
          await assert.rejects(store.read(objectId), ObjectIntegrityError);
        }
        assert.deepEqual(fixture.database.pragma("integrity_check", { simple: true }), "ok");
      } finally { await fixture.close(); }
    }
  }
});

test("one hundred missing, truncated or same-length corrupted objects are diagnosed", async () => {
  const fixture = await workspace("lectoria-m2-4-corrupt-");
  const store = new ObjectStore(fixture.root, fixture.database, fixture.workspaceId);
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const record = await store.commit(`object-content-${attempt}`);
      const filename = join(fixture.root, ...record.relativePath.split("/"));
      if (attempt % 3 === 0) await rm(filename);
      else if (attempt % 3 === 1) await truncate(filename, 1);
      else await writeFile(filename, Buffer.alloc(record.byteLength, 0x78));
      await assert.rejects(store.read(record.objectId), ObjectIntegrityError);
    }
    assert.equal((await store.inspect()).failures.length, 100);
  } finally { await fixture.close(); }
});

test("private ledger redacts secrets and retention never deletes business facts", async () => {
  const fixture = await workspace("lectoria-m2-4-ledger-");
  const canary = "M2-SECRET-CANARY";
  try {
    const documentId = randomUUID();
    fixture.database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)").run(fixture.workspaceId, documentId, "Business fact", new Date(0).toISOString());
    const oldLedger = new PrivateLedger(fixture.root, { now: () => new Date("2026-01-01T00:00:00Z") });
    const currentLedger = new PrivateLedger(fixture.root, { now: () => new Date("2026-07-31T00:00:00Z") });
    const record = await oldLedger.append({ action: "provider-attempt", api_key: canary, nested: { providerRequest: canary }, summary: "safe" });
    assert.equal(stableJson(record).includes(canary), false);
    assert.equal((await oldLedger.readDay("2026-01-01")).includes(canary), false);
    await currentLedger.append({ action: "safe" });
    assert.equal(await currentLedger.enforceRetention("2026-06-01"), 1);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM documents").get().total, 1);
  } finally { await fixture.close(); }
});

test("derived data rebuilds deterministically from facts without semantic tables", async () => {
  const fixture = await workspace("lectoria-m2-4-derived-");
  try {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const segmentId = randomUUID();
    fixture.database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)").run(fixture.workspaceId, documentId, "Fixture", new Date(0).toISOString());
    fixture.database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)").run(fixture.workspaceId, revisionId, documentId, sha("o"), sha("n"), new Date(0).toISOString());
    fixture.database.prepare("INSERT INTO segments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(fixture.workspaceId, segmentId, revisionId, "p", "/0", "text", sha("text"), 0, 1, "[]");
    const first = await rebuildDerived(fixture.root, fixture.database, fixture.workspaceId);
    await writeFile(join(fixture.root, "derived", "garbage"), "delete me");
    const second = await rebuildDerived(fixture.root, fixture.database, fixture.workspaceId);
    assert.equal(first, second);
    assert.equal(second.includes("embedding"), false);
    assert.equal(second.includes("rerank"), false);
    const tables = fixture.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name.toLowerCase());
    assert.equal(tables.some((name) => name.includes("embedding") || name.includes("rerank")), false);
  } finally { await fixture.close(); }
});

test("staging uses atomic replacement and failures preserve the last successful output", async () => {
  const fixture = await workspace("lectoria-m2-4-staging-");
  try {
    await stageAtomicOutput(fixture.root, "exports/result.md", "version-one");
    await assert.rejects(stageAtomicOutput(fixture.root, "exports/result.md", "version-two", { inject(point) { if (point === "after-temp") throw new Error("injected staging failure"); } }), /injected/);
    assert.equal(await readFile(join(fixture.root, "staging", "exports", "result.md"), "utf8"), "version-one");
    await stageAtomicOutput(fixture.root, "exports/result.md", "version-three");
    assert.equal(await readFile(join(fixture.root, "staging", "exports", "result.md"), "utf8"), "version-three");
  } finally { await fixture.close(); }
});

test("Git policy gives never precedence and always excludes private layers", () => {
  const entries = normalizeGitPolicies([
    { documentId: "track", policy: "track" },
    { documentId: "metadata", policy: "metadata-only" },
    { documentId: "never", policy: "track" },
    { documentId: "never", policy: "never" },
  ]);
  assert.deepEqual(entries.find((entry) => entry.documentId === "never"), { documentId: "never", policy: "never" });
  const ignore = generateGitIgnore(entries);
  for (const path of ["state/", "private/", "derived/", "staging/", "documents/metadata/content/", "documents/never/"]) assert.ok(ignore.includes(path));
  assert.equal(ignore.includes("documents/track/"), false);
});

test("all layered stores reject symlinked parent directories", async () => {
  const fixture = await workspace("lectoria-m2-4-links-");
  const outside = await mkdtemp(join(tmpdir(), "lectoria-m2-4-outside-"));
  try {
    await rm(join(fixture.root, "private", "objects"), { recursive: true });
    await symlink(outside, join(fixture.root, "private", "objects"));
    const store = new ObjectStore(fixture.root, fixture.database, fixture.workspaceId);
    await assert.rejects(store.commit("must-not-escape"), /invalid workspace path/);
    await mkdir(join(fixture.root, "staging", "safe"));
    await symlink(outside, join(fixture.root, "staging", "safe", "escape"));
    await assert.rejects(stageAtomicOutput(fixture.root, "safe/escape/file", "must-not-escape"), /invalid workspace path/);
    assert.deepEqual(await (await import("node:fs/promises")).readdir(outside), []);
  } finally {
    await fixture.close();
    await rm(outside, { recursive: true, force: true });
  }
});

test("business storage results are identical with and without a .git directory", async () => {
  const outputs = [];
  for (const hasGit of [false, true]) {
    const fixture = await workspace("lectoria-m2-4-git-independent-");
    try {
      if (hasGit) await mkdir(join(fixture.root, ".git"));
      const store = new ObjectStore(fixture.root, fixture.database, fixture.workspaceId, { now: () => new Date(0) });
      const record = await store.commit("same-business-content", { objectId: "00000000-0000-4000-8000-000000000001" });
      outputs.push({ digest: record.digest, length: record.byteLength, content: (await store.read(record.objectId)).toString() });
    } finally { await fixture.close(); }
  }
  assert.deepEqual(outputs[0], outputs[1]);
});
