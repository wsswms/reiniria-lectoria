import { createHash } from "node:crypto";
import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { M5C_DEEPSEEK_PRICING } from "../src/m5c/deepseek-role-adapter.mjs";
import { m5cQaThinkingComparisonCorpus } from "../tests/fixtures/m5c-5/qa-evaluation-corpus.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;

if (process.env.M5C_REAL_EVALUATION !== "qa-thinking-preflight") {
  throw new Error("M5C QA thinking preflight requires M5C_REAL_EVALUATION=qa-thinking-preflight");
}

let credential;
try {
  credential = await openCredentialFile("/run/secrets/deepseek");
  if (m5cQaThinkingComparisonCorpus.length !== 10) throw new Error("thinking comparison corpus must contain exactly ten cases");
  process.stdout.write(`${JSON.stringify({ schemaVersion: "m5c-real-model-qa-thinking-preflight-v1", status: "ready",
    model: "deepseek-v4-flash", origin: "https://api.deepseek.com", dataClass: "public-synthetic",
    cases: m5cQaThinkingComparisonCorpus.length, modes: ["disabled", "enabled"], callsPerCasePerMode: 1,
    maximumCalls: 20, temperature: 0, maxOutputTokens: 4_096,
    corpusDigest: sha(JSON.stringify(m5cQaThinkingComparisonCorpus)), pricing: M5C_DEEPSEEK_PRICING,
    credentialInjection: "read-only-secret-mount-to-fd-broker", rawResponsesRetained: false,
    reasoningRetained: false, automaticRetries: 0 })}\n`);
} finally { await credential?.close(); }
