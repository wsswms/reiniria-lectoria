import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspaceDatabase } from "../src/db/connection.mjs";
import { KnowledgeFactService } from "../src/knowledge/fact-service.mjs";
import { FtsRetriever } from "../src/knowledge/fts-retriever.mjs";
import { detectorV3ApprovedTermFromFact } from "../src/m5e/detector-v3.mjs";

const CORPUS_DIGEST = "sha256:3defc2a47e53e946e950211232c3250dcc173619f32c44d9c46ebe163e0667da";
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";
const DOCUMENTS = Object.freeze([
  Object.freeze({ articleId: "nikon-omoshiro-part1", field: "ja", language: "ja", targetLanguage: "zh-CN",
    documentId: "20000000-0000-4000-8000-000000000002", title: "ニコン初のトイレンズ？ ニコンおもしろレンズ工房 Part1" }),
  Object.freeze({ articleId: "nikon-omoshiro-part1", field: "zh", language: "zh-CN", targetLanguage: "ja",
    documentId: "20000000-0000-4000-8000-000000000003", title: "尼康首款玩具镜头？尼康趣味镜头工房 Part1" }),
  Object.freeze({ articleId: "nikon-omoshiro-part2", field: "ja", language: "ja", targetLanguage: "zh-CN",
    documentId: "20000000-0000-4000-8000-000000000004", title: "ニコン初のトイレンズ？ ニコンおもしろレンズ工房 Part2" }),
  Object.freeze({ articleId: "nikon-omoshiro-part2", field: "zh", language: "zh-CN", targetLanguage: "ja",
    documentId: "20000000-0000-4000-8000-000000000005", title: "尼康首款玩具镜头？尼康趣味镜头工房 Part2" }),
]);
const TERMS = Object.freeze([
  Object.freeze({ factId: "21000000-0000-4000-8000-000000000001", revisionId: "22000000-0000-4000-8000-000000000001",
    language: "ja", targetLanguage: "zh-CN", term: "ニコンおもしろレンズ工房", translation: "尼康趣味镜头工房" }),
  Object.freeze({ factId: "21000000-0000-4000-8000-000000000002", revisionId: "22000000-0000-4000-8000-000000000002",
    language: "ja", targetLanguage: "zh-CN", term: "倍率色収差", translation: "倍率色差" }),
  Object.freeze({ factId: "21000000-0000-4000-8000-000000000003", revisionId: "22000000-0000-4000-8000-000000000003",
    language: "ja", targetLanguage: "zh-CN", term: "非点収差", translation: "像散" }),
  Object.freeze({ factId: "21000000-0000-4000-8000-000000000004", revisionId: "22000000-0000-4000-8000-000000000004",
    language: "ja", targetLanguage: "zh-CN", term: "球面収差", translation: "球面像差" }),
  Object.freeze({ factId: "21000000-0000-4000-8000-000000000005", revisionId: "22000000-0000-4000-8000-000000000005",
    language: "zh-CN", targetLanguage: "ja", term: "尼康趣味镜头工房", translation: "ニコンおもしろレンズ工房" }),
  Object.freeze({ factId: "21000000-0000-4000-8000-000000000006", revisionId: "22000000-0000-4000-8000-000000000006",
    language: "zh-CN", targetLanguage: "ja", term: "倍率色差", translation: "倍率色収差" }),
  Object.freeze({ factId: "21000000-0000-4000-8000-000000000007", revisionId: "22000000-0000-4000-8000-000000000007",
    language: "zh-CN", targetLanguage: "ja", term: "像散", translation: "非点収差" }),
  Object.freeze({ factId: "21000000-0000-4000-8000-000000000008", revisionId: "22000000-0000-4000-8000-000000000008",
    language: "zh-CN", targetLanguage: "ja", term: "球面像差", translation: "球面収差" }),
]);

async function privateCorpus(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > 16 * 1024 * 1024) {
    throw new Error("Detector v3 corpus is invalid");
  }
  const bytes = await readFile(path); if (sha(bytes) !== CORPUS_DIGEST) throw new Error("Detector v3 corpus digest mismatch");
  const corpus = JSON.parse(bytes.toString("utf8"));
  if (corpus?.schemaVersion !== "m5e-tokenizer-corpus-v1" || corpus.documents?.length !== 2) throw new Error("Detector v3 corpus schema mismatch");
  return corpus;
}

function documents(corpus) {
  return Object.freeze(DOCUMENTS.map((definition) => {
    const article = corpus.documents.find((item) => item.articleId === definition.articleId); if (!article) throw new Error("Detector v3 article is missing");
    return Object.freeze({ schemaVersion: "m5e-detector-document-v1", documentId: definition.documentId,
      language: definition.language, targetLanguage: definition.targetLanguage, title: definition.title,
      segments: Object.freeze(article.segments.map((segment) => Object.freeze({ segmentId: segment.segmentId,
        sourceText: segment[definition.field], structuralRole: "paragraph" }))) });
  }));
}

export async function createDetectorV3Fixture(corpusPath) {
  const corpus = await privateCorpus(corpusPath); const root = await mkdtemp(join(tmpdir(), "lectoria-detector-v3-"));
  for (const directory of ["private/objects", "private/ledger", "derived", "staging", "dictionary", "style", "knowledge"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId: WORKSPACE_ID, now: () => new Date(0) });
  try {
    const facts = new KnowledgeFactService(root, database, WORKSPACE_ID, { now: () => new Date(0) });
    for (const item of TERMS) await facts.create({ schemaVersion: "1.0", factId: item.factId, revisionId: item.revisionId,
      kind: "term", language: item.language, scope: { targetLanguages: [], tags: ["detector-v3-synthetic"] },
      content: { term: item.term, preferredTranslations: [{ language: item.targetLanguage, text: item.translation }],
        forbiddenTranslations: [], variants: [], note: "Detector v3 synthetic approved fixture" } }, { type: "fixture", id: "m5e-detector-v3" });
    const retriever = new FtsRetriever(root, database, WORKSPACE_ID, { now: () => new Date(0) }); const manifest = await retriever.rebuild();
    const approvedTerms = Object.freeze(TERMS.map((item) => detectorV3ApprovedTermFromFact(facts.get(item.factId), manifest.retrieverVersion)));
    return Object.freeze({ documents: documents(corpus), approvedTerms, retriever, manifest,
      syntheticFactCount: TERMS.length, corpusDigest: CORPUS_DIGEST,
      async close() { database.close(); await rm(root, { recursive: true, force: true }); } });
  } catch (error) { database.close(); await rm(root, { recursive: true, force: true }); throw error; }
}
