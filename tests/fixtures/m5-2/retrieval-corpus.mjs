import { createHash } from "node:crypto";
import { stableJson } from "../../../src/domain/contracts.mjs";

const languages = ["en", "zh-CN", "ja"];
const uuid = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const labels = {
  en: { exact: "Atlas", short: "A", topic: "atomic workspace backup", term: "workspace backup", typo: "workspce backup", synonym: "safe copy", style: "Direct prose" },
  "zh-CN": { exact: "星图", short: "术", topic: "原子工作区备份", term: "工作区备份", typo: "工作区备分", synonym: "安全副本", style: "直接表述" },
  ja: { exact: "星図", short: "語", topic: "アトミックワークスペースバックアップ", term: "ワークスペースバックアップ", typo: "ワークスペースバックアプ", synonym: "安全コピー", style: "直接表現" },
};

let sequence = 1;
const facts = [];
const identities = new Map();

for (const language of languages) {
  const text = labels[language];
  for (let index = 0; index < 14; index += 1) {
    const factId = uuid(sequence++); const revisionId = uuid(sequence++);
    identities.set(`${language}:knowledge:${index}`, factId);
    facts.push({
      schemaVersion: "1.0", factId, revisionId, kind: "knowledge", language,
      scope: { targetLanguages: [language], tags: ["retrieval", `topic-${index}`] },
      content: {
        title: `${text.topic} ${index}`,
        body: `${text.topic} ${index}. ${text.term} ${index}. Verified public synthetic retrieval fixture.`,
        tags: ["quality", `topic-${index}`], source: "public-synthetic-m5-2",
      },
    });
  }
  for (let index = 0; index < 42; index += 1) {
    const group = index % 14;
    const variant = Math.floor(index / 14);
    const factId = uuid(sequence++); const revisionId = uuid(sequence++);
    identities.set(`${language}:term:${variant}:${group}`, factId);
    const term = variant === 0 ? `${text.exact}-X${group}` : variant === 1 ? `${text.short}${group}` : `${text.term} ${group}`;
    facts.push({
      schemaVersion: "1.0", factId, revisionId, kind: "term", language,
      scope: { targetLanguages: [language], tags: ["retrieval", `term-${group}`] },
      content: {
        term, preferredTranslations: [{ language, text: term }], forbiddenTranslations: [],
        variants: variant === 2 ? [`${text.typo} ${group}`, `${text.synonym} ${group}`] : [],
        note: `Fixed exact term ${group}.`,
      },
    });
  }
  for (let index = 0; index < 44; index += 1) {
    const factId = uuid(sequence++); const revisionId = uuid(sequence++);
    identities.set(`${language}:style:${index}`, factId);
    facts.push({
      schemaVersion: "1.0", factId, revisionId, kind: "style", language,
      scope: { targetLanguages: [language], tags: ["retrieval", `style-${index}`] },
      content: {
        title: `${text.style} ${index}`, description: `${text.topic} ${index} is a deliberately confusable style record.`,
        severity: "warning", forbiddenPatterns: [`indirect-${index}`], requiredPatterns: [],
      },
    });
  }
}

const queries = [];
for (const language of languages) {
  const text = labels[language];
  for (let index = 0; index < 6; index += 1) {
    const common = { language, tags: ["retrieval"], documentIds: [], topK: 10 };
    queries.push({ id: `${language}-exact-${index}`, category: "exact", query: `${text.exact}-X${index}`, kinds: ["term"], relevant: [identities.get(`${language}:term:0:${index}`)], forbidden: [identities.get(`${language}:style:${index}`)], reason: "exact model-like term", ...common });
    queries.push({ id: `${language}-short-${index}`, category: "short", query: `${text.short}${index}`, kinds: ["term"], relevant: [identities.get(`${language}:term:1:${index}`)], forbidden: [identities.get(`${language}:style:${index}`)], reason: "known item shorter than three Unicode characters", ...common });
    queries.push({ id: `${language}-topic-${index}`, category: "topic", query: `${text.topic} ${index}`, kinds: ["knowledge"], relevant: [identities.get(`${language}:knowledge:${index}`)], forbidden: [identities.get(`${language}:style:${index}`)], reason: "annotated topic query", ...common });
    queries.push({ id: `${language}-typo-${index}`, category: "typo", query: `${text.typo} ${index}`, kinds: ["term"], relevant: [identities.get(`${language}:term:2:${index}`)], forbidden: [identities.get(`${language}:style:${index}`)], reason: "curated common typo variant", ...common });
    queries.push({ id: `${language}-synonym-${index}`, category: "synonym", query: `${text.synonym} ${index}`, kinds: ["term"], relevant: [identities.get(`${language}:term:2:${index}`)], forbidden: [identities.get(`${language}:style:${index}`)], reason: "curated synonym variant", ...common });
    queries.push({ id: `${language}-proper-${index}`, category: "proper", query: `${text.exact}-X${index + 6}`, kinds: ["term"], relevant: [identities.get(`${language}:term:0:${index + 6}`)], forbidden: [identities.get(`${language}:style:${index + 6}`)], reason: "proper name exact lookup", ...common });
    queries.push({ id: `${language}-none-${index}`, category: "no-result", query: `ZXQ-${language}-${index}-absent-token`, kinds: ["term", "knowledge"], relevant: [], forbidden: [], reason: "explicit no-result control", ...common });
  }
}

export const retrievalFacts = Object.freeze(facts.map(Object.freeze));
export const retrievalQueries = Object.freeze(queries.map(Object.freeze));
export const retrievalManifest = Object.freeze({
  format: "m5-2-retrieval-corpus-v1",
  factCount: retrievalFacts.length,
  queryCount: retrievalQueries.length,
  languages: Object.freeze(Object.fromEntries(languages.map((language) => [language, {
    facts: retrievalFacts.filter((fact) => fact.language === language).length,
    queries: retrievalQueries.filter((query) => query.language === language).length,
  }]))),
  categories: Object.freeze(Object.fromEntries([...new Set(retrievalQueries.map((query) => query.category))].sort().map((category) => [category, retrievalQueries.filter((query) => query.category === category).length]))),
});
export const retrievalDigest = `sha256:${createHash("sha256").update(stableJson({ facts: retrievalFacts, queries: retrievalQueries, manifest: retrievalManifest })).digest("hex")}`;
