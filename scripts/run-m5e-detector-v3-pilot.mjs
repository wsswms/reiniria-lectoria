import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { invokeM5CModelBroker } from "../src/m5c/model-broker-process.mjs";
import { assembleDetectorV3Coverage, buildDetectorV3Plan } from "../src/m5e/detector-v3.mjs";
import { M5EDetectorV3AuditSession } from "./m5e-detector-v3-audit.mjs";
import { createDetectorV3Fixture } from "./m5e-detector-v3-fixture.mjs";

const MODEL_ID = "deepseek-v4-flash";
const MAX_OUTPUT_TOKENS = 65_536;
const MAX_ACTUAL_ATTEMPTS = 16;
const MAX_COST_MICROS_CNY = 5_000_000;
const PRIOR = Object.freeze({ actualAttempts: 12, inputTokens: 91_957, outputTokens: 432_362,
  reasoningTokens: 394_968, totalTokens: 524_319, costMicrosCny: 2_678_712, durationMs: 3_439_156,
  diagnosticAuditManifestDigest: "sha256:40ef451b79a5f533b30c119fd8db35a46b8345ea041f5d8af48956309179cb83",
  partialAuditManifestDigest: "sha256:09c68776d0c82f5a3e89a35e8678da82d1373a8d390f5512e617c343da36febf",
  resumedAuditManifestDigest: "sha256:b5740748a681ff0abf1b6ff6ab81dcc9fa2426e51563e95cb06638fafe48fff4",
  continuationAuditManifestDigest: "sha256:d5ce4feae0e877424080c5552c4e90a5941ee4111992de8b2c96c04950c30246",
  repairAuditManifestDigest: "sha256:d9417482bd6849026ab68894f683c3eaf7b5786ed522d4c0aa639bf5b7ff2c83",
  completedArtifacts: Object.freeze([
    Object.freeze({ coverageDigest: "sha256:9df6aa1a6f3071d31713d2850abe818dffb8bf604eeb53fe6de48514b4ee51f7",
      artifactDigest: "sha256:cd5702fa6edadc9e4e2c4a5550afd053616acc3ec8108cdd362f6402a76f5801" }),
    Object.freeze({ coverageDigest: "sha256:a739ffb09b7019d77fe810fa66c4c580389313bb0fe947326a21cff2cb714115",
      artifactDigest: "sha256:bba55c2faca08bddac7585abaa06650f10c204c79870e1292dc323c657cb2bdc" }),
    Object.freeze({ coverageDigest: "sha256:966b2f5795459f175989fb1fdf62f82015454df2471906f3c2c3af8d27acb8d1",
      artifactDigest: "sha256:8e08a393b54e40ca866b77603bd84f3df8626571d9da14aa2b6d3594a23f7b84" }),
  ]) });
const sha = (value) => `sha256:${createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex")}`;

async function outputDirectory(path) {
  if (typeof path !== "string" || path.length < 1) throw new Error("M5E_DETECTOR_V3_OUTPUT_DIR is required");
  await mkdir(path, { recursive: false, mode: 0o700 }); const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("Detector v3 output directory is invalid");
  return path;
}
async function save(root, name, value) {
  const path = join(root, name); const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); } finally { await handle.close(); }
  await chmod(path, 0o600); return sha(await readFile(path));
}
async function priorCompleted(path, coverage) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > 16 * 1024 * 1024) {
    throw new Error("Detector v3 prior artifact is invalid");
  }
  const expected = PRIOR.completedArtifacts.find((item) => item.coverageDigest === coverage.coverageDigest)?.artifactDigest;
  const bytes = await readFile(path); if (!expected || sha(bytes) !== expected) throw new Error("Detector v3 prior artifact digest mismatch");
  const artifact = JSON.parse(bytes.toString("utf8"));
  if (artifact?.schemaVersion !== "m5e-detector-v3-pilot-result-v1" || artifact?.coverage?.coverageDigest !== coverage.coverageDigest
    || artifact?.plan?.documentId !== coverage.document.documentId || artifact?.thinking !== "enabled") throw new Error("Detector v3 prior artifact identity mismatch");
  return Object.freeze({ ...artifact.summary, artifactDigest: expected, reusedPriorArtifact: true });
}
function add(target, usage) {
  for (const key of ["calls", "inputTokens", "outputTokens", "reasoningTokens", "totalTokens", "costMicrosCny", "durationMs"]) target[key] += usage[key];
}
function coverageSummary(coverage) {
  return Object.freeze({ documentId: coverage.document.documentId, language: coverage.document.language,
    targetLanguage: coverage.document.targetLanguage, segments: coverage.document.segments.length,
    characters: coverage.document.segments.reduce((sum, item) => sum + item.sourceText.length, 0),
    exactBindings: coverage.exactBindings.length, exactFacts: new Set(coverage.exactBindings.map((item) => item.factId)).size,
    knowledgeHits: coverage.knowledgeHits.length, coverageDigest: coverage.coverageDigest });
}
function planSummary(plan) {
  const counts = (field) => Object.fromEntries([...new Set(plan.knowledgeIdentities.map((item) => item[field]))].sort()
    .map((value) => [value, plan.knowledgeIdentities.filter((item) => item[field] === value).length]));
  return Object.freeze({ knowledgeIdentities: plan.knowledgeIdentities.length, researchBatches: plan.researchBatches.length,
    batchCompressionRatio: plan.knowledgeIdentities.length === 0 ? 0 : 1 - plan.researchBatches.length / plan.knowledgeIdentities.length,
    byKind: counts("kind"), byImpact: counts("impact"), byResolution: counts("resolution"),
    sharedBatches: plan.researchBatches.filter((item) => item.memberKnowledgeIdentityIds.length > 1).length, planDigest: plan.planDigest });
}

