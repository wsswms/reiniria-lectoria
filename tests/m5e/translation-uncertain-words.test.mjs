import assert from "node:assert/strict";
import test from "node:test";
import {
  TRANSLATION_UNCERTAIN_WORDS_MAX_COST_MICROS_CNY,
  TRANSLATION_UNCERTAIN_WORDS_MAX_TASKS,
  TRANSLATION_UNCERTAIN_WORDS_SYSTEM_PROMPT,
  buildTranslationUncertainWordsBody,
  buildTranslationUncertainWordsFixture,
  normalizeTranslationUncertainWordsPayload,
  scoreTranslationUncertainWords,
} from "../../src/m5e/translation-uncertain-words.mjs";

const corpus = { documents: [{ segments: Array.from({ length: 16 }, (_, index) => ({ segmentId: `segment-${index}`, ja: `文${index}「専門語${index}」` })) }] };
const proposal = { status: "pending-user-confirmation", proposedFamilies: [
  ...Array.from({ length: 16 }, (_, index) => ({ familyId: `family-${index}`, kind: "term", impact: "critical",
    segmentIds: [`segment-${index}`], description: `「専門語${index}」の訳` })),
  ...Array.from({ length: 3 }, (_, index) => ({ familyId: `family-extra-${index}`, kind: "entity", impact: "critical",
    segmentIds: [`segment-${index}`], description: `「専門語${index}」の名称` })),
] };

test("translation uncertainty fixture freezes 16 critical-rich segments into eight direct HTTP tasks", () => {
  const fixture = buildTranslationUncertainWordsFixture(corpus, proposal);
  assert.equal(fixture.segments.length, 16); assert.equal(fixture.families.length, 19);
  assert.equal(fixture.tasks.length, TRANSLATION_UNCERTAIN_WORDS_MAX_TASKS); assert.equal(TRANSLATION_UNCERTAIN_WORDS_MAX_COST_MICROS_CNY, 3_000_000);
  assert.deepEqual(fixture.tasks.map((item) => item.thinking), ["disabled", "disabled", "disabled", "disabled", "enabled", "enabled", "enabled", "enabled"]);
  assert.equal(fixture.tasks.every((item) => item.segments.length === 4), true);
});

test("translation uncertainty prompt requests only drafts and exact source words without temperature", () => {
  const task = buildTranslationUncertainWordsFixture(corpus, proposal).tasks[0]; const body = buildTranslationUncertainWordsBody(task);
  assert.equal(body.temperature, undefined); assert.equal(body.thinking.type, "disabled"); assert.equal(body.model, "deepseek-v4-pro");
  assert.match(TRANSLATION_UNCERTAIN_WORDS_SYSTEM_PROMPT, /Do not output reasons, questions, suggested translations/);
  assert.deepEqual(Object.keys(JSON.parse(body.messages[1].content).segments[0]), ["ref", "sourceText"]);
});

test("translation uncertainty output requires complete drafts and exact bounded source substrings", () => {
  const task = buildTranslationUncertainWordsFixture(corpus, proposal).tasks[0];
  const payload = { segments: task.segments.map((segment, index) => ({ ref: segment.ref, draft: `译文${index}`, uncertainWords: [segment.sourceText.match(/専門語\d+/u)[0]] })) };
  const result = normalizeTranslationUncertainWordsPayload(payload, task); assert.equal(result.segments.length, 4);
  assert.throws(() => normalizeTranslationUncertainWordsPayload({ segments: payload.segments.map((item, index) => index ? item : { ...item, uncertainWords: ["改写词"] }) }, task), /exact source substring/);
  assert.throws(() => normalizeTranslationUncertainWordsPayload({ segments: payload.segments.map((item, index) => index ? item : { ...item, draft: "" }) }, task), /segment is invalid/);
  assert.throws(() => normalizeTranslationUncertainWordsPayload({ segments: [...payload.segments].reverse() }, task), /segment is invalid/);
});

test("translation uncertainty score reports each thinking arm and their exact occurrence overlap", () => {
  const fixture = buildTranslationUncertainWordsFixture(corpus, proposal); const results = fixture.tasks.map((task) => normalizeTranslationUncertainWordsPayload({
    segments: task.segments.map((segment) => ({ ref: segment.ref, draft: "译文", uncertainWords: [segment.sourceText.match(/専門語\d+/u)[0]] })),
  }, task));
  const score = scoreTranslationUncertainWords(fixture, results);
  assert.equal(score.arms.disabled.coveredCriticalFamilies, 19); assert.equal(score.arms.enabled.coveredCriticalFamilies, 19);
  assert.equal(score.crossModeJaccard, 1);
});
