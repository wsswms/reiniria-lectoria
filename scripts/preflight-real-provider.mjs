import { readFile, stat } from "node:fs/promises";
import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { createRealRunDryPlan, realRunConfigContract } from "../src/provider/real-run-preflight.mjs";
import { realProviderCorpus } from "../tests/fixtures/m4-5/real-provider-corpus.mjs";

const corpusUrl = new URL("../tests/fixtures/m4-5/real-provider-corpus.mjs", import.meta.url);

try {
  if (process.argv.length !== 3) throw new Error("invalid invocation");
  const configPath = process.argv[2];
  const configStat = await stat(configPath);
  if (!configStat.isFile() || configStat.size < 1 || configStat.size > 64 * 1024) throw new Error("invalid config");
  const config = realRunConfigContract(JSON.parse(await readFile(configPath, "utf8")));
  const credential = await openCredentialFile(config.credentialPath);
  await credential.close();
  const plan = createRealRunDryPlan(config, realProviderCorpus, await readFile(corpusUrl));
  process.stdout.write(`${JSON.stringify(plan)}\n`);
} catch {
  process.stderr.write("real Provider preflight failed\n");
  process.exitCode = 1;
}
