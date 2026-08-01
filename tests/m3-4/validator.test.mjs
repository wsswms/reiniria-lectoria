import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { validateTranslationInput } from "../../src/translation/validator.mjs";

const ids = [randomUUID(), randomUUID(), randomUUID()];
const marker = "⟦LCT-P-0000-0123456789abcdef⟧";
const workflow = Object.freeze({ workflowId: randomUUID(), sourceRevisionId: randomUUID(), targetLanguage: "fr" });
const sourceSegments = Object.freeze([
  { segmentId: ids[0], kind: "heading", structuralPath: "/0", sourceText: "Guide", protected: [] },
  { segmentId: ids[1], kind: "paragraph", structuralPath: "/1", sourceText: `Pay 20 kg on 2026-01-02 ${marker}`, protected: [{ marker }] },
  { segmentId: ids[2], kind: "paragraph", structuralPath: "/2", sourceText: "Finish", protected: [] },
]);

const valid = () => sourceSegments.map((source) => ({
  workflowId: workflow.workflowId,
  sourceRevisionId: workflow.sourceRevisionId,
  targetLanguage: workflow.targetLanguage,
  segmentId: source.segmentId,
  kind: source.kind,
  structuralPath: source.structuralPath,
  text: source.sourceText,
}));

test("one hundred twenty identity, scope, structure and protection mutations are errors", () => {
  const mutations = [
    (items) => { items[0].segmentId = randomUUID(); },
    (items) => { items.push({ ...items[0] }); },
    (items) => { items.pop(); },
    (items) => { items[0].workflowId = randomUUID(); },
    (items) => { items[0].sourceRevisionId = randomUUID(); },
    (items) => { items[0].targetLanguage = "de"; },
    (items) => { items[0].structuralPath = "/wrong"; },
    (items) => { items[0].kind = "paragraph"; },
    (items) => { items[0].text = ""; },
    (items) => { items[0].text = "   "; },
    (items) => { items[1].text = items[1].text.replace(marker, ""); },
    (items) => { items[1].text += marker; },
  ];
  let total = 0;
  for (let round = 0; round < 10; round += 1) for (const mutate of mutations) {
    const items = valid().map((item) => ({ ...item }));
    mutate(items);
    const findings = validateTranslationInput({ workflow, sourceSegments, translations: items });
    assert.ok(findings.some((item) => item.severity === "error"), `round ${round}, mutation ${total}`);
    total += 1;
  }
  assert.equal(total, 120);
});

test("numbers, dates and units are warnings while unchanged text is informational", () => {
  const items = valid();
  items[1].text = `Payer demain ${marker}`;
  const findings = validateTranslationInput({ workflow, sourceSegments, translations: items });
  assert.deepEqual(new Set(findings.filter((item) => item.severity === "warning").map((item) => item.code)), new Set([
    "DATE_VALUE_CHANGED", "UNIT_VALUE_CHANGED", "NUMBER_VALUE_CHANGED",
  ]));
  assert.ok(findings.some((item) => item.severity === "info" && item.code === "TARGET_EQUALS_SOURCE"));
});
