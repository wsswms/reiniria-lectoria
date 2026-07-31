import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openWorkspaceDatabase } from "../../src/db/connection.mjs";
import { DomainStateService } from "../../src/domain/state-service.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const timestamp = new Date(0).toISOString();

function insertDocument(database, workspaceId, title) {
  const documentId = randomUUID();
  const sourceRevisionId = randomUUID();
  database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)").run(workspaceId, documentId, title, timestamp);
  database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)")
    .run(workspaceId, sourceRevisionId, documentId, sha(`${title}-o`), sha(`${title}-n`), timestamp);
  return { documentId, sourceRevisionId };
}

function insertSegment(database, workspaceId, documentId, sourceRevisionId, segmentId = randomUUID(), ordinal = 0, path = `/${ordinal}`) {
  database.prepare("INSERT OR IGNORE INTO document_segments VALUES (?, ?, ?, ?)")
    .run(workspaceId, documentId, segmentId, timestamp);
  database.prepare("INSERT INTO source_segment_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(workspaceId, documentId, sourceRevisionId, segmentId, "paragraph", path, "source", sha(`${sourceRevisionId}-${segmentId}`), ordinal, 1, "[]", "initial");
  return segmentId;
}

test("stable segments span revisions while forged composite relationships are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m3-1-relations-"));
  const workspaceId = randomUUID();
  const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId });
  try {
    const first = insertDocument(database, workspaceId, "First");
    const second = insertDocument(database, workspaceId, "Second");
    const nextRevisionId = randomUUID();
    database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)")
      .run(workspaceId, nextRevisionId, first.documentId, sha("next-o"), sha("next-n"), timestamp);
    const stableSegmentId = insertSegment(database, workspaceId, first.documentId, first.sourceRevisionId);
    insertSegment(database, workspaceId, first.documentId, nextRevisionId, stableSegmentId);
    assert.equal(database.prepare("SELECT count(*) AS total FROM source_segment_versions WHERE segment_id = ?").get(stableSegmentId).total, 2);

    const service = new DomainStateService(database, workspaceId);
    const workflowId = randomUUID();
    const frenchWorkflowId = randomUUID();
    service.create({ workflowId, documentId: first.documentId, sourceRevisionId: first.sourceRevisionId, targetLanguage: "en" });
    service.create({ workflowId: frenchWorkflowId, documentId: first.documentId, sourceRevisionId: first.sourceRevisionId, targetLanguage: "fr" });

    let rejected = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      assert.throws(() => database.prepare("INSERT INTO document_segments VALUES (?, ?, ?, ?)")
        .run(randomUUID(), first.documentId, randomUUID(), timestamp), /FOREIGN KEY/);
      rejected += 1;
      assert.throws(() => database.prepare("INSERT INTO source_segment_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(workspaceId, second.documentId, first.sourceRevisionId, randomUUID(), "p", `/cross-${attempt}`, "x", sha(`cross-${attempt}`), attempt + 10, 1, "[]", "initial"), /FOREIGN KEY/);
      rejected += 1;
      assert.throws(() => database.prepare("INSERT INTO source_segment_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(workspaceId, first.documentId, first.sourceRevisionId, randomUUID(), "p", `/duplicate-ordinal-${attempt}`, "x", sha(`ordinal-${attempt}`), 0, 1, "[]", "initial"), /FOREIGN KEY|UNIQUE/);
      rejected += 1;
      assert.throws(() => database.prepare(`
        INSERT INTO translation_workflows VALUES (?, ?, ?, ?, ?, 0, 'imported', '{}', 'native', ?)
      `).run(workspaceId, randomUUID(), second.documentId, first.sourceRevisionId, `x-${attempt}`, timestamp), /FOREIGN KEY/);
      rejected += 1;
      assert.throws(() => database.prepare(`
        INSERT INTO translation_workflows VALUES (?, ?, ?, ?, 'en', 0, 'imported', '{}', 'native', ?)
      `).run(workspaceId, randomUUID(), first.documentId, first.sourceRevisionId, timestamp), /UNIQUE/);
      rejected += 1;
      assert.throws(() => database.prepare(`
        INSERT INTO translation_candidates VALUES (?, ?, ?, ?, ?, ?, ?, 'user', 'x', ?, ?)
      `).run(workspaceId, randomUUID(), workflowId, first.documentId, nextRevisionId, "en", stableSegmentId, sha("x"), timestamp), /FOREIGN KEY/);
      rejected += 1;
      assert.throws(() => database.prepare(`
        INSERT INTO translation_candidates VALUES (?, ?, ?, ?, ?, ?, ?, 'user', 'x', ?, ?)
      `).run(workspaceId, randomUUID(), workflowId, first.documentId, first.sourceRevisionId, "fr", stableSegmentId, sha("x"), timestamp), /FOREIGN KEY/);
      rejected += 1;
    }
    assert.equal(rejected, 700);
    assert.equal(database.prepare("SELECT count(*) AS total FROM translation_workflows").get().total, 2);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("immutable workflow facts reject update and delete", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m3-1-immutable-"));
  const workspaceId = randomUUID();
  const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId });
  try {
    const { documentId, sourceRevisionId } = insertDocument(database, workspaceId, "Immutable");
    const segmentId = insertSegment(database, workspaceId, documentId, sourceRevisionId);
    assert.throws(() => database.prepare("UPDATE document_segments SET created_at = ?").run(new Date(1).toISOString()), /immutable/);
    assert.throws(() => database.prepare("DELETE FROM source_segment_versions WHERE segment_id = ?").run(segmentId), /immutable/);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
