import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KnowledgeFactService } from "../../src/knowledge/fact-service.mjs";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../../src/storage/backup.mjs";
import { generateGitIgnore } from "../../src/storage/git-policy.mjs";
import { WorkspaceManager } from "../../src/workspace/manager.mjs";
import { termInput, workspace } from "./helpers.mjs";

test("portable fact sources are tracked by policy and survive backup while private layers stay ignored", async () => {
  const fixture = await workspace();
  const target = await mkdtemp(join(tmpdir(), "lectoria-m5-1-restore-"));
  try {
    const service = new KnowledgeFactService(fixture.root, fixture.database, fixture.workspaceId, { now: () => new Date(0) });
    const created = await service.create(termInput(), { type: "user", id: "owner" });
    const ignored = generateGitIgnore([]);
    for (const value of ["state/", "private/", "derived/", "staging/"]) assert.equal(ignored.includes(value), true);
    for (const value of ["dictionary/", "style/", "knowledge/"]) assert.equal(ignored.includes(value), false);

    const backup = join(fixture.root, "backup");
    const manifest = await createWorkspaceBackup({ database: fixture.database, workspaceRoot: fixture.root, destination: backup });
    assert.equal(manifest.portable_facts.length, 1);
    const manager = await WorkspaceManager.create(target);
    try {
      await restoreWorkspaceBackup({ backupRoot: backup, manager });
      const handle = manager.open(fixture.workspaceId);
      assert.equal(await readFile(join(handle.root, created.revision.sourcePath), "utf8"), await readFile(join(fixture.root, created.revision.sourcePath), "utf8"));
      assert.equal(new KnowledgeFactService(handle.root, handle.database, fixture.workspaceId).list().length, 1);
      handle.database.close();
    } finally { manager.close(); }

    const unapproved = join(fixture.root, "dictionary", "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002.json");
    await mkdir(join(unapproved, ".."), { recursive: true });
    await writeFile(unapproved, '{"unapproved":"body"}\n');
    await assert.rejects(createWorkspaceBackup({
      database: fixture.database, workspaceRoot: fixture.root, destination: join(fixture.root, "rejected-backup"),
    }), /backup validation failed/);
  } finally { await fixture.close(); await rm(target, { recursive: true, force: true }); }
});
