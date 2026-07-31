import assert from "node:assert/strict";
import test from "node:test";
import { alignSegments, seedSegments } from "../../src/m1-2/segments.mjs";
import { allFixtures } from "../fixtures/m1-2/corpus.mjs";

function baseTexts(fixture) {
  return [
    `${fixture.id} introduction contains enough stable context for alignment testing.`,
    `${fixture.id} middle paragraph discusses aperture shutter speed and exposure choices.`,
    `${fixture.id} final paragraph records a deterministic conclusion for later comparison.`,
  ];
}

function ids(segments) {
  return new Map(segments.map((segment) => [segment.text, segment.id]));
}

test("all 24 fixtures derive seven deterministic update scenarios", () => {
  let scenarioCount = 0;
  for (const fixture of allFixtures) {
    const texts = baseTexts(fixture);
    const oldSegments = seedSegments(texts);
    const expected = ids(oldSegments);
    const scenarios = {
      insert: [texts[0], "A newly inserted paragraph has no previous identity.", texts[1], texts[2]],
      delete: [texts[0], texts[2]],
      move: [texts[2], texts[0], texts[1]],
      format: texts.map((text) => `  ${text.replaceAll(" ", "   ")}  `),
      rewrite: texts.map((text) => text.replace("deterministic", "carefully deterministic")),
      split: [texts[0].slice(0, 36), texts[0].slice(36), texts[1], texts[2]],
      merge: [texts[0], `${texts[1]} ${texts[2]}`],
    };
    scenarioCount += Object.keys(scenarios).length;

    for (const name of ["insert", "delete", "move"]) {
      const aligned = alignSegments(oldSegments, scenarios[name]);
      for (const segment of aligned.filter((item) => expected.has(item.text))) {
        assert.equal(segment.id, expected.get(segment.text), `${fixture.id}:${name}`);
      }
    }

    const formatted = alignSegments(oldSegments, scenarios.format);
    assert.equal(formatted.filter((segment) => segment.id).length, texts.length, `${fixture.id}:format`);
    const rewritten = alignSegments(oldSegments, scenarios.rewrite);
    assert.ok(rewritten.filter((segment) => segment.id).length / texts.length >= 0.85, `${fixture.id}:rewrite`);
    assert.equal(new Set(rewritten.filter((segment) => segment.id).map((segment) => segment.id)).size, rewritten.filter((segment) => segment.id).length);

    const split = alignSegments(oldSegments, scenarios.split);
    assert.ok(split.slice(0, 2).every((segment) => !segment.id && segment.status === "ambiguous"), `${fixture.id}:split`);
    const merge = alignSegments(oldSegments, scenarios.merge);
    assert.ok(!merge[1].id && merge[1].status === "ambiguous", `${fixture.id}:merge`);
  }
  assert.equal(scenarioCount, 24 * 7);
});

test("unchanged segment IDs are reused 100 percent and duplicate ambiguity is not guessed", () => {
  const oldSegments = seedSegments(["same repeated text", "same repeated text", "unique stable text"]);
  const aligned = alignSegments(oldSegments, ["same repeated text", "unique stable text"]);
  assert.equal(aligned[0].id, undefined);
  assert.equal(aligned[0].status, "ambiguous");
  assert.equal(aligned[1].id, oldSegments[2].id);
});
