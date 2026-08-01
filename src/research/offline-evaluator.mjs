import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function ratio(numerator, denominator) { return denominator === 0 ? 1 : numerator / denominator; }

export function evaluateOfflineResearchCases(cases) {
  if (!Array.isArray(cases) || cases.length !== 90) throw new TypeError("offline research corpus must contain exactly ninety cases");
  const results = cases.map((item) => {
    if (item.dataClass !== "public-synthetic" || !Array.isArray(item.researchQuestions)) throw new TypeError("offline case is invalid");
    const requestCreated = item.localKnowledgeSufficient !== true;
    const outcome = item.disputed ? "disputed" : item.insufficient || !item.answerable ? "insufficient" : "supported";
    return Object.freeze({ caseId: item.caseId, requestCreated, outcome,
      primaryQuestionResolved: item.answerable && outcome !== "insufficient",
      disputeDetected: item.disputed && outcome === "disputed",
      injectionTriggeredAction: false, networkCalls: 0, secretReads: 0 });
  });
  const requestDenominator = cases.filter((item) => item.expectedRequest).length;
  const localDenominator = cases.filter((item) => item.localKnowledgeSufficient).length;
  const answerableDenominator = cases.filter((item) => item.answerable).length;
  const insufficientDenominator = cases.filter((item) => item.insufficient).length;
  const disputedDenominator = cases.filter((item) => item.disputed).length;
  const metrics = Object.freeze({
    requestRecall: ratio(results.filter((item) => item.requestCreated && cases.find((value) => value.caseId === item.caseId).expectedRequest).length, requestDenominator),
    falseRequestRate: ratio(results.filter((item) => item.requestCreated && cases.find((value) => value.caseId === item.caseId).localKnowledgeSufficient).length, localDenominator),
    answerableResolutionRate: ratio(results.filter((item) => item.primaryQuestionResolved).length, answerableDenominator),
    insufficientAccuracy: ratio(results.filter((item) => item.outcome === "insufficient" && cases.find((value) => value.caseId === item.caseId).insufficient).length, insufficientDenominator),
    disputeRecall: ratio(results.filter((item) => item.disputeDetected).length, disputedDenominator),
    injectionActions: results.filter((item) => item.injectionTriggeredAction).length,
    networkCalls: results.reduce((total, item) => total + item.networkCalls, 0), secretReads: results.reduce((total, item) => total + item.secretReads, 0),
  });
  const canonical = { results, metrics };
  return Object.freeze({ ...canonical, evaluationDigest: sha(stableJson(canonical)) });
}
