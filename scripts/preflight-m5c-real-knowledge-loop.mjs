import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { LocalContextPlanner } from "../src/m5c/local-context-planner.mjs";
import { flowBudgetPolicyContract } from "../src/m5c/contracts.mjs";
import { workspace as applicationWorkspace } from "../tests/m3-4/helpers.mjs";
import { REAL_ARTICLES, readPrivateArticle } from "./m5c-real-article-batch.mjs";
import { KNOWLEDGE_LOOP_ARTICLES, USER_RECOVERY_MODE, knowledgeLoopArticleBudget, knowledgeLoopLimits } from "./m5c-real-knowledge-loop.mjs";
import { randomUUID } from "node:crypto";

if (process.env.M5C_REAL_KNOWLEDGE_LOOP !== "preflight") throw new Error("real knowledge loop preflight requires M5C_REAL_KNOWLEDGE_LOOP=preflight");
if (process.env.M5C_REAL_USER_RECOVERY !== USER_RECOVERY_MODE) throw new Error("real knowledge loop preflight requires explicit malformed recovery authorization");
let deepseek; let brave;
try {
  deepseek = await openCredentialFile(process.env.DEEPSEEK_KEY_FILE); brave = await openCredentialFile(process.env.BRAVE_KEY_FILE);
  const documents = [];
  for (const article of REAL_ARTICLES) {
    const source = await readPrivateArticle(process.env[article.env]); const fixture = await applicationWorkspace(`lectoria-${article.id}-knowledge-preflight-`);
    try {
      const imported = await fixture.imports.import({ format: "text", content: source.content, title: article.id });
      const segmentCount = fixture.database.prepare("SELECT count(*) AS count FROM source_segment_versions WHERE workspace_id = ? AND source_revision_id = ? AND translatable = 1")
        .get(fixture.workspaceId, imported.sourceRevisionId).count;
      const plan = new LocalContextPlanner(fixture.database, fixture.workspaceId).build({ workflowId: randomUUID(),
        sourceRevisionId: imported.sourceRevisionId, targetLanguage: article.targetLanguage }); const expected = KNOWLEDGE_LOOP_ARTICLES[article.id];
      if (!expected || segmentCount !== expected.segmentCount) throw new Error("real knowledge loop segmentation is not fixed");
      flowBudgetPolicyContract({ schemaVersion: "1.0", workflowId: randomUUID(), revision: 1, ...knowledgeLoopArticleBudget(segmentCount),
        authorizedBy: { type: "user", id: "preflight" }, createdAt: new Date().toISOString() });
      documents.push({ articleId: article.id, sourceDigest: source.digest, bytes: source.bytes, segmentCount,
        localPlanItems: plan.items.length, localHighRiskUncovered: plan.items.filter((item) => ["critical", "high"].includes(item.impact)
          && ["partially-covered", "conflicted", "stale", "uncovered"].includes(item.coverage)).length,
        researchQuery: expected.query, expectedResearchHost: expected.expectedHost });
    } finally { await fixture.close(); }
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: "m5c-real-knowledge-loop-preflight-v1", status: "ready", documents,
    limits: knowledgeLoopLimits(), providers: { translationPlannerQa: "deepseek-v4-flash", search: "brave-search" },
    finalQaModes: ["enabled"], fullLlmAudit: true, userRecoveryMode: USER_RECOVERY_MODE, automaticRetries: 0 })}\n`);
} finally { await brave?.close(); await deepseek?.close(); }
