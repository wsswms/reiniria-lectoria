import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspaceDatabase } from "../../src/db/connection.mjs";
import { DomainStateService } from "../../src/domain/state-service.mjs";
import { TranslationTaskOrchestrator } from "../../src/provider/task-orchestrator.mjs";

export const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m4-3-"));
  const workspaceId = randomUUID();
  const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId });
  let milliseconds = 0;
  const clock = {
    now: () => new Date(milliseconds),
    advance: (amount) => { milliseconds += amount; },
  };
  const fixture = { root, workspaceId, database, clock };
  fixture.close = async () => { fixture.database.close(); await rm(root, { recursive: true, force: true }); };
  return fixture;
}

export function seedWorkflow(fixture) {
  const documentId = randomUUID();
  const sourceRevisionId = randomUUID();
  const segmentId = randomUUID();
  const workflowId = randomUUID();
  const timestamp = fixture.clock.now().toISOString();
  fixture.database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)").run(fixture.workspaceId, documentId, "M4.3", timestamp);
  fixture.database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)").run(fixture.workspaceId, sourceRevisionId, documentId, sha("original"), sha("normalized"), timestamp);
  fixture.database.prepare("INSERT INTO document_segments VALUES (?, ?, ?, ?)").run(fixture.workspaceId, documentId, segmentId, timestamp);
  fixture.database.prepare("INSERT INTO source_segment_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(fixture.workspaceId, documentId, sourceRevisionId, segmentId, "paragraph", "/0", "source", sha("source"), 0, 1, "[]", "initial");
  new DomainStateService(fixture.database, fixture.workspaceId, { now: fixture.clock.now }).create({ workflowId, documentId, sourceRevisionId, targetLanguage: "zh-CN" }, {}, "source-confirmed");
  return { workflowId, documentId, sourceRevisionId, segmentId, targetLanguage: "zh-CN" };
}

export function enqueueInput(workflow, suffix = randomUUID(), overrides = {}) {
  return {
    ...workflow,
    segmentIds: [workflow.segmentId],
    idempotencyKey: `enqueue-${suffix}`,
    requestDigest: sha(`request-${suffix}`),
    policyVersion: "policy-v1",
    providerId: "fake-primary",
    modelId: "fixture-model-v1",
    promptVersion: "prompt-v1",
    contextDigest: sha(`context-${suffix}`),
    maxAttempts: 3,
    batchSize: 1,
    ...overrides,
  };
}

export function orchestrator(fixture, options = {}) {
  return new TranslationTaskOrchestrator(fixture.database, fixture.workspaceId, { now: fixture.clock.now, ...options });
}
