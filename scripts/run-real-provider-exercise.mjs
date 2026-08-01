import { readFile, stat, mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openWorkspaceDatabase } from "../src/db/connection.mjs";
import { invokeBrokerProcess } from "../src/provider/broker-process.mjs";
import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { runRealProviderExercise } from "../src/provider/real-provider-exercise.mjs";
import { realRunConfigContract } from "../src/provider/real-run-preflight.mjs";
import { realProviderCorpus } from "../tests/fixtures/m4-5/real-provider-corpus.mjs";

const corpusUrl = new URL("../tests/fixtures/m4-5/real-provider-corpus.mjs", import.meta.url);
let root;
let database;
let credential;
try {
  if (process.argv.length !== 3) throw new Error("invalid invocation");
  const configPath = process.argv[2];
  const configStat = await stat(configPath);
  if (!configStat.isFile() || configStat.size < 1 || configStat.size > 64 * 1024 || (configStat.mode & 0o077) !== 0) {
    throw new Error("invalid config");
  }
  const config = realRunConfigContract(JSON.parse(await readFile(configPath, "utf8")), { allowLive: true });
  if (config.mode !== "live") throw new Error("live mode is required");
  credential = await openCredentialFile(config.credentialPath);
  await unlink(config.credentialPath);
  root = await mkdtemp(join(tmpdir(), "lectoria-real-provider-exercise-"));
  for (const path of ["private/objects", "private/ledger", "derived", "staging"]) await mkdir(join(root, path), { recursive: true });
  const workspaceId = randomUUID();
  database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId });
  const summary = await runRealProviderExercise({
    database,
    root,
    workspaceId,
    config,
    runnerIdentity: { uid: 65532, gid: 65532 },
    corpus: realProviderCorpus,
    corpusSourceBytes: await readFile(corpusUrl),
    invokeProvider: (request, { credentialRef }) => invokeBrokerProcess({
      request,
      credentialRef,
      credentialFd: credential.fd,
    }, { timeoutMs: 60_000 }),
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch (error) {
  const allowedCategories = new Set([
    "auth", "budget", "canceled", "malformed-response", "output-limit", "policy",
    "provider", "rate-limit", "runner", "timeout", "transport", "unknown-outcome",
    "validation",
  ]);
  const reported = typeof error?.result?.error?.category === "string"
    ? error.result.error.category
    : error?.category;
  const category = allowedCategories.has(reported) ? reported : "exercise";
  process.stderr.write(`${JSON.stringify({ status: "failed", category })}\n`);
  process.exitCode = 1;
} finally {
  await credential?.close();
  database?.close();
  if (root) await rm(root, { recursive: true, force: true });
}
