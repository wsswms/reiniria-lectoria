import { createHash } from "node:crypto";
import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { invokeM5CModelBroker } from "../src/m5c/model-broker-process.mjs";
import { m5cQaThinkingComparisonCorpus } from "../tests/fixtures/m5c-5/qa-evaluation-corpus.mjs";

const MODES = Object.freeze(["disabled", "enabled"]);
const sha = (value) => `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
const uuid = (value) => {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const zeroUsage = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, costMicrosCny: 0, costMicrosUsd: 0, durationMs: 0 });

function metrics(cases, outcomes, mode) {
  let truePositive = 0; let falsePositive = 0; let falseNegative = 0; let trueNegative = 0;
  const falsePositiveCases = []; const criticalEscapes = []; const usage = zeroUsage();
  const selected = outcomes.filter((item) => item.mode === mode);
  for (const outcome of selected) for (const key of Object.keys(usage)) usage[key] += outcome.usage?.[key] ?? 0;
  for (const item of cases) {
    const outcome = selected.find((candidate) => candidate.caseId === item.id);
    const expectedDefect = item.labels.length > 0;
    if (outcome?.status !== "completed") {
      if (expectedDefect) { falseNegative += 1; criticalEscapes.push(item.id); }
      continue;
    }
    const predictedDefect = outcome.findings.length > 0;
    if (expectedDefect && predictedDefect) truePositive += 1;
    else if (!expectedDefect && predictedDefect) { falsePositive += 1; falsePositiveCases.push(item.id); }
    else if (expectedDefect) { falseNegative += 1; criticalEscapes.push(item.id); }
    else trueNegative += 1;
  }
  const precisionDenominator = truePositive + falsePositive;
  const recallDenominator = truePositive + falseNegative;
  return Object.freeze({ mode, cases: cases.length, completedCases: selected.filter((item) => item.status === "completed").length,
    malformedCases: selected.filter((item) => item.category === "malformed-response").length,
    confusion: { truePositive, falsePositive, falseNegative, trueNegative },
    precision: precisionDenominator === 0 ? null : truePositive / precisionDenominator,
    recall: recallDenominator === 0 ? null : truePositive / recallDenominator,
    falsePositiveCases, criticalEscapes, usage });
}

if (process.env.M5C_REAL_EVALUATION !== "qa-thinking-comparison") {
  throw new Error("real M5C QA thinking comparison requires M5C_REAL_EVALUATION=qa-thinking-comparison");
}
if (m5cQaThinkingComparisonCorpus.length !== 10) throw new Error("thinking comparison corpus must contain exactly ten cases");

let credential;
try {
  credential = await openCredentialFile("/run/secrets/deepseek");
  const outcomes = [];
  for (const item of m5cQaThinkingComparisonCorpus) {
    for (const mode of MODES) {
      const segmentId = uuid(item.id); const targetLanguage = item.direction.split("->")[1];
      try {
        const response = await invokeM5CModelBroker({ credentialFd: credential.fd,
          request: { role: "qa", modelId: "deepseek-v4-flash", maxOutputTokens: 4_096, thinking: mode,
            request: { schemaVersion: "m5c-model-qa-request-v1", workflowId: uuid(`workflow:${item.id}`),
              sourceRevisionId: uuid(`source:${item.id}`), targetLanguage, workingCopyDigest: sha(`working-copy:${item.id}`), scope: "full",
              segments: [{ segmentId, sourceText: item.source, targetText: item.target, targetDigest: sha(item.target) }] } } },
        { timeoutMs: 120_000 });
        outcomes.push(Object.freeze({ caseId: item.id, mode, status: "completed", expectedLabels: item.labels,
          findings: response.findings.map(({ severity, code }) => Object.freeze({ severity, code })), usage: response.usage }));
      } catch (error) {
        outcomes.push(Object.freeze({ caseId: item.id, mode, status: "failed", expectedLabels: item.labels,
          category: error?.category ?? "evaluation", providerCode: error?.providerCode === undefined ? null : String(error.providerCode),
          findings: Object.freeze([]), usage: null }));
      }
    }
  }
  const summaries = MODES.map((mode) => metrics(m5cQaThinkingComparisonCorpus, outcomes, mode));
  process.stdout.write(`${JSON.stringify({ schemaVersion: "m5c-real-model-qa-thinking-comparison-v1", status: "completed",
    model: "deepseek-v4-flash", dataClass: "public-synthetic", cases: m5cQaThinkingComparisonCorpus.length,
    pairedCalls: m5cQaThinkingComparisonCorpus.length, attemptedCalls: outcomes.length, maximumCalls: 20,
    corpusDigest: sha(JSON.stringify(m5cQaThinkingComparisonCorpus)), temperature: 0, maxOutputTokens: 4_096,
    summaries, outcomes, rawResponsesRetained: false, reasoningRetained: false })}\n`);
} finally { await credential?.close(); }
