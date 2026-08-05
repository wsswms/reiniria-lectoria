import { createHash, randomUUID } from "node:crypto";
import { openWorkspaceDatabase } from "../../src/db/connection.mjs";

export const timestamp = new Date(0).toISOString();
export const sha = (value) => `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;

export function setup(filename) {
  const workspaceId = randomUUID(); const database = openWorkspaceDatabase(filename, { workspaceId, now: () => new Date(0) });
  const documentId = randomUUID(); const sourceRevisionId = randomUUID(); const importId = randomUUID(); const objectId = randomUUID();
  database.prepare("INSERT INTO documents VALUES (?, ?, 'M5C fixture', ?)").run(workspaceId, documentId, timestamp);
  database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)").run(workspaceId, sourceRevisionId, documentId, sha("raw"), sha("normalized"), timestamp);
  database.prepare("INSERT INTO committed_objects VALUES (?, ?, ?, 1, 'private/raw', ?)").run(workspaceId, objectId, sha("raw"), timestamp);
  database.prepare("INSERT INTO document_imports VALUES (?, ?, ?, ?, 'text', ?, ?, 'Nikon 3枚 lens is not 2组. 2026年8月3日', ?, '[]', ?, 'parser-v1', 'sanitizer-v1', 0, ?)")
    .run(workspaceId, importId, documentId, sourceRevisionId, objectId, sha("raw"), sha("normalized"), sha("projection"), timestamp);
  database.prepare("INSERT INTO import_confirmations VALUES (?, ?, 'user', 'fixture-user', ?)").run(workspaceId, importId, timestamp);
  for (const [ordinal, text] of [[0, "Nikon 3枚 lens is not 2组."], [1, "2026年8月3日"]]) {
    const segmentId = randomUUID(); database.prepare("INSERT INTO document_segments VALUES (?, ?, ?, ?)").run(workspaceId, documentId, segmentId, timestamp);
    database.prepare("INSERT INTO source_segment_versions VALUES (?, ?, ?, ?, 'paragraph', ?, ?, ?, ?, 1, '[]', 'initial')")
      .run(workspaceId, documentId, sourceRevisionId, segmentId, `/${ordinal}`, text, sha(text), ordinal);
  }
  return { database, workspaceId, documentId, sourceRevisionId, importId, workflowId: randomUUID() };
}
