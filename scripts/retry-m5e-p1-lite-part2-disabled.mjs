import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { invokeM5CModelBroker } from "../src/m5c/model-broker-process.mjs";
import { compareP1LiteModes, normalizeP1LitePayload, summarizeP1LiteResult } from "../src/m5e/p1-lite.mjs";
import { M5EP1LiteAuditSession } from "./m5e-p1-lite-audit.mjs";

const MODEL_ID = "deepseek-v4-flash";
const MAX_OUTPUT_TOKENS = 65_536;
const PRIOR = Object.freeze({ actualAttempts: 6, inputTokens: 154_642, outputTokens: 127_972, reasoningTokens: 44_596,
  totalTokens: 282_614, costMicrosCny: 1_149_643, durationMs: 874_743 });
const DIGESTS = Object.freeze({
  part1Disabled: "sha256:012aedf329faee08ab57356e5ef01a77e13eeddf4675cc86d5732ade718c9daa",
  part1Manifest: "sha256:2f96c68cc7b6bc5edfbc6dfc37255998565db4500630ba3611fc659083ead69f",
  part2Enabled: "sha256:dbe1e842f48f6a6855663fb0e37d4c97cc2ec698285bcfe79eb8df259816d25a",
  part2FailedManifest: "sha256:6548fb6c89224f26a70a6c7c1d035d03e0edb6fb1284dbe3efe100081c8b25c1",
  part2FailedAudit: "sha256:9b4b5ca23cd20fed956011c546dfd6830d1137185be2e8c7a76e0f7e8c493019",
});
const FIXED = Object.freeze({
  part1: Object.freeze({ localItems: 239, digest: "sha256:f08ec7290eb4266a563385b31667e7fcea38989c517c93746b21590147a8936a" }),
  part2: Object.freeze({ localItems: 226, digest: "sha256:3d35fb21871658ba1ee94eeb0a38c99e0b61ef804ef76c73213178fc9020f54d" }),
});
const sha = (value) => `sha256:${createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex")}`;

async function privateFile(path, maximum = 2 * 1024 * 1024) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > maximum) {
    throw new Error("P1-Lite retry input is invalid");
  }
  return readFile(path);
}
async function checkedFile(path, digest) {
  const bytes = await privateFile(path); if (sha(bytes) !== digest) throw new Error("P1-Lite retry artifact digest mismatch"); return bytes;
}
async function outputDirectory(path) {
  await mkdir(path, { recursive: false, mode: 0o700 }); const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("P1-Lite retry output is invalid");
  return path;
}
async function save(root, name, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); const path = join(root, name);
  await writeFile(path, bytes, { mode: 0o600 }); await chmod(path, 0o600); return sha(bytes);
}
async function historicalRequest(path, fixed) {
  const events = (await privateFile(path)).toString("utf8").trim().split("\n").map(JSON.parse);
  const request = JSON.parse(events.find((event) => event?.event === "request")?.request?.body?.messages?.[1]?.content ?? "null");
  if (sha(request) !== fixed.digest || request?.localItems?.length !== fixed.localItems) throw new Error("historical request digest mismatch"); return request;
}
function normalizedUsage(value, durationMs) {
  const inputTokens = value.prompt_tokens, outputTokens = value.completion_tokens, totalTokens = value.total_tokens;
  const reasoningTokens = value.completion_tokens_details?.reasoning_tokens ?? 0;
  if (![inputTokens, outputTokens, totalTokens, reasoningTokens].every((item) => Number.isSafeInteger(item) && item >= 0)
    || inputTokens + outputTokens !== totalTokens || reasoningTokens > outputTokens) throw new Error("retry replay usage is invalid");
  return Object.freeze({ calls: 1, inputTokens, outputTokens, reasoningTokens, totalTokens,
    costMicrosCny: Math.ceil((inputTokens * 28 + outputTokens * 56) / 10), durationMs });
}
function replayEnabled(auditBytes, request) {
  const events = auditBytes.toString("utf8").trim().split("\n").map(JSON.parse); const event = events.find((item) => item?.event === "response");
  const raw = JSON.parse(event?.response?.rawBody ?? "null");
  if (raw?.choices?.[0]?.finish_reason !== "stop" || typeof raw.choices[0].message?.content !== "string") throw new Error("Part1 enabled replay is incomplete");
  return Object.freeze({ responseId: raw.id, ...normalizeP1LitePayload(JSON.parse(raw.choices[0].message.content), request),
    usage: normalizedUsage(raw.usage, event.elapsedMs) });
}

