import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildReferenceAdjudicationProposal } from "../src/m5e/reference-adjudication.mjs";

async function privateDirectory(path, { create = false } = {}) {
  if (typeof path !== "string" || path.length === 0) throw new Error("private directory path is required");
  if (create) await mkdir(path, { recursive: false, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("directory must be current-user 0700");
  return path;
}

const seedRoot = await privateDirectory(process.env.M5E_REFERENCE_SEED_DIR);
const outputRoot = await privateDirectory(process.env.M5E_REFERENCE_ADJUDICATION_DIR, { create: true });
const seedPath = join(seedRoot, "historical-reference-seed.json"); const seedStat = await lstat(seedPath);
if (!seedStat.isFile() || seedStat.isSymbolicLink() || seedStat.uid !== process.getuid() || (seedStat.mode & 0o077) !== 0) {
  throw new Error("seed file must be current-user 0600");
}
const proposal = buildReferenceAdjudicationProposal(JSON.parse(await readFile(seedPath, "utf8")), { createdAt: new Date().toISOString() });
const fullPath = join(outputRoot, "reference-adjudication-proposal.json");
await writeFile(fullPath, `${JSON.stringify(proposal, null, 2)}\n`, { mode: 0o600 }); await chmod(fullPath, 0o600);
const summary = { schemaVersion: "m5e-reference-adjudication-summary-v1", status: proposal.status,
  sourceSetDigest: proposal.sourceSetDigest, seedDigest: proposal.seedDigest, proposalDigest: proposal.proposalDigest, counts: proposal.counts };
const summaryPath = join(outputRoot, "summary.json");
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 }); await chmod(summaryPath, 0o600);
process.stdout.write(`${JSON.stringify(summary)}\n`);
