import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";

async function files(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) output.push(path);
  }
  return output.sort();
}

test("M5E remains an additive experiment module with no M5C production-path dependency", async () => {
  const sourceRoot = new URL("../../src/", import.meta.url).pathname;
  const experimentRoot = join(sourceRoot, "m5e");
  const experimentFiles = await files(experimentRoot);
  assert.equal(experimentFiles.length >= 5, true);
  for (const path of experimentFiles) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*(?:m5c|provider|research)\//u, relative(sourceRoot, path));
    assert.doesNotMatch(source, /\bfetch\s*\(|api\.deepseek|api\.search\.brave/u, relative(sourceRoot, path));
  }
  for (const path of (await files(sourceRoot)).filter((item) => !item.startsWith(`${experimentRoot}/`))) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*m5e\//u, relative(sourceRoot, path));
  }
});
