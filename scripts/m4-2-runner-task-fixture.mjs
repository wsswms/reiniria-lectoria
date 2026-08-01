import { createHash, randomUUID } from "node:crypto";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
process.stdout.write(JSON.stringify({
  schemaVersion: "runner-task-v1",
  request: {
    workspaceId: randomUUID(),
    taskId: randomUUID(),
    attemptId: randomUUID(),
    workflowId: randomUUID(),
    sourceRevisionId: randomUUID(),
    targetLanguage: "ja",
    providerId: "fake-primary",
    modelId: "fixture-model-v1",
    promptVersion: "prompt-v1",
    contextDigest: sha("m4-2-context"),
    segments: [{ segmentId: randomUUID(), sourceDigest: sha("m4-2-source"), sourceText: "Public runner fixture", protected: [] }],
  },
  capability: { token: "fixture.signed-capability" },
  limits: { inputBytes: 65536, outputBytes: 65536, toolCalls: 2, runtimeMs: 5000 },
}));
