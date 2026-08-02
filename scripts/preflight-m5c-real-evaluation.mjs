import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { M5C_DEEPSEEK_PRICING } from "../src/m5c/deepseek-role-adapter.mjs";
import { m5cRealEvaluationCorpus } from "../tests/fixtures/m5c-5/real-evaluation-corpus.mjs";

if (process.env.M5C_REAL_EVALUATION !== "preflight") throw new Error("M5C real preflight requires M5C_REAL_EVALUATION=preflight");
let deepseek; let brave;
try {
  deepseek = await openCredentialFile("/run/secrets/deepseek"); brave = await openCredentialFile("/run/secrets/brave");
  process.stdout.write(`${JSON.stringify({ schemaVersion: "m5c-real-evaluation-preflight-v1", status: "ready", dataClass: "public-synthetic",
    model: "deepseek-v4-flash", documents: m5cRealEvaluationCorpus.map(({ id, sourceLanguage, targetLanguage, domain, length }) =>
    ({ id, direction: `${sourceLanguage}->${targetLanguage}`, domain, length })), maximums: { plannerCalls: 3, translationCalls: 7,
      workflowQaCalls: 4, modelQaMetricCalls: 16, modelQaFinalDiagnosticCalls: 1, modelQaThinkingComparisonCalls: 20, retranslationCalls: 1, braveCalls: 1,
      deepSeekCostMicrosCny: 100_000_000, braveCostMicrosUsd: 4_000_000 },
    pricing: M5C_DEEPSEEK_PRICING, credentialInjection: "read-only-secret-mount-to-fd-brokers", rawResponseRetention: false })}\n`);
} finally { await deepseek?.close(); await brave?.close(); }