if (process.env.M5E_P1LITE_PART2_DISABLED_RETRY !== "execute") throw new Error("P1-Lite disabled retry requires explicit execute gate");
let credential; let audit; let stage = "preflight";
try {
  const outputRoot = await outputDirectory(process.env.M5E_P1LITE_OUTPUT_DIR); audit = await M5EP1LiteAuditSession.create(outputRoot);
  credential = await openCredentialFile(process.env.DEEPSEEK_KEY_FILE);
  const part1Request = await historicalRequest(process.env.M5E_P1LITE_INPUT_ONE, FIXED.part1);
  const part2Request = await historicalRequest(process.env.M5E_P1LITE_INPUT_TWO, FIXED.part2);
  const part1DisabledArtifact = JSON.parse((await checkedFile(process.env.M5E_P1LITE_PART1_DISABLED_ARTIFACT, DIGESTS.part1Disabled)).toString("utf8"));
  await checkedFile(process.env.M5E_P1LITE_PART1_AUDIT_MANIFEST, DIGESTS.part1Manifest);
  const part1Enabled = replayEnabled(await privateFile(process.env.M5E_P1LITE_PART1_ENABLED_AUDIT), part1Request);
  const part2EnabledArtifact = JSON.parse((await checkedFile(process.env.M5E_P1LITE_PART2_ENABLED_ARTIFACT, DIGESTS.part2Enabled)).toString("utf8"));
  const failedManifest = JSON.parse((await checkedFile(process.env.M5E_P1LITE_PART2_FAILED_MANIFEST, DIGESTS.part2FailedManifest)).toString("utf8"));
  const failedAudit = await checkedFile(process.env.M5E_P1LITE_PART2_FAILED_AUDIT, DIGESTS.part2FailedAudit);
  if (failedManifest?.entries?.length !== 2 || failedManifest.entries[0].normalized !== true || failedManifest.entries[1].normalized !== false
    || failedManifest.entries.some((entry) => entry.actualAttempts !== 1)) throw new Error("failed Part2 manifest is inconsistent");
  const failedEvents = failedAudit.toString("utf8").trim().split("\n").map(JSON.parse); const failedResponse = failedEvents.find((event) => event?.event === "response");
  const failedPayload = JSON.parse(failedResponse?.response?.content ?? "null");
  if (failedResponse?.response?.finishReason !== "stop" || failedPayload?.items?.length !== 109) throw new Error("failed Part2 response identity changed");
  const part1Disabled = part1DisabledArtifact.result; const part2Enabled = part2EnabledArtifact.result;
  stage = "nikon-omoshiro-part2:disabled-retry";
  const part2Disabled = await audit.invoke("p1-lite-nikon-omoshiro-part2-disabled-retry",
    { articleId: "nikon-omoshiro-part2", role: "planner-p1-lite", thinking: "disabled", promptVersion: "m5e-p1-lite-v2", recoveryOf: DIGESTS.part2FailedAudit },
    (auditFd) => invokeM5CModelBroker({ credentialFd: credential.fd, auditFd,
      request: { plannerRequest: part2Request, modelId: MODEL_ID, thinking: "disabled", maxOutputTokens: MAX_OUTPUT_TOKENS, maximumAttempts: 2 } },
    { entry: new URL("./m5e-p1-lite-broker-entry.mjs", import.meta.url), timeoutMs: 900_000, outputBytes: 32 * 1024 * 1024 }));
  const cumulative = Object.freeze({ actualAttempts: PRIOR.actualAttempts + part2Disabled.usage.calls,
    inputTokens: PRIOR.inputTokens + part2Disabled.usage.inputTokens, outputTokens: PRIOR.outputTokens + part2Disabled.usage.outputTokens,
    reasoningTokens: PRIOR.reasoningTokens + part2Disabled.usage.reasoningTokens, totalTokens: PRIOR.totalTokens + part2Disabled.usage.totalTokens,
    costMicrosCny: PRIOR.costMicrosCny + part2Disabled.usage.costMicrosCny, durationMs: PRIOR.durationMs + part2Disabled.usage.durationMs });
  if (cumulative.actualAttempts > 8 || cumulative.costMicrosCny > 5_000_000) throw Object.assign(new Error("retry hard budget exceeded"), { category: "budget" });
  const part1Comparison = compareP1LiteModes(part1Disabled, part1Enabled); const part2Comparison = compareP1LiteModes(part2Disabled, part2Enabled);
  const artifact = Object.freeze({ schemaVersion: "m5e-p1-lite-thinking-pilot-v2", status: "completed-after-bounded-retry", modelId: MODEL_ID,
    promptVersion: "m5e-p1-lite-v2", prior: Object.freeze({ ...PRIOR, failedPart2AuditDigest: DIGESTS.part2FailedAudit }),
    part1: Object.freeze({ disabled: summarizeP1LiteResult(part1Disabled, part1Request), enabled: summarizeP1LiteResult(part1Enabled, part1Request), comparison: part1Comparison }),
    part2: Object.freeze({ disabled: summarizeP1LiteResult(part2Disabled, part2Request), enabled: summarizeP1LiteResult(part2Enabled, part2Request), comparison: part2Comparison }),
    retryUsage: part2Disabled.usage, cumulative, referenceFamiliesInjected: false, translationPerformed: false, researchPerformed: false, approvalPerformed: false });
  const disabledDigest = await save(outputRoot, "nikon-omoshiro-part2-disabled.json", { schemaVersion: "m5e-p1-lite-result-v2",
    articleId: "nikon-omoshiro-part2", thinking: "disabled", modelId: MODEL_ID, promptVersion: "m5e-p1-lite-v2", result: part2Disabled,
    summary: artifact.part2.disabled });
  const artifactDigest = await save(outputRoot, "p1-lite-thinking-comparison.json", artifact); const auditSummary = await audit.summary();
  process.stdout.write(`${JSON.stringify({ status: artifact.status, part1: { disabledItems: artifact.part1.disabled.outputItems,
    enabledItems: artifact.part1.enabled.outputItems, jaccard: part1Comparison.jaccard }, part2: { disabledItems: artifact.part2.disabled.outputItems,
    enabledItems: artifact.part2.enabled.outputItems, jaccard: part2Comparison.jaccard }, retryUsage: part2Disabled.usage, cumulative,
    disabledDigest, artifactDigest, auditManifestDigest: auditSummary.manifestDigest })}\n`);
} catch (error) {
  const summary = await audit?.summary().catch(() => null); process.stderr.write(`${JSON.stringify({ status: "failed", stage,
    category: error?.category ?? "evaluation", auditManifestDigest: summary?.manifestDigest ?? null })}\n`); process.exitCode = 1;
} finally { await credential?.close(); }
