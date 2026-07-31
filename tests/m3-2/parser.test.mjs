import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeDocument, validateProtectedText } from "../../src/document/parser.mjs";
import { stableJson } from "../../src/domain/contracts.mjs";
import { negativeFixtures, validFixtures } from "../fixtures/m3-2/corpus.mjs";

test("fixture manifest fixes corpus counts and digest", async () => {
  const manifest = JSON.parse(await readFile(new URL("../fixtures/m3-2/manifest.json", import.meta.url), "utf8"));
  const source = await readFile(new URL("../fixtures/m3-2/corpus.mjs", import.meta.url));
  assert.equal(manifest.valid_fixtures, validFixtures.length);
  assert.equal(manifest.negative_fixtures, negativeFixtures.length);
  assert.equal(manifest.source_sha256, createHash("sha256").update(source).digest("hex"));
});

test("thirty-six fixed fixtures normalize deterministically twenty times", () => {
  assert.equal(validFixtures.length, 36);
  for (const fixture of validFixtures) {
    const expected = normalizeDocument(fixture.format, fixture.content);
    assert.equal(expected.originalDigest.startsWith("sha256:"), true);
    assert.equal(expected.normalizedDigest.startsWith("sha256:"), true);
    assert.equal(expected.projectionDigest.startsWith("sha256:"), true);
    assert.ok(expected.segments.length > 0, fixture.id);
    for (const segment of expected.segments) validateProtectedText(segment.sourceText, segment.protected);
    const expectedSummary = stableJson({
      normalized: expected.normalized,
      projection: expected.projection,
      segments: expected.segments,
      diagnostics: expected.diagnostics,
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const actual = normalizeDocument(fixture.format, fixture.content);
      assert.equal(stableJson({ normalized: actual.normalized, projection: actual.projection, segments: actual.segments, diagnostics: actual.diagnostics }), expectedSummary, fixture.id);
    }
  }
});

test("twelve invalid or dangerous fixtures fail closed or require confirmation", () => {
  assert.equal(negativeFixtures.length, 12);
  for (const fixture of negativeFixtures) {
    if (fixture.expected) {
      assert.throws(
        () => normalizeDocument(fixture.format, fixture.content, { limits: fixture.limits }),
        (error) => error.code === fixture.expected,
        fixture.id,
      );
    } else {
      const result = normalizeDocument(fixture.format, fixture.content);
      assert.equal(result.requiresConfirmation, true, fixture.id);
      assert.ok(result.diagnostics.some((finding) => finding.code === fixture.diagnostic), fixture.id);
      assert.equal(/<script|<iframe|<form|onclick=|javascript:/i.test(result.normalized), false, fixture.id);
    }
  }
});

test("protected values cannot be removed, duplicated, changed or forged", () => {
  const parsed = normalizeDocument("markdown", "Keep `code` and [target](https://example.com/path).");
  const segment = parsed.segments[0];
  assert.equal(segment.protected.length, 2);
  assert.equal(validateProtectedText(segment.sourceText, segment.protected), true);
  assert.throws(() => validateProtectedText(segment.sourceText.replace(segment.protected[0].marker, ""), segment.protected), /count/);
  assert.throws(() => validateProtectedText(`${segment.sourceText}${segment.protected[0].marker}`, segment.protected), /count|duplicated/);
  assert.throws(() => validateProtectedText(segment.sourceText.replace(/[0-9a-f]{16}/, "0000000000000000"), segment.protected), /unknown|missing|count/);
  assert.throws(() => validateProtectedText(`${segment.sourceText}⟦LCT-P-9999-0000000000000000⟧`, segment.protected), /count|unknown/);
});

test("front matter, code, links, images and shortcodes are derived as protected AST items", () => {
  const parsed = normalizeDocument("markdown", "---\ntitle: Fixed\n---\n\nUse `code`, [link](https://example.com), ![image](/a.png), and {{< note key=\"fixed\" >}}.");
  const kinds = parsed.segments.flatMap((segment) => segment.protected.map((item) => item.kind));
  for (const kind of ["yaml", "inlineCode", "link-url", "image-url", "shortcode"]) assert.ok(kinds.includes(kind), kind);
});
