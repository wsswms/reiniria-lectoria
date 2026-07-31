import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspaceDatabase } from "../src/db/connection.mjs";
import { encodeCanonicalPackage, decodeCanonicalPackage } from "../src/domain/canonical.mjs";
import { DomainStateService, StateConflictError } from "../src/domain/state-service.mjs";

const canonical = { schema_version: "1.0", package_type: "source_document", package_id: randomUUID(), created_at: new Date(0).toISOString(), origin: { adapter: "fixture", source_digest: `sha256:${"0".repeat(64)}` }, document: { title: "Fixture", source_language: "zh-CN", metadata: {}, segments: [{ segment_ref: "s0", order: 0, kind: "paragraph", source: "fixture", protected: [] }] } };
let canonicalPassed = 0;
for (let index = 0; index < 24; index += 1) {
  canonical.package_id = randomUUID();
  const encoded = encodeCanonicalPackage(canonical);
  if (encodeCanonicalPackage(decodeCanonicalPackage(encoded)) === encoded) canonicalPassed += 1;
}

const root = await mkdtemp(join(tmpdir(), "lectoria-m2-3-measure-"));
const workspaceId = randomUUID();
const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId });
let concurrentSuccess = 0;
let concurrentConflict = 0;
let idempotentExecutions = 0;
try {
  const documentId = randomUUID();
  database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)").run(workspaceId, documentId, "Fixture", new Date(0).toISOString());
  const service = new DomainStateService(database, workspaceId);
  service.create(documentId, {}, "editing");
  for (let index = 0; index < 100; index += 1) {
    try { service.updateContent(documentId, 0, { index }, { type: "user", id: "measure" }); concurrentSuccess += 1; }
    catch (error) { if (error instanceof StateConflictError) concurrentConflict += 1; }
  }
  for (let index = 0; index < 100; index += 1) service.executeIdempotent("measure", "same-key", { same: true }, () => ({ id: ++idempotentExecutions }));
  process.stdout.write(`${JSON.stringify({ stage: "M2.3", node: process.version, platform: process.platform, arch: process.arch, canonical_attempts: 24, canonical_passed: canonicalPassed, concurrent_attempts: 100, concurrent_success: concurrentSuccess, concurrent_conflicts: concurrentConflict, idempotent_attempts: 100, idempotent_business_results: idempotentExecutions }, null, 2)}\n`);
} finally {
  database.close();
  await rm(root, { recursive: true, force: true });
}
