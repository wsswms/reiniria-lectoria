import assert from "node:assert/strict";
import test from "node:test";
import { researchCaseContract } from "../../src/research/deepseek-server-research-contracts.mjs";

const valid = {
  schemaVersion: "deepseek-server-research-case-v1",
  caseId: "case-penultimate",
  question: "What is the precise Chinese translation of penultimate in this sentence?",
  responseLanguage: "zh-CN",
  maxOutputTokens: 6000,
  reasoningEffort: "medium",
};

test("research case contract is exact bounded and immutable", () => {
  const value = researchCaseContract(valid);
  assert.deepEqual(value, valid);
  assert.equal(Object.isFrozen(value), true);
  for (const mutation of [
    { ...valid, schemaVersion: "v2" },
    { ...valid, extra: true },
    { ...valid, question: "" },
    { ...valid, question: "x".repeat(8193) },
    { ...valid, responseLanguage: "not a language" },
    { ...valid, maxOutputTokens: 511 },
    { ...valid, maxOutputTokens: 12001 },
    { ...valid, reasoningEffort: "extreme" },
  ]) assert.throws(() => researchCaseContract(mutation), TypeError);
});
