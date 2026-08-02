import { createHash } from "node:crypto";
import { open, rename } from "node:fs/promises";
import { join } from "node:path";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const exact = (input, keys, name) => {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key))) throw new TypeError(`${name} is invalid`);
};

async function privateAtomicJson(directory, name, value) {
  const finalPath = join(directory, name);
  const temporaryPath = `${finalPath}.tmp-${process.pid}`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporaryPath, finalPath);
  return finalPath;
}

function translationResult(input, expectedSegments) {
  exact(input, ["segments", "usage", "validation"], "translation result");
  if (!Array.isArray(input.segments) || input.segments.length !== expectedSegments || input.segments.some((item) =>
    !item || typeof item.segmentId !== "string" || typeof item.sourceText !== "string" || typeof item.targetText !== "string" || item.targetText.trim().length === 0)) {
    throw new Error("translation result does not cover every segment");
  }
  if (!input.validation || input.validation.errors !== 0) throw new Error("translation draft failed deterministic validation");
  return input;
}

function researchResult(input) {
  exact(input, ["questions", "claims", "proposals", "usage"], "research result");
  if (!Array.isArray(input.questions) || !Array.isArray(input.claims) || !Array.isArray(input.proposals)) throw new TypeError("research result is invalid");
  for (const proposal of input.proposals) {
    if (proposal.state !== "draft" || proposal.decision !== null || proposal.appliedAt !== null) throw new Error("research proposal escaped the draft-only boundary");
  }
  return input;
}

export async function runRealArticlePilotCore({ config, articleText, translate, investigate, now = () => new Date() }) {
  if (typeof translate !== "function" || typeof investigate !== "function") throw new TypeError("pilot operations are required");
  const sourceParagraphs = articleText.split(/\n\s*\n/u).map((item) => item.trim()).filter(Boolean);
  const translated = translationResult(await translate(Object.freeze({ sourceParagraphs: Object.freeze(sourceParagraphs),
    sourceLanguage: config.article.sourceLanguage, targetLanguage: config.article.targetLanguage })), sourceParagraphs.length);
  const researched = researchResult(await investigate(Object.freeze({ questions: config.research.questions,
    allowedDomains: config.research.allowedDomains, translation: translated.segments })));
  const artifact = Object.freeze({ schemaVersion: "lectoria-real-article-pilot-artifact-v1", createdAt: now().toISOString(),
    source: Object.freeze({ digest: config.article.digest, language: config.article.sourceLanguage }), targetLanguage: config.article.targetLanguage,
    translation: Object.freeze({ state: "draft", humanReviewed: false, approved: false, segments: translated.segments,
      validation: translated.validation, usage: translated.usage }), research: Object.freeze({ state: "draft", report: researched }) });
  const artifactPath = await privateAtomicJson(config.output.directory, "real-article-pilot-artifact.json", artifact);
  const summary = Object.freeze({ schemaVersion: "lectoria-real-article-pilot-summary-v1", status: "completed-draft",
    articleDigest: config.article.digest, artifactDigest: sha(JSON.stringify(artifact)), artifactPath, segments: sourceParagraphs.length,
    translationCalls: translated.usage.calls, researchCalls: researched.usage.modelCalls, braveCalls: researched.usage.searchCalls,
    fetchedUrls: researched.usage.contentUrls, proposalDrafts: researched.proposals.length, humanReviewed: false, approved: false, proposalsApplied: 0 });
  await privateAtomicJson(config.output.directory, "real-article-pilot-summary.json", summary);
  return summary;
}
