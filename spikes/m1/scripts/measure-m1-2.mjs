import { createHash } from "node:crypto";
import { roundTrip } from "../src/m1-2/ast.mjs";
import { restoreProtected, tokenizeProtected } from "../src/m1-2/protection.mjs";
import { alignSegments, seedSegments } from "../src/m1-2/segments.mjs";
import { allFixtures } from "../tests/fixtures/m1-2/corpus.mjs";

const corpusDigest = createHash("sha256")
  .update(JSON.stringify(allFixtures))
  .digest("hex");

let structureFailures = 0;
let protectionFailures = 0;
let unchangedExpected = 0;
let unchangedReused = 0;
let changedExpected = 0;
let changedReused = 0;
let wrongReuse = 0;
let ambiguousExpected = 0;
let ambiguousMarked = 0;

for (const fixture of allFixtures) {
  const result = roundTrip(fixture.kind, fixture.content);
  if (JSON.stringify(result.before) !== JSON.stringify(result.after)) structureFailures += 1;
  const protectedResult = tokenizeProtected(fixture.content);
  if (restoreProtected(protectedResult.text, protectedResult.protectedItems) !== fixture.content) protectionFailures += 1;

  const texts = [
    `${fixture.id} introduction contains enough stable context for alignment testing.`,
    `${fixture.id} middle paragraph discusses aperture shutter speed and exposure choices.`,
    `${fixture.id} final paragraph records a deterministic conclusion for later comparison.`,
  ];
  const oldSegments = seedSegments(texts);
  const byText = new Map(oldSegments.map((segment) => [segment.text, segment.id]));
  for (const updated of [
    [texts[0], "A newly inserted paragraph has no previous identity.", texts[1], texts[2]],
    [texts[0], texts[2]],
    [texts[2], texts[0], texts[1]],
    texts.map((text) => ` ${text.replaceAll(" ", "   ")} `),
  ]) {
    const aligned = alignSegments(oldSegments, updated);
    aligned.forEach((segment) => {
      const normalized = segment.text.replace(/\s+/g, " ").trim();
      const expected = [...byText.entries()].find(([text]) => text === normalized)?.[1];
      if (!expected) return;
      unchangedExpected += 1;
      if (segment.id === expected) unchangedReused += 1;
      else if (segment.id) wrongReuse += 1;
    });
  }

  const rewrittenTexts = texts.map((text) => text.replace("deterministic", "carefully deterministic"));
  const rewritten = alignSegments(oldSegments, rewrittenTexts);
  rewritten.forEach((segment, index) => {
    changedExpected += 1;
    if (segment.id === oldSegments[index].id) changedReused += 1;
    else if (segment.id) wrongReuse += 1;
  });

  const split = alignSegments(oldSegments, [texts[0].slice(0, 36), texts[0].slice(36), texts[1], texts[2]]);
  const merge = alignSegments(oldSegments, [texts[0], `${texts[1]} ${texts[2]}`]);
  for (const segment of [...split.slice(0, 2), merge[1]]) {
    ambiguousExpected += 1;
    if (!segment.id && segment.status === "ambiguous") ambiguousMarked += 1;
    else if (segment.id) wrongReuse += 1;
  }
}

const output = {
  stage: "M1.2",
  corpus: {
    fixtures: allFixtures.length,
    markdown: allFixtures.filter((fixture) => fixture.kind === "markdown").length,
    html: allFixtures.filter((fixture) => fixture.kind === "html").length,
    sha256: corpusDigest,
    derived_update_scenarios: allFixtures.length * 7,
  },
  round_trip: {
    passed: allFixtures.length - structureFailures,
    failed: structureFailures,
  },
  protection: {
    passed: allFixtures.length - protectionFailures,
    failed: protectionFailures,
  },
  alignment: {
    unchanged_reuse_rate: unchangedReused / unchangedExpected,
    mild_rewrite_reuse_rate: changedReused / changedExpected,
    ambiguity_detection_rate: ambiguousMarked / ambiguousExpected,
    wrong_reuse: wrongReuse,
  },
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
