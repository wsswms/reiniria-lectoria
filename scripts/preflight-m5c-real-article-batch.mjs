import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { workspace as applicationWorkspace } from "../tests/m3-4/helpers.mjs";
import { REAL_ARTICLES, batchLimits, readPrivateArticle } from "./m5c-real-article-batch.mjs";

if (process.env.M5C_REAL_ARTICLE_BATCH !== "preflight") throw new Error("real article batch preflight requires M5C_REAL_ARTICLE_BATCH=preflight");

let credential;
const documents = [];
try {
  credential = await openCredentialFile(process.env.DEEPSEEK_KEY_FILE);
  for (const article of REAL_ARTICLES) {
    const source = await readPrivateArticle(process.env[article.env]);
    const fixture = await applicationWorkspace(`lectoria-${article.id}-preflight-`);
    try {
      const imported = await fixture.imports.import({ format: "text", content: source.content, title: article.id });
      const segmentCount = fixture.database.prepare("SELECT count(*) AS count FROM source_segment_versions WHERE workspace_id = ? AND source_revision_id = ? AND translatable = 1")
        .get(fixture.workspaceId, imported.sourceRevisionId).count;
      documents.push(Object.freeze({ id: article.id, sourceLanguage: article.sourceLanguage, targetLanguage: article.targetLanguage,
        domain: article.domain, bytes: source.bytes, digest: source.digest, segmentCount }));
    } finally { await fixture.close(); }
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: "m5c-real-article-batch-preflight-v1", status: "ready",
    dataClass: "user-provided-public-articles", model: "deepseek-v4-flash", documents, maximums: batchLimits(documents),
    thinkingModes: ["disabled", "enabled"], sameTargetRevisionRequired: true, rawResponsesRetained: false,
    reasoningRetained: false, credentialInjection: "current-user-0600-file-to-fd-brokers" })}\n`);
} finally { await credential?.close(); }