const mode = process.env.M5E_DETECTOR_V3_MODE;
if (!new Set(["dry-run", "execute"]).has(mode)) throw new Error("Detector v3 pilot requires dry-run or execute mode");
let fixture; let credential; let audit; let stage = "fixture"; const completed = [];
try {
  fixture = await createDetectorV3Fixture(process.env.M5E_DETECTOR_V3_CORPUS);
  const coverages = fixture.documents.map((document) => assembleDetectorV3Coverage({ document, approvedTerms: fixture.approvedTerms, retriever: fixture.retriever }));
  const coverageSummaries = coverages.map(coverageSummary);
  if (mode === "dry-run") {
    process.stdout.write(`${JSON.stringify({ schemaVersion: "m5e-detector-v3-preflight-v1", status: "ready", corpusDigest: fixture.corpusDigest,
      syntheticFacts: fixture.syntheticFactCount, factSetDigest: fixture.manifest.factSetDigest, documents: coverageSummaries,
      modelId: MODEL_ID, thinking: "enabled", logicalCalls: 4, maximumActualAttempts: MAX_ACTUAL_ATTEMPTS,
      maximumCostMicrosCny: MAX_COST_MICROS_CNY, maximumOutputTokensPerAttempt: MAX_OUTPUT_TOKENS,
      braveCalls: 0, fetchUrls: 0, translationCalls: 0, qaCalls: 0, credentialRead: false })}\n`); process.exitCode = 0;
  } else {
    const outputRoot = await outputDirectory(process.env.M5E_DETECTOR_V3_OUTPUT_DIR); audit = await M5EDetectorV3AuditSession.create(outputRoot);
    credential = await openCredentialFile(process.env.DEEPSEEK_KEY_FILE);
    const totals = { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, costMicrosCny: 0, durationMs: 0 };
    const pendingCoverages = [];
    for (const [index, coverage] of coverages.entries()) {
      const priorPath = process.env[`M5E_DETECTOR_V3_PRIOR_ARTIFACT_${index + 1}`]
        ?? (index === 0 ? process.env.M5E_DETECTOR_V3_PRIOR_ARTIFACT : undefined);
      if (priorPath) completed.push(await priorCompleted(priorPath, coverage)); else pendingCoverages.push(coverage);
    }
    for (const [coverageIndex, coverage] of pendingCoverages.entries()) {
      const language = coverage.document.language; const label = `${coverage.document.documentId}-${language}`; stage = label;
      const remainingDocuments = pendingCoverages.length - coverageIndex; const remainingAttempts = MAX_ACTUAL_ATTEMPTS - PRIOR.actualAttempts - totals.calls;
      const maximumAttempts = remainingAttempts > remainingDocuments ? 2 : 1;
      const result = await audit.invoke(`detector-v3-${label}`,
        { documentId: coverage.document.documentId, language, targetLanguage: coverage.document.targetLanguage,
          role: "planner-detector-v3", thinking: "enabled", promptVersion: "m5e-detector-v3-v1" },
        (auditFd) => invokeM5CModelBroker({ credentialFd: credential.fd, auditFd,
          request: { coverage, modelId: MODEL_ID, maxOutputTokens: MAX_OUTPUT_TOKENS, maximumAttempts } },
        { entry: new URL("./m5e-detector-v3-broker-entry.mjs", import.meta.url), timeoutMs: 900_000, outputBytes: 32 * 1024 * 1024 }));
      add(totals, result.usage);
      if (PRIOR.actualAttempts + totals.calls > MAX_ACTUAL_ATTEMPTS
        || PRIOR.costMicrosCny + totals.costMicrosCny > MAX_COST_MICROS_CNY) throw Object.assign(new Error("Detector v3 budget exceeded"), { category: "budget" });
      const plan = buildDetectorV3Plan(result, coverage); const summary = Object.freeze({ ...coverageSummary(coverage), ...planSummary(plan), usage: result.usage });
      const artifact = Object.freeze({ schemaVersion: "m5e-detector-v3-pilot-result-v1", modelId: MODEL_ID, thinking: "enabled",
        syntheticKnowledge: true, coverage, result, plan, summary, researchPerformed: false, translationPerformed: false,
        qaPerformed: false, approvalPerformed: false });
      const artifactDigest = await save(outputRoot, `${label}.json`, artifact); completed.push(Object.freeze({ ...summary, artifactDigest }));
      process.stderr.write(`${JSON.stringify({ type: "progress", stage, exactBindings: summary.exactBindings,
        identities: summary.knowledgeIdentities, researchBatches: summary.researchBatches, actualAttempts: result.usage.calls })}\n`);
    }
    stage = "report"; const report = Object.freeze({ schemaVersion: "m5e-detector-v3-pilot-report-v1", status: "completed",
      corpusDigest: fixture.corpusDigest, syntheticFacts: fixture.syntheticFactCount, factSetDigest: fixture.manifest.factSetDigest,
      modelId: MODEL_ID, thinking: "enabled", maximums: Object.freeze({ logicalCalls: 4, actualAttempts: MAX_ACTUAL_ATTEMPTS,
        costMicrosCny: MAX_COST_MICROS_CNY, braveCalls: 0, fetchUrls: 0, translationCalls: 0, qaCalls: 0 }),
      documents: Object.freeze(completed), prior: PRIOR, totals: Object.freeze(totals),
      cumulativeTotals: Object.freeze({ actualAttempts: PRIOR.actualAttempts + totals.calls,
        inputTokens: PRIOR.inputTokens + totals.inputTokens, outputTokens: PRIOR.outputTokens + totals.outputTokens,
        reasoningTokens: PRIOR.reasoningTokens + totals.reasoningTokens, totalTokens: PRIOR.totalTokens + totals.totalTokens,
        costMicrosCny: PRIOR.costMicrosCny + totals.costMicrosCny,
        durationMs: PRIOR.durationMs + totals.durationMs }), productionM5CModified: false,
      knowledgePersistedToUserWorkspace: false, researchPerformed: false, translationPerformed: false, qaPerformed: false });
    const reportDigest = await save(outputRoot, "detector-v3-pilot-report.json", report); const auditSummary = await audit.summary();
    process.stdout.write(`${JSON.stringify({ status: "completed", logicalCalls: completed.length, newLogicalCalls: pendingCoverages.length, actualAttempts: totals.calls,
      cumulativeActualAttempts: PRIOR.actualAttempts + totals.calls, totals,
      cumulativeCostMicrosCny: PRIOR.costMicrosCny + totals.costMicrosCny,
      documents: completed.map((item) => ({ documentId: item.documentId, language: item.language,
        exactBindings: item.exactBindings, knowledgeHits: item.knowledgeHits, knowledgeIdentities: item.knowledgeIdentities,
        researchBatches: item.researchBatches, sharedBatches: item.sharedBatches })), reportDigest, auditManifestDigest: auditSummary.manifestDigest })}\n`);
  }
} catch (error) {
  const auditSummary = await audit?.summary().catch(() => null); process.stderr.write(`${JSON.stringify({ status: "failed", stage,
    category: error?.category ?? "evaluation", completed, auditManifestDigest: auditSummary?.manifestDigest ?? null })}\n`); process.exitCode = 1;
} finally { await credential?.close(); await fixture?.close(); }
