import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTICLE_SUMMARY_SYSTEM_PROMPT,
  ABSTRACT_SOURCE_ARTICLE_SUMMARY_SYSTEM_PROMPT,
  ARTICLE_SUMMARY_UNCERTAINTY_MAX_COST_MICROS_CNY,
  ARTICLE_SUMMARY_UNCERTAINTY_MAX_TASKS,
  SOURCE_LANGUAGE_ARTICLE_SUMMARY_SYSTEM_PROMPT,
  SOURCE_ONLY_ARTICLE_SUMMARY_SYSTEM_PROMPT,
  buildArticleSummaryBody,
  buildArticleSummaryTranslationBody,
  buildArticleSummaryUncertaintyFixture,
  normalizeArticleSummaryPayload,
  normalizeArticleSummaryTranslationPayload,
  scoreArticleSummaryUncertainty,
} from "../../src/m5e/article-summary-uncertainty.mjs";

const documents = [6, 10].map((count, documentIndex) => ({ segments: Array.from({ length: count }, (_, index) => {
  const global = documentIndex === 0 ? index : index + 6;
  return { segmentId: `segment-${global}`, ja: `本文${global}「専門語${global}」` };
}) }));
const corpus = { documents };
const proposal = { status: "pending-user-confirmation", proposedFamilies: [
  ...Array.from({ length: 16 }, (_, index) => ({ familyId: `family-${index}`, kind: "term", impact: "critical",
    segmentIds: [`segment-${index}`], description: `「専門語${index}」の訳` })),
  ...Array.from({ length: 3 }, (_, index) => ({ familyId: `family-extra-${index}`, kind: "entity", impact: "critical",
    segmentIds: [`segment-${index}`], description: `「専門語${index}」の名称` })),
] };

test("article summary experiment freezes two summaries and five paired article-bounded packets", () => {
  const fixture = buildArticleSummaryUncertaintyFixture(corpus, proposal);
  assert.equal(fixture.tasks.length, ARTICLE_SUMMARY_UNCERTAINTY_MAX_TASKS); assert.equal(fixture.summaryTasks.length, 2);
  assert.equal(fixture.translationTasks.length, 10); assert.equal(ARTICLE_SUMMARY_UNCERTAINTY_MAX_COST_MICROS_CNY, 2_000_000);
  assert.deepEqual(fixture.packets.map((item) => item.segments.length), [2, 4, 2, 4, 4]);
  assert.equal(fixture.packets.every((packet) => packet.segments.every((segment) =>
    documents[packet.articleIndex].segments.some((item) => item.segmentId === segment.segmentId))), true);
  assert.deepEqual(fixture.translationTasks.map((item) => item.arm), [...Array(5).fill("control"), ...Array(5).fill("summary")]);
});

test("summary prompt excludes terminology and translation advice and normalizer bounds length", () => {
  const task = buildArticleSummaryUncertaintyFixture(corpus, proposal).summaryTasks[0]; const body = buildArticleSummaryBody(task);
  assert.deepEqual(body.thinking, { type: "disabled" }); assert.equal(body.temperature, undefined);
  assert.match(ARTICLE_SUMMARY_SYSTEM_PROMPT, /Do not list uncertain terms/); assert.match(ARTICLE_SUMMARY_SYSTEM_PROMPT, /Japanese-to-Chinese term pairs/);
  const valid = "这是一篇围绕摄影器材历史与光学设计展开的文章，作者结合产品开发背景和实际拍摄用途，回顾若干特殊镜头的构思过程、功能定位与设计取舍。内容涉及镜头结构、成像表现、市场语境以及命名趣闻，并通过叙述研发中的限制和尝试，说明不同方案如何回应具体摄影需求以及当时的产品环境。";
  assert.equal(normalizeArticleSummaryPayload({ articleSummary: valid }, task).articleSummary, valid);
  assert.throws(() => normalizeArticleSummaryPayload({ articleSummary: "过短" }, task), /length/);
  assert.throws(() => normalizeArticleSummaryPayload({ articleSummary: valid, terms: [] }, task), /payload/);
});

