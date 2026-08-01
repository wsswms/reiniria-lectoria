import assert from "node:assert/strict";
import test from "node:test";
import { cases, corpusDigest, directions, manifest } from "../fixtures/m5r-1/corpus.mjs";

test("the fixed offline evaluation corpus contains ninety fully labeled public-synthetic cases", () => {
  assert.equal(cases.length, 90);
  assert.match(corpusDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(manifest.caseCount, 90);
  assert.equal(manifest.corpusDigest, corpusDigest);
  assert.equal(new Set(cases.map((item) => item.caseId)).size, 90);
  assert.deepEqual([...new Set(cases.map((item) => item.dataClass))], ["public-synthetic"]);
  assert.equal(JSON.stringify(cases).includes("secret"), false);
  assert.equal(JSON.stringify(cases).includes(".project-private"), false);
});

test("each translation direction has fifteen cases and all fixed coverage floors are met", () => {
  for (const direction of directions) assert.equal(cases.filter((item) => item.direction === direction).length, 15);
  for (const gapKind of ["term", "proper-name", "background-fact", "translation-rationale"])
    assert.ok(cases.filter((item) => item.gapKind === gapKind).length >= 20, gapKind);
  assert.ok(cases.filter((item) => item.temporal).length >= 15);
  assert.ok(cases.filter((item) => item.disputed).length >= 15);
  assert.ok(cases.filter((item) => item.insufficient).length >= 10);
  assert.ok(cases.filter((item) => item.adversarial).length >= 20);
  assert.deepEqual([...new Set(cases.map((item) => item.format))].sort(), ["html", "markdown", "text"]);
});

test("gold labels enforce source, claim, disagreement and insufficient-evidence policy", () => {
  for (const item of cases) {
    assert.ok(item.researchQuestions.length > 0);
    if (item.expectedOutcome === "supported") {
      assert.ok(item.sourceClusters.length >= 1);
      assert.ok(item.expectedSourceTiers.includes("S1") || item.expectedSourceTiers.includes("S2"));
      if (item.sourceClusters.length === 1) assert.deepEqual(item.sourceClusters, ["official-primary"]);
    }
    if (item.disputed) assert.equal(item.expectedClaimLevel, "CD");
    if (item.insufficient) assert.equal(item.expectedClaimLevel, "C0");
    if (item.adversarial) assert.match(item.injectionPayload, /approve.*automatically/i);
  }
});
