import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { invokeM5CModelBroker } from "../src/m5c/model-broker-process.mjs";
import { compareP1LiteModes, normalizeP1LitePayload, summarizeP1LiteResult } from "../src/m5e/p1-lite.mjs";
import { M5EP1LiteAuditSession } from "./m5e-p1-lite-audit.mjs";

const MODEL_ID = "deepseek-v4-flash";
const MAX_OUTPUT_TOKENS = 65_536;
const PART1_DISABLED_ARTIFACT_DIGEST = "sha256:012aedf329faee08ab57356e5ef01a77e13eeddf4675cc86d5732ade718c9daa";
const PART1_AUDIT_MANIFEST_DIGEST = "sha256:2f96c68cc7b6bc5edfbc6dfc37255998565db4500630ba3611fc659083ead69f";
const PRIOR = Object.freeze({ actualAttempts: 4, inputTokens: 121_809, outputTokens: 92_869, reasoningTokens: 22_276,
  totalTokens: 214_678, costMicrosCny: 861_133, durationMs: 573_550 });
const FIXED = Object.freeze({
  part1: Object.freeze({ localItems: 239, digest: "sha256:f08ec7290eb4266a563385b31667e7fcea38989c517c93746b21590147a8936a" }),
  part2: Object.freeze({ localItems: 226, digest: "sha256:3d35fb21871658ba1ee94eeb0a38c99e0b61ef804ef76c73213178fc9020f54d" }),
});
const sha = (value) => `sha256:${createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex")}`;

async function privateFile(path, maximum = 2 * 1024 * 1024) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > maximum) {
    throw new Error("P1-Lite continuation input is invalid");
  }
  return readFile(path);
}
async function outputDirectory(path) {
  await mkdir(path, { recursive: false, mode: 0o700 }); const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("P1-Lite continuation output is invalid"); return path;
}
async function save(root, name, value) { const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); const path = join(root, name);
  await writeFile(path, bytes, { mode: 0o600 }); await chmod(path, 0o600); return sha(bytes); }
async function historicalRequest(path, fixed) {
  const events = (await privateFile(path)).toString("utf8").trim().split("\n").map(JSON.parse);
  const request = JSON.parse(events.find((event) => event?.event === "request")?.request?.body?.messages?.[1]?.content ?? "null");
  if (sha(request) !== fixed.digest || request?.localItems?.length !== fixed.localItems) throw new Error("historical request digest mismatch"); return request;
}
function normalizedUsage(value, durationMs) {
  const inputTokens = value.prompt_tokens, outputTokens = value.completion_tokens, totalTokens = value.total_tokens;
  const reasoningTokens = value.completion_tokens_details?.reasoning_tokens ?? 0;
  if (![inputTokens, outputTokens, totalTokens, reasoningTokens].every((item) => Number.isSafeInteger(item) && item >= 0)
    || inputTokens + outputTokens !== totalTokens || reasoningTokens > outputTokens) throw new Error("continuation usage is invalid");
  return Object.freeze({ calls: 1, inputTokens, outputTokens, reasoningTokens, totalTokens,
    costMicrosCny: Math.ceil((inputTokens * 28 + outputTokens * 56) / 10), durationMs });
}
function add(target, usage) { for (const key of ["calls", "inputTokens", "outputTokens", "reasoningTokens", "totalTokens", "costMicrosCny", "durationMs"]) target[key] += usage[key]; }

