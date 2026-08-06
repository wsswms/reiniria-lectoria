import { createHash } from "node:crypto";
import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { invokeM5CModelBroker } from "../src/m5c/model-broker-process.mjs";
import { m5cQaEvaluationCorpus } from "../tests/fixtures/m5c-5/qa-evaluation-corpus.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
const uuid = (value) => {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

if (process.env.M5C_REAL_EVALUATION !== "qa-metrics") throw new Error("real M5C QA metrics require M5C_REAL_EVALUATION=qa-metrics");
const requestedDirection = process.env.M5C_QA_DIRECTION;
const singleCaseMode = process.env.M5C_QA_SINGLE_CASES === "1";
const directions = [...new Set(m5cQaEvaluationCorpus.map((item) => item.direction))];
if (requestedDirection !== undefined && !directions.includes(requestedDirection)) throw new Error("M5C_QA_DIRECTION is invalid");
const evaluationCorpus = requestedDirection === undefined
  ? m5cQaEvaluationCorpus : m5cQaEvaluationCorpus.filter((item) => item.direction === requestedDirection);

let credential;
try {
  credential = await openCredentialFile("/run/secrets/deepseek");
  const predictions = new Map(); const unknownCases = []; const usage = { calls: 0, inputTokens: 0, outputTokens: 0, costMicrosCny: 0 };
  const batches = singleCaseMode ? evaluationCorpus.map((item) => [item])
    : [...new Set(evaluationCorpus.map((item) => item.direction))].map((direction) => evaluationCorpus.filter((item) => item.direction === direction));
  for (const cases of batches) {
    const direction = cases[0].direction; const targetLanguage = direction.split("->")[1];
    const segmentToCase = new Map(cases.map((item) => [uuid(item.id), item.id]));
    for (const item of cases) predictions.set(item.id, []);
    try {
      const batchId = cases.map((item) => item.id).join(":");
      const response = await invokeM5CModelBroker({ credentialFd: credential.fd, request: { role: "qa", modelId: "deepseek-v4-flash", maxOutputTokens: 4_096,
        request: { schemaVersion: "m5c-model-qa-request-v1", workflowId: uuid(`workflow:${batchId}`),
          sourceRevisionId: uuid(`source:${batchId}`), targetLanguage, workingCopyDigest: sha(`working-copy:${batchId}`), scope: "full",
          segments: cases.map((item) => ({ segmentId: uuid(item.id), sourceText: item.source, targetText: item.target, targetDigest: sha(item.target) })) } } },
      { timeoutMs: 60_000 });
      for (const finding of response.findings) predictions.get(segmentToCase.get(finding.segmentId)).push(finding.code);
      for (const key of Object.keys(usage)) usage[key] += response.usage[key];
    } catch (error) {
      unknownCases.push(...cases.map((item) => ({ id: item.id, category: error?.category ?? "evaluation" })));
    }
  }
  let truePositive = 0; let falsePositive = 0; let falseNegative = 0; let trueNegative = 0;
  const falsePositiveCases = []; const criticalEscapes = [];
  for (const item of evaluationCorpus) {
    if (unknownCases.some((unknown) => unknown.id === item.id)) {
      if (item.labels.length > 0) { falseNegative += 1; criticalEscapes.push(item.id); }
      continue;
    }
    const expectedDefect = item.labels.length > 0; const predictedDefect = predictions.get(item.id).length > 0;
    if (expectedDefect && predictedDefect) truePositive += 1;
    else if (!expectedDefect && predictedDefect) { falsePositive += 1; falsePositiveCases.push(item.id); }
    else if (expectedDefect) { falseNegative += 1; criticalEscapes.push(item.id); }
    else trueNegative += 1;
  }
  const precision = truePositive / (truePositive + falsePositive); const recall = truePositive / (truePositive + falseNegative);
  process.stdout.write(`${JSON.stringify({ schemaVersion: "m5c-real-model-qa-metrics-v1", status: "completed", model: "deepseek-v4-flash",
    dataClass: "public-synthetic", direction: requestedDirection ?? "all", mode: singleCaseMode ? "single-case" : "direction-batch",
    corpusDigest: sha(JSON.stringify(evaluationCorpus)), cases: evaluationCorpus.length, completedCases: evaluationCorpus.length - unknownCases.length,
    confusion: { truePositive, falsePositive, falseNegative, trueNegative }, precision, recall, falsePositiveCases, criticalEscapes,
    unknownCases, attemptedCalls: batches.length, conservativeProviderCalls: batches.length,
    usage, unknownCallCostAccounting: "bounded-by-preflight-reservation", rawResponsesRetained: false })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: "failed", direction: requestedDirection ?? "all", category: error?.category ?? "evaluation",
    providerCode: typeof error?.providerCode === "string" ? error.providerCode : null })}\n`); process.exitCode = 1;
} finally { await credential?.close(); }
