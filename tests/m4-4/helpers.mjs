import { RESPONSE_VERSION, buildContextManifest } from "../../src/provider/prompt-context.mjs";
import { enqueueInput, orchestrator, seedWorkflow, workspace } from "../m4-3/helpers.mjs";

export { orchestrator, seedWorkflow, workspace };

export function responseFor(context, transform = (segment) => `${context.manifest.targetLanguage}:${segment.sourceText}`) {
  return {
    schemaVersion: RESPONSE_VERSION,
    workflowId: context.manifest.workflowId,
    sourceRevisionId: context.manifest.sourceRevisionId,
    targetLanguage: context.manifest.targetLanguage,
    candidates: context.manifest.segments.map((segment) => ({
      segmentId: segment.segmentId,
      structuralPath: segment.structuralPath,
      kind: segment.kind,
      text: transform(segment),
    })),
  };
}

export function enqueueWithContext(fixture, workflow, suffix) {
  const context = buildContextManifest(fixture.database, fixture.workspaceId, {
    workflowId: workflow.workflowId,
    segmentIds: [workflow.segmentId],
  });
  const task = orchestrator(fixture).enqueue(enqueueInput(workflow, suffix, {
    promptVersion: context.manifest.promptVersion,
    contextDigest: context.contextDigest,
  }));
  return { context, task };
}
