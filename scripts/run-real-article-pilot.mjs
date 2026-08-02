import { loadRealArticlePilotConfig, preflightRealArticlePilot } from "../src/pilot/preflight.mjs";
import { runRealArticlePilotCore } from "../src/pilot/real-article-pilot.mjs";
import { createLivePilotOperations } from "../src/pilot/live-operations.mjs";

let operations;
let stage = "preflight";
try {
  if (process.argv.length !== 3) throw new Error("invalid invocation");
  const config = await loadRealArticlePilotConfig(process.argv[2], { allowLive: true });
  if (config.mode !== "live") throw new Error("live mode is required");
  const preflight = await preflightRealArticlePilot(config, { allowLive: true });
  stage = "initialize";
  operations = await createLivePilotOperations(config, { runnerIdentity: { uid: process.getuid(), gid: process.getgid() } });
  const translate = async (input) => { stage = "translation"; const result = await operations.translate(input); stage = "research"; return result; };
  const investigate = async (input) => { stage = "research"; const result = await operations.investigate(input); stage = "artifact"; return result; };
  const summary = await runRealArticlePilotCore({ config, articleText: preflight.articleText,
    translate, investigate });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch (error) {
  const allowed = new Set(["auth", "budget", "canceled", "malformed-response", "policy", "provider", "rate-limit", "timeout", "unknown-outcome", "validation"]);
  process.stderr.write(`${JSON.stringify({ status: "failed", stage, category: allowed.has(error?.category) ? error.category : "pilot" })}\n`);
  process.exitCode = 1;
} finally { await operations?.close(); }
