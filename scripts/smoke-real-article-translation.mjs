import { loadRealArticlePilotConfig, preflightRealArticlePilot } from "../src/pilot/preflight.mjs";
import { createLivePilotOperations } from "../src/pilot/live-operations.mjs";

let operations;
try {
  if (process.argv.length !== 3) throw new Error("invalid invocation");
  const config = await loadRealArticlePilotConfig(process.argv[2], { allowLive: true });
  if (config.mode !== "live" || config.deepseek.translation.maxCalls !== 1 || config.brave.maxCalls !== 1) throw new Error("smoke limits are invalid");
  const preflight = await preflightRealArticlePilot(config, { allowLive: true });
  if (preflight.plan.segments !== 1) throw new Error("smoke article must have one segment");
  operations = await createLivePilotOperations(config, { runnerIdentity: { uid: process.getuid(), gid: process.getgid() } });
  const result = await operations.translate({ sourceParagraphs: [preflight.articleText.trim()], targetLanguage: config.article.targetLanguage });
  process.stdout.write(`${JSON.stringify({ status: "completed-draft", calls: result.usage.calls, segments: result.segments.length,
    validation: result.validation, usage: result.usage })}\n`);
} catch (error) {
  const allowed = new Set(["auth", "budget", "canceled", "malformed-response", "policy", "provider", "rate-limit", "timeout", "unknown-outcome", "validation"]);
  process.stderr.write(`${JSON.stringify({ status: "failed", category: allowed.has(error?.category) ? error.category : "smoke" })}\n`);
  process.exitCode = 1;
} finally { await operations?.close(); }
