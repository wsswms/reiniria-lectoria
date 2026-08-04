import assert from "node:assert/strict";
import test from "node:test";
import {
  POST_TRANSLATION_QA_AUTHORIZED_CONCURRENCY, POST_TRANSLATION_QA_MAX_CONCURRENCY, POST_TRANSLATION_QA_SYSTEM_PROMPT,
  buildPostTranslationQaBody, buildPostTranslationQaFixture, normalizePostTranslationQaPayload, scorePostTranslationQa,
} from "../../src/m5e/post-translation-qa.mjs";

const documents = [6, 10].map((count, documentIndex) => ({ segments: Array.from({ length: count }, (_, index) => {
  const global = documentIndex ? index + 6 : index; return { segmentId: `segment-${global}`, ja: `本文${global}「専門語${global}」` };
}) }));
const corpus = { documents };
const proposal = { status: "pending-user-confirmation", proposedFamilies: [
  ...Array.from({ length: 16 }, (_, index) => ({ familyId: `family-${index}`, kind: "term", impact: "critical",
    segmentIds: [`segment-${index}`], description: `「専門語${index}」の訳` })),
  ...Array.from({ length: 3 }, (_, index) => ({ familyId: `family-extra-${index}`, kind: "entity", impact: "critical",
    segmentIds: [`segment-${index}`], description: `「専門語${index}」の名称` })),
] };
const packets = [[0, 1], [2, 3, 4, 5], [6, 7], [8, 9, 10, 11], [12, 13, 14, 15]];
const blindReview = { outputs: packets.map((indexes, packet) => ({ arm: "control", taskId: `control-${packet}`,
  segments: indexes.map((index) => ({ segmentId: `segment-${index}`, draft: `译文${index}`, uncertainWords: index < 4 ? [`専門語${index}`] : [] })) })) };

test("post-translation QA freezes eight identical full-excerpt direct HTTP tasks within authorization", () => {
  const fixture = buildPostTranslationQaFixture(corpus, proposal, blindReview);
  assert.equal(fixture.segments.length, 16); assert.equal(fixture.tasks.length, 8);
  assert.equal(POST_TRANSLATION_QA_MAX_CONCURRENCY, 8); assert.equal(POST_TRANSLATION_QA_AUTHORIZED_CONCURRENCY, 30);
  assert.equal(new Set(fixture.tasks.map((task) => JSON.stringify(task.segments))).size, 1);
});

test("QA prompt returns only exact source words and no reasons or suggested translations", () => {
  const task = buildPostTranslationQaFixture(corpus, proposal, blindReview).tasks[0]; const body = buildPostTranslationQaBody(task);
  assert.deepEqual(body.thinking, { type: "enabled" }); assert.equal(body.temperature, undefined);
  assert.match(POST_TRANSLATION_QA_SYSTEM_PROMPT, /Do not output reasons, questions, suggested translations/);
  const payload = { findings: [{ ref: "s001", uncertainWords: ["専門語0"] }] };
  assert.equal(normalizePostTranslationQaPayload(payload, task).findings[0].segmentId, "segment-0");
  assert.throws(() => normalizePostTranslationQaPayload({ findings: [{ ref: "s001", uncertainWords: ["不存在"] }] }, task), /exact source substring/);
});

test("QA score reports per-run and translation-plus-QA union recall", () => {
  const fixture = buildPostTranslationQaFixture(corpus, proposal, blindReview);
  const results = fixture.tasks.slice(0, 2).map((task, run) => normalizePostTranslationQaPayload({ findings: task.segments
    .filter((_segment, index) => index >= 4 + run * 6 && index < 10 + run * 6)
    .map((segment) => ({ ref: segment.ref, uncertainWords: [segment.sourceText.match(/専門語\d+/u)[0]] })) }, task));
  const score = scorePostTranslationQa(fixture, results);
  assert.equal(score.baselineCoveredCriticalFamilies, 7); assert.equal(score.combinedUnionCoveredCriticalFamilies, 19);
  assert.equal(score.finalMissedFamilyIds.length, 0); assert.equal(score.runs.length, 2);
});
