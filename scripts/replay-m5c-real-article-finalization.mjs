import { chmod, readFile, writeFile } from "node:fs/promises";
import { replayAuditedArticleFinalization } from "./m5c-real-article-batch.mjs";

for (const name of ["M5C_REPLAY_CHECKPOINT", "M5C_REPLAY_MANIFEST", "M5C_REPLAY_ENABLED_AUDIT", "M5C_REPLAY_OUTPUT"])
  if (!process.env[name]) throw new Error(`${name} is required`);
const checkpoint = JSON.parse(await readFile(process.env.M5C_REPLAY_CHECKPOINT, "utf8"));
const manifest = JSON.parse(await readFile(process.env.M5C_REPLAY_MANIFEST, "utf8"));
const events = (await readFile(process.env.M5C_REPLAY_ENABLED_AUDIT, "utf8")).trim().split("\n").map(JSON.parse);
const response = events.find((event) => event.event === "response");
const payload = JSON.parse(response?.response?.content ?? "null");
const result = replayAuditedArticleFinalization(checkpoint, manifest, payload);
await writeFile(process.env.M5C_REPLAY_OUTPUT, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
await chmod(process.env.M5C_REPLAY_OUTPUT, 0o600);
process.stdout.write(`${JSON.stringify({ status: result.status, articleId: result.articleId, selectedQaMode: result.selectedQaMode,
  providerCalls: result.providerCalls, artifactDigest: result.productFinalization.artifactDigest,
  evaluationReportDigest: result.evaluationReport.reportDigest })}\n`);
