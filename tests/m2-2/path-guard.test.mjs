import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { InvalidWorkspacePathError } from "../../src/workspace/errors.mjs";
import { resolveWorkspaceFile, validateRelativeWorkspacePath, writeWorkspaceFile } from "../../src/workspace/path-guard.mjs";

const execFileAsync = promisify(execFile);

test("path guard rejects traversal, absolute and encoded confusion", () => {
  for (const value of ["../escape", "safe/../escape", "/etc/passwd", "C:/escape", "safe\\escape", "%2e%2e/escape", "%252e%252e/escape", "safe/%2Fescape", "safe\0escape", "./safe", "safe//file"]) {
    assert.throws(() => validateRelativeWorkspacePath(value), InvalidWorkspacePathError);
  }
  assert.deepEqual(validateRelativeWorkspacePath("private/objects/value"), ["private", "objects", "value"]);
});

test("path guard rejects symlinks and special files and never writes outside root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "lectoria-m2-2-path-"));
  const root = join(parent, "workspace");
  const outside = join(parent, "outside");
  await mkdir(join(root, "private", "objects"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "unchanged");
  await symlink(outside, join(root, "private", "escape"));
  const fifo = join(root, "private", "objects", "fifo");
  await execFileAsync("mkfifo", [fifo]);
  try {
    await assert.rejects(resolveWorkspaceFile(root, "private/escape/sentinel"), InvalidWorkspacePathError);
    await assert.rejects(resolveWorkspaceFile(root, "private/objects/fifo"), InvalidWorkspacePathError);
    await assert.rejects(resolveWorkspaceFile(root, "private/objects"), InvalidWorkspacePathError);
    await assert.rejects(writeWorkspaceFile(root, "private/escape/new", "bad"), InvalidWorkspacePathError);
    await assert.rejects(writeWorkspaceFile(root, "../outside/changed", "bad"), InvalidWorkspacePathError);
    await writeWorkspaceFile(root, "private/objects/good", "ok");
    assert.equal(await readFile(join(root, "private", "objects", "good"), "utf8"), "ok");
    assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "unchanged");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
