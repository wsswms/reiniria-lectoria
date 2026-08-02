import { loadRealArticlePilotConfig, preflightRealArticlePilot } from "../src/pilot/preflight.mjs";

try {
  if (process.argv.length !== 3) throw new Error("invalid invocation");
  const config = await loadRealArticlePilotConfig(process.argv[2]);
  const { plan } = await preflightRealArticlePilot(config);
  process.stdout.write(`${JSON.stringify(plan)}\n`);
} catch {
  process.stderr.write("real article pilot preflight failed\n");
  process.exitCode = 1;
}