test("source-language summary stays Japanese and forbids translation, definition and romanization", () => {
  const task = buildArticleSummaryUncertaintyFixture(corpus, proposal).summaryTasks[0];
  const body = buildArticleSummaryBody(task, "source-language-v2");
  assert.equal(body.messages[0].content, SOURCE_LANGUAGE_ARTICLE_SUMMARY_SYSTEM_PROMPT);
  assert.match(body.messages[0].content, /日本語だけ/); assert.match(body.messages[0].content, /翻訳しない/);
  assert.match(body.messages[0].content, /定義、解説、言い換え、正規化、ローマ字化、対訳化しない/);
  const valid = "本記事は、写真用交換レンズの企画と開発を題材に、限られた条件のもとで進められた光学設計、試作、商品化の経緯と、開発担当者による作例評価を振り返る。";
  const normalized = normalizeArticleSummaryPayload({ articleSummary: valid }, task, "source-language-v2");
  assert.equal(normalized.promptVariant, "source-language-v2");
  assert.throws(() => normalizeArticleSummaryPayload({ articleSummary: "短すぎる" }, task, "source-language-v2"), /length/);
});

test("abstract source summary excludes product names, specifications and concrete terminology", () => {
  const task = buildArticleSummaryUncertaintyFixture(corpus, proposal).summaryTasks[0];
  const body = buildArticleSummaryBody(task, "abstract-source-v3");
  assert.equal(body.messages[0].content, ABSTRACT_SOURCE_ARTICLE_SUMMARY_SYSTEM_PROMPT);
  assert.match(body.messages[0].content, /製品名、固有名詞、引用符付き表現、型番、数値、仕様、具体的な光学形式、個別の専門用語を一切書かない/);
  const valid = "過去の写真器材開発を題材に、企画から光学設計、試作、商品化へ至る経緯と、作例を用いた評価を開発担当者の回想に沿って紹介する記事。";
  assert.equal(normalizeArticleSummaryPayload({ articleSummary: valid }, task, "abstract-source-v3").promptVariant, "abstract-source-v3");
});

test("source-only summary permits Japanese domain context but forbids target-language answers", () => {
  const task = buildArticleSummaryUncertaintyFixture(corpus, proposal).summaryTasks[0];
  const body = buildArticleSummaryBody(task, "source-only-v4");
  assert.equal(body.messages[0].content, SOURCE_ONLY_ARTICLE_SUMMARY_SYSTEM_PROMPT);
  assert.match(body.messages[0].content, /中国語その他の言語への翻訳、日中対訳、訳語候補、翻訳助言、用語集を絶対に書かない/);
  const valid = "1990年代の写真用交換レンズ開発を題材に、低価格な限定製品の企画、光学設計、試作、商品化の経緯と、作例による描写評価を開発担当者の回想に沿って紹介する記事。";
  assert.equal(normalizeArticleSummaryPayload({ articleSummary: valid }, task, "source-only-v4").promptVariant, "source-only-v4");
});

test("paired translation bodies differ only by explicit non-authoritative article context", () => {
  const fixture = buildArticleSummaryUncertaintyFixture(corpus, proposal); const control = fixture.translationTasks[0]; const enhanced = fixture.translationTasks[5];
  const summary = { articleRef: enhanced.articleRef, articleSummary: "领域摘要" };
  const controlBody = buildArticleSummaryTranslationBody(control); const enhancedBody = buildArticleSummaryTranslationBody(enhanced, summary);
  assert.deepEqual(controlBody.thinking, { type: "enabled" }); assert.equal(controlBody.temperature, undefined);
  const controlUser = JSON.parse(controlBody.messages[1].content); const enhancedUser = JSON.parse(enhancedBody.messages[1].content);
  assert.equal(controlUser.articleContext, undefined); assert.equal(enhancedUser.articleContext.articleSummary, "领域摘要");
  assert.match(enhancedUser.articleContext.instruction, /may omit details or be wrong/);
});

test("paired score reports added and lost critical families and exact occurrence overlap", () => {
  const fixture = buildArticleSummaryUncertaintyFixture(corpus, proposal);
  const results = fixture.translationTasks.map((task) => normalizeArticleSummaryTranslationPayload({ segments: task.segments.map((segment, index) => ({
    ref: segment.ref, draft: `译文${index}`, uncertainWords: task.arm === "summary" || Number(segment.segmentId.split("-")[1]) < 8
      ? [segment.sourceText.match(/専門語\d+/u)[0]] : [],
  })) }, task));
  const score = scoreArticleSummaryUncertainty(fixture, results);
  assert.equal(score.arms.control.coveredCriticalFamilies, 11); assert.equal(score.arms.summary.coveredCriticalFamilies, 19);
  assert.equal(score.deltaCriticalFamilies, 8); assert.equal(score.newlyCoveredFamilyIds.length, 8); assert.equal(score.lostFamilyIds.length, 0);
  assert.equal(score.repeatConfirmationSuggested, true);
});
