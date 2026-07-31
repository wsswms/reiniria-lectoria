import assert from "node:assert/strict";
import test from "node:test";
import { restoreProtected, tokenizeProtected } from "../../src/m1-2/protection.mjs";
import { markdownFixtures } from "../fixtures/m1-2/corpus.mjs";

test("tokenize and restore preserves every protected value in the corpus", () => {
  for (const fixture of markdownFixtures) {
    const tokenized = tokenizeProtected(fixture.content);
    assert.equal(restoreProtected(tokenized.text, tokenized.protectedItems), fixture.content, fixture.id);
  }
});

test("missing, duplicate, conflicting and forged tokens are rejected", () => {
  const { text, protectedItems } = tokenizeProtected("Use `code` and [manual](https://example.com). ");
  assert.ok(protectedItems.length >= 2);
  assert.throws(() => restoreProtected(text.replace(protectedItems[0].marker, ""), protectedItems));
  assert.throws(() => restoreProtected(`${text}${protectedItems[0].marker}`, protectedItems));
  assert.throws(() => restoreProtected(text.replace(protectedItems[0].marker, "⟦P99:aaaaaaaaaaaa⟧"), protectedItems));
  assert.throws(() => restoreProtected(text.replace(protectedItems[0].marker, protectedItems[1].marker), protectedItems));
});
