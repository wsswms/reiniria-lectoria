import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  documentSegmentContract,
  sourceSegmentVersionContract,
  translationWorkflowContract,
} from "../../src/domain/contracts.mjs";

const sha = (digit) => `sha256:${digit.repeat(64)}`;

function ids() {
  return {
    workspaceId: randomUUID(),
    documentId: randomUUID(),
    sourceRevisionId: randomUUID(),
    segmentId: randomUUID(),
    workflowId: randomUUID(),
  };
}

test("stable segment identity is separate from source revision content", () => {
  const value = ids();
  const stable = documentSegmentContract(value);
  const version = sourceSegmentVersionContract({
    ...value,
    kind: "paragraph",
    structuralPath: "/children/0",
    sourceText: "Source",
    sourceDigest: sha("a"),
    ordinal: 0,
    translatable: true,
    protected: [{ kind: "link-target", value: "https://example.invalid" }],
    alignmentStatus: "inserted",
  });

  assert.deepEqual(stable, {
    workspaceId: value.workspaceId,
    documentId: value.documentId,
    segmentId: value.segmentId,
  });
  assert.equal("sourceRevisionId" in stable, false);
  assert.equal(version.segmentId, stable.segmentId);
  assert.equal(version.sourceRevisionId, value.sourceRevisionId);
  assert.equal(Object.isFrozen(stable), true);
  assert.equal(Object.isFrozen(version), true);
  assert.equal(Object.isFrozen(version.protected), true);
  assert.equal(Object.isFrozen(version.protected[0]), true);
});

test("translation workflow is fixed to document revision and canonical target language", () => {
  const value = ids();
  const workflow = translationWorkflowContract({ ...value, targetLanguage: "ZH-hans-cn" });
  assert.deepEqual(workflow, {
    workspaceId: value.workspaceId,
    workflowId: value.workflowId,
    documentId: value.documentId,
    sourceRevisionId: value.sourceRevisionId,
    targetLanguage: "zh-Hans-CN",
  });
  assert.equal(translationWorkflowContract({ ...value, targetLanguage: "und" }).targetLanguage, "und");
  assert.equal(Object.isFrozen(workflow), true);
});

test("M3.1 contracts reject malformed identity, revision content and language", () => {
  const value = ids();
  assert.throws(() => documentSegmentContract({ ...value, segmentId: "segment-1" }), /segmentId/);
  assert.throws(() => sourceSegmentVersionContract({
    ...value,
    kind: "paragraph",
    structuralPath: "/0",
    sourceText: "Source",
    sourceDigest: sha("a"),
    ordinal: -1,
    translatable: true,
    protected: [],
    alignmentStatus: "inserted",
  }), /ordinal/);
  assert.throws(() => sourceSegmentVersionContract({
    ...value,
    kind: "paragraph",
    structuralPath: "/0",
    sourceText: "Source",
    sourceDigest: sha("a"),
    ordinal: 0,
    translatable: true,
    protected: [],
    alignmentStatus: "guessed",
  }), /alignmentStatus/);
  assert.throws(() => translationWorkflowContract({ ...value, targetLanguage: "not a language" }), /targetLanguage/);
});
