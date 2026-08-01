import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { realProviderCorpus } from "../fixtures/m4-5/real-provider-corpus.mjs";

test("real Provider corpus is fixed, public, balanced and multilingual", async () => {
  const sourceUrl = new URL("../fixtures/m4-5/real-provider-corpus.mjs", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("../fixtures/m4-5/manifest.json", import.meta.url), "utf8"));
  const digest = createHash("sha256").update(await readFile(sourceUrl)).digest("hex");
  assert.equal(manifest.source_sha256, digest);
  assert.equal(realProviderCorpus.length, 12);
  assert.equal(new Set(realProviderCorpus.map((item) => item.id)).size, 12);
  for (const [format, count] of Object.entries(manifest.formats)) {
    assert.equal(realProviderCorpus.filter((item) => item.format === format).length, count);
  }
  assert.deepEqual([...new Set(realProviderCorpus.map((item) => item.targetLanguage))].sort(), [...manifest.target_languages].sort());
  assert.ok(["en", "ja", "zh-CN"].every((language) => realProviderCorpus.some((item) => item.sourceLanguage === language)));
  for (const item of realProviderCorpus) {
    assert.ok(item.content.length > 20);
    assert.equal(/api[_-]?key|bearer\s+|password|private key/i.test(item.content), false);
  }
});
