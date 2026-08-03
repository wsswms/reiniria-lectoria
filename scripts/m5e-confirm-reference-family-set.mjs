import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { confirmReferenceAdjudication } from "../src/m5e/reference-adjudication.mjs";

async function privateDirectory(path, { create = false } = {}) {
  if (typeof path !== "string" || path.length === 0) throw new Error("private directory path is required");
  if (create) await mkdir(path, { recursive: false, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("directory must be current-user 0700");
  return path;
}

async function privateJson(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("file must be current-user 0600");
  return JSON.parse(await readFile(path, "utf8"));
}

const proposalRoot = await privateDirectory(process.env.M5E_REFERENCE_ADJUDICATION_DIR);
const proposal = await privateJson(join(proposalRoot, "reference-adjudication-proposal.json"));
if (process.env.M5E_REFERENCE_CONFIRM !== proposal.proposalDigest) throw new Error("explicit proposal digest confirmation is required");
if (typeof process.env.M5E_REFERENCE_CONFIRM_USER_ID !== "string" || process.env.M5E_REFERENCE_CONFIRM_USER_ID.length === 0) {
  throw new Error("confirming user identity is required");
}
const outputRoot = await privateDirectory(process.env.M5E_REFERENCE_FAMILY_SET_DIR, { create: true });
const frozen = confirmReferenceAdjudication(proposal, { confirmedAt: new Date().toISOString(),
  confirmedBy: { type: "user", id: process.env.M5E_REFERENCE_CONFIRM_USER_ID } });
const fullPath = join(outputRoot, "reference-family-set.json");
await writeFile(fullPath, `${JSON.stringify(frozen, null, 2)}\n`, { mode: 0o600 }); await chmod(fullPath, 0o600);
const summary = { schemaVersion: "m5e-reference-family-set-summary-v1", familySetDigest: frozen.familySetDigest,
  sourceSetDigest: frozen.sourceSetDigest, adjudicationProposalDigest: frozen.adjudicationProposalDigest,
  adjudicationMappingDigest: frozen.adjudicationMappingDigest, familyCount: frozen.families.length, frozenAt: frozen.frozenAt };
const summaryPath = join(outputRoot, "summary.json");
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 }); await chmod(summaryPath, 0o600);
process.stdout.write(`${JSON.stringify(summary)}\n`);
