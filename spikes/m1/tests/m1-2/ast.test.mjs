import assert from "node:assert/strict";
import test from "node:test";
import { detectActiveHtml, parseDocument, roundTrip } from "../../src/m1-2/ast.mjs";
import { allFixtures, htmlFixtures, markdownFixtures } from "../fixtures/m1-2/corpus.mjs";

test("fixed corpus contains at least 18 Markdown and 6 HTML fixtures", () => {
  assert.ok(markdownFixtures.length >= 18);
  assert.ok(htmlFixtures.length >= 6);
  assert.equal(allFixtures.length, 24);
});

test("all supported fixtures round-trip with identical critical structure", () => {
  for (const fixture of allFixtures) {
    const result = roundTrip(fixture.kind, fixture.content);
    assert.deepEqual(result.after, result.before, fixture.id);
  }
});

test("active HTML is detected rather than silently treated as safe static content", () => {
  const fixture = htmlFixtures.find((item) => item.id === "html-active");
  const findings = detectActiveHtml(parseDocument("html", fixture.content));
  assert.deepEqual(
    findings.map((item) => item.reason).sort(),
    ["active-tag:iframe", "active-tag:script", "event-handler:onClick"].sort(),
  );
});
