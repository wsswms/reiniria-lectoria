import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stableJson } from "../domain/contracts.mjs";

export async function rebuildDerived(root, database, trustedWorkspaceId) {
  const directory = join(root, "derived");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const documents = database.prepare("SELECT document_id AS documentId, title FROM documents WHERE workspace_id = ? ORDER BY document_id").all(trustedWorkspaceId);
  const segments = database.prepare("SELECT segment_id AS segmentId, source_digest AS sourceDigest FROM segments WHERE workspace_id = ? ORDER BY segment_id").all(trustedWorkspaceId);
  const output = `${stableJson({ format: "derived-index-v1", documents, segments })}\n`;
  await writeFile(join(directory, "index.json"), output, { mode: 0o600, flag: "wx" });
  return output;
}