if (process.env.M5E_P1LITE_PART2_CONTINUATION !== "execute") throw new Error("P1-Lite Part2 continuation requires explicit execute gate");
let credential; let audit; let stage = "preflight"; const completed = [];
try {
  const outputRoot = await outputDirectory(process.env.M5E_P1LITE_OUTPUT_DIR); audit = await M5EP1LiteAuditSession.create(outputRoot);
  credential = await openCredentialFile(process.env.DEEPSEEK_KEY_FILE);
  const part1Request = await historicalRequest(process.env.M5E_P1LITE_INPUT_ONE, FIXED.part1);
  const part2Request = await historicalRequest(process.env.M5E_P1LITE_INPUT_TWO, FIXED.part2);
  const disabledBytes = await privateFile(process.env.M5E_P1LITE_PART1_DISABLED_ARTIFACT);
  if (sha(disabledBytes) !== PART1_DISABLED_ARTIFACT_DIGEST) throw new Error("Part1 disabled artifact digest mismatch");
  const disabledArtifact = JSON.parse(disabledBytes.toString("utf8")); const part1Disabled = disabledArtifact.result;
  const priorManifest = await privateFile(process.env.M5E_P1LITE_PART1_AUDIT_MANIFEST);
  if (sha(priorManifest) !== PART1_AUDIT_MANIFEST_DIGEST) throw new Error("Part1 audit manifest digest mismatch");
  const priorManifestValue = JSON.parse(priorManifest.toString("utf8")); if (priorManifestValue?.entries?.length !== 2
    || priorManifestValue.entries[0].normalized !== true || priorManifestValue.entries[1].thinking !== "enabled") throw new Error("Part1 audit manifest is incomplete");
  const enabledEvents = (await privateFile(process.env.M5E_P1LITE_PART1_ENABLED_AUDIT)).toString("utf8").trim().split("\n").map(JSON.parse);
  const enabledEvent = enabledEvents.find((event) => event?.event === "response"); const raw = JSON.parse(enabledEvent?.response?.rawBody ?? "null");
  if (raw?.choices?.[0]?.finish_reason !== "stop" || typeof raw.choices[0].message?.content !== "string") throw new Error("Part1 enabled response is incomplete");
  const part1Enabled = Object.freeze({ responseId: raw.id, ...normalizeP1LitePayload(JSON.parse(raw.choices[0].message.content), part1Request),
    usage: normalizedUsage(raw.usage, enabledEvent.elapsedMs) });
  if (part1Disabled.schemaVersion !== "m5e-p1-lite-v2") throw new Error("Part1 disabled result schema mismatch");
  const results = new Map([["nikon-omoshiro-part1:disabled", part1Disabled], ["nikon-omoshiro-part1:enabled", part1Enabled]]);
  for (const thinking of ["enabled", "disabled"]) {
    stage = `nikon-omoshiro-part2:${thinking}`;
    const result = await audit.invoke(`p1-lite-nikon-omoshiro-part2-${thinking}`,
      { articleId: "nikon-omoshiro-part2", role: "planner-p1-lite", thinking, promptVersion: "m5e-p1-lite-v2" },
      (auditFd) => invokeM5CModelBroker({ credentialFd: credential.fd, auditFd,
        request: { plannerRequest: part2Request, modelId: MODEL_ID, thinking, maxOutputTokens: MAX_OUTPUT_TOKENS, maximumAttempts: 1 } },
      { entry: new URL("./m5e-p1-lite-broker-entry.mjs", import.meta.url), timeoutMs: 900_000, outputBytes: 32 * 1024 * 1024 }));
    const summary = summarizeP1LiteResult(result, part2Request); results.set(`nikon-omoshiro-part2:${thinking}`, result); completed.push({ thinking, summary, usage: result.usage });
    await save(outputRoot, `nikon-omoshiro-part2-${thinking}.json`, { schemaVersion: "m5e-p1-lite-result-v2", articleId: "nikon-omoshiro-part2",
      thinking, modelId: MODEL_ID, promptVersion: "m5e-p1-lite-v2", result, summary });
    process.stderr.write(`${JSON.stringify({ type: "progress", stage, outputItems: summary.outputItems })}\n`);
  }
  const part1Comparison = compareP1LiteModes(part1Disabled, part1Enabled);
  const part2Comparison = compareP1LiteModes(results.get("nikon-omoshiro-part2:disabled"), results.get("nikon-omoshiro-part2:enabled"));
  const newTotals = { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, costMicrosCny: 0, durationMs: 0 };
  for (const item of completed) add(newTotals, item.usage);
  const cumulative = Object.freeze({ actualAttempts: PRIOR.actualAttempts + newTotals.calls, inputTokens: PRIOR.inputTokens + newTotals.inputTokens,
    outputTokens: PRIOR.outputTokens + newTotals.outputTokens, reasoningTokens: PRIOR.reasoningTokens + newTotals.reasoningTokens,
    totalTokens: PRIOR.totalTokens + newTotals.totalTokens, costMicrosCny: PRIOR.costMicrosCny + newTotals.costMicrosCny,
    durationMs: PRIOR.durationMs + newTotals.durationMs });
  if (cumulative.actualAttempts > 8 || cumulative.costMicrosCny > 5_000_000) throw Object.assign(new Error("continuation hard budget exceeded"), { category: "budget" });
  const artifact = Object.freeze({ schemaVersion: "m5e-p1-lite-thinking-pilot-v2", status: "completed", modelId: MODEL_ID,
    promptVersion: "m5e-p1-lite-v2", prior: Object.freeze({ ...PRIOR, auditManifestDigest: PART1_AUDIT_MANIFEST_DIGEST,
      disabledArtifactDigest: PART1_DISABLED_ARTIFACT_DIGEST }), part1: Object.freeze({ disabled: summarizeP1LiteResult(part1Disabled, part1Request),
      enabled: summarizeP1LiteResult(part1Enabled, part1Request), comparison: part1Comparison }),
    part2: Object.freeze({ enabled: summarizeP1LiteResult(results.get("nikon-omoshiro-part2:enabled"), part2Request),
      disabled: summarizeP1LiteResult(results.get("nikon-omoshiro-part2:disabled"), part2Request), comparison: part2Comparison }),
    newTotals: Object.freeze(newTotals), cumulative, referenceFamiliesInjected: false, translationPerformed: false,
    researchPerformed: false, approvalPerformed: false });
  const artifactDigest = await save(outputRoot, "p1-lite-thinking-comparison.json", artifact); const auditSummary = await audit.summary();
  process.stdout.write(`${JSON.stringify({ status: "completed", part1: { disabledItems: artifact.part1.disabled.outputItems, enabledItems: artifact.part1.enabled.outputItems,
    jaccard: part1Comparison.jaccard }, part2: { disabledItems: artifact.part2.disabled.outputItems, enabledItems: artifact.part2.enabled.outputItems,
    jaccard: part2Comparison.jaccard }, newTotals, cumulative, artifactDigest, auditManifestDigest: auditSummary.manifestDigest })}\n`);
} catch (error) {
  const summary = await audit?.summary().catch(() => null); process.stderr.write(`${JSON.stringify({ status: "failed", stage,
    category: error?.category ?? "evaluation", completed, auditManifestDigest: summary?.manifestDigest ?? null })}\n`); process.exitCode = 1;
} finally { await credential?.close(); }
