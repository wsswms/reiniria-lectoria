import { open, rename } from "node:fs/promises";
import { join } from "node:path";
import { loadRealArticlePilotConfig, preflightRealArticlePilot } from "../src/pilot/preflight.mjs";
import { createLivePilotOperations } from "../src/pilot/live-operations.mjs";

async function atomicPrivate(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}

let operations;
try {
  if (process.argv.length !== 3) throw new Error("invalid invocation");
  const config = await loadRealArticlePilotConfig(process.argv[2], { allowLive: true });
  if (config.mode !== "live") throw new Error("live mode is required");
  const preflight = await preflightRealArticlePilot(config, { allowLive: true });
  operations = await createLivePilotOperations(config, { runnerIdentity: { uid: process.getuid(), gid: process.getgid() } });
  const sourceParagraphs = preflight.articleText.split(/\n\s*\n/u).map((item) => item.trim()).filter(Boolean);
  const result = await operations.translate({ sourceParagraphs, targetLanguage: config.article.targetLanguage });
  const artifactPath = join(config.output.directory, "real-article-translation-draft.json");
  await atomicPrivate(artifactPath, { schemaVersion: "lectoria-real-article-translation-draft-v1", state: "draft",
    humanReviewed: false, approved: false, articleDigest: config.article.digest, sourceLanguage: config.article.sourceLanguage,
    targetLanguage: config.article.targetLanguage, segments: result.segments, validation: result.validation, usage: result.usage });
  process.stdout.write(`${JSON.stringify({ status: "completed-draft", artifactPath, segments: result.segments.length,
    validation: result.validation, usage: result.usage, humanReviewed: false, approved: false })}\n`);
} catch (error) {
  const allowed = new Set(["auth", "budget", "canceled", "malformed-response", "policy", "provider", "rate-limit", "timeout", "unknown-outcome", "validation"]);
  process.stderr.write(`${JSON.stringify({ status: "failed", category: allowed.has(error?.category) ? error.category : "translation" })}\n`);
  process.exitCode = 1;
} finally { await operations?.close(); }
