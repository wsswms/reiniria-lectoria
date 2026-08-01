import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stageAtomicDirectory } from "../../src/storage/staging.mjs";

test("deterministic directory replay rejects directory and file symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m3-5-staging-root-"));
  const outside = await mkdtemp(join(tmpdir(), "lectoria-m3-5-staging-outside-"));
  const files = { "content.txt": Buffer.from("content"), "manifest.json": Buffer.from("manifest") };
  try {
    await mkdir(join(root, "staging", "exports"), { recursive: true });
    await writeFile(join(outside, "content.txt"), files["content.txt"]);
    await writeFile(join(outside, "manifest.json"), files["manifest.json"]);
    const target = join(root, "staging", "exports", "artifact");
    await symlink(outside, target, "dir");
    await assert.rejects(stageAtomicDirectory(root, "exports/artifact", files));
    assert.equal((await readFile(join(outside, "content.txt"))).equals(files["content.txt"]), true);

    await rm(target);
    await mkdir(target);
    await symlink(join(outside, "content.txt"), join(target, "content.txt"));
    await writeFile(join(target, "manifest.json"), files["manifest.json"]);
    await assert.rejects(stageAtomicDirectory(root, "exports/artifact", files));
    assert.equal((await readFile(join(outside, "content.txt"))).equals(files["content.txt"]), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
