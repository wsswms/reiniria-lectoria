import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeCanonicalPackage, encodeCanonicalPackage, importCanonicalPackage } from "../../src/domain/canonical.mjs";
import { openWorkspaceDatabase } from "../../src/db/connection.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function fixture(index, packageType = index % 2 === 0 ? "source_document" : "translation_bundle") {
  const segments = Array.from({ length: 1 + (index % 4) }, (_, order) => ({
    segment_ref: `segment-${index}-${order}`,
    order,
    kind: order === 0 ? "heading" : "paragraph",
    source: `Source ${index}/${order}`,
    protected: [{ kind: "placeholder", value: `{${order}}` }],
    ...(packageType === "translation_bundle" ? { target: { language: "en", text: `Target ${index}/${order}`, review_status: "candidate-valid" } } : {}),
    optional_segment_field: { retained: true },
  }));
  return {
    schema_version: "1.0",
    package_type: packageType,
    package_id: randomUUID(),
    created_at: new Date(index * 1000).toISOString(),
    origin: { adapter: "fixture", source_uri: `fixture:${index}`, source_digest: sha(`source-${index}`) },
    document: { title: `Document ${index}`, source_language: "zh-CN", metadata: { index }, segments },
    optional_top_level: { retained: index },
  };
}

test("canonical JSON schema artifact is versioned and parseable", async () => {
  const schema = JSON.parse(await readFile("schemas/canonical-package-v1.schema.json", "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.match(schema.properties.schema_version.pattern, /^\^1/);
});

test("twenty-four canonical fixtures round-trip deterministically and retain optional fields", () => {
  for (let index = 0; index < 24; index += 1) {
    const encoded = encodeCanonicalPackage(fixture(index));
    const decoded = decodeCanonicalPackage(encoded);
    assert.equal(encodeCanonicalPackage(decoded), encoded);
    assert.equal(decoded.optional_top_level.retained, index);
    assert.equal(decoded.document.segments[0].optional_segment_field.retained, true);
  }
});

test("invalid versions, digests and segment structures are rejected", () => {
  const valid = fixture(1);
  assert.throws(() => encodeCanonicalPackage({ ...valid, schema_version: "2.0" }), /unsupported/);
  assert.throws(() => encodeCanonicalPackage({ ...valid, document: { ...valid.document, segments: [] } }), /segments/);
  assert.throws(() => encodeCanonicalPackage({ ...valid, document: { ...valid.document, segments: [{ ...valid.document.segments[0], segment_ref: "" }] } }), /reference/);
  assert.throws(() => encodeCanonicalPackage({ ...valid, document: { ...valid.document, segments: [valid.document.segments[0], { ...valid.document.segments[0] }] } }), /duplicate/);
  assert.throws(() => encodeCanonicalPackage({ ...valid, document: { ...valid.document, segments: [{ ...valid.document.segments[0], order: -1 }] } }), /order/);
  const encoded = encodeCanonicalPackage(valid);
  const tampered = JSON.parse(encoded);
  tampered.document.segments[0].source = "tampered";
  assert.throws(() => decodeCanonicalPackage(JSON.stringify(tampered)), /digest mismatch/);
  const injected = JSON.parse(encoded);
  injected.provider_request = "secret-canary";
  assert.throws(() => decodeCanonicalPackage(JSON.stringify(injected)), /digest mismatch/);
});

test("forbidden provider, ledger and secret fields never enter exports", () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = fixture(attempt);
    value.secrets = { api_key: `secret-${attempt}` };
    value.ledger = { raw_request: `request-${attempt}` };
    value.document.provider_response = `response-${attempt}`;
    value.document.segments[0].provider_payload = `payload-${attempt}`;
    const encoded = encodeCanonicalPackage(value);
    assert.equal(encoded.includes(`secret-${attempt}`), false);
    assert.equal(encoded.includes(`request-${attempt}`), false);
    assert.equal(encoded.includes(`response-${attempt}`), false);
    assert.equal(encoded.includes(`payload-${attempt}`), false);
  }
});

test("cross-workspace imports reassign every internal identity and retain origin refs", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m2-3-import-"));
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const first = openWorkspaceDatabase(join(root, "a.sqlite3"), { workspaceId: workspaceA });
  const second = openWorkspaceDatabase(join(root, "b.sqlite3"), { workspaceId: workspaceB });
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = fixture(attempt + 100);
      const encoded = encodeCanonicalPackage(value);
      const importedA = importCanonicalPackage(first, workspaceA, encoded);
      const importedB = importCanonicalPackage(second, workspaceB, encoded);
      assert.notEqual(importedA.documentId, importedB.documentId);
      assert.notEqual(importedA.sourceRevisionId, importedB.sourceRevisionId);
      assert.equal(importedA.segmentIds.some((id) => importedB.segmentIds.includes(id)), false);
      for (const [database, imported] of [[first, importedA], [second, importedB]]) {
        const origins = database.prepare("SELECT origin_package_id AS packageId, origin_segment_ref AS segmentRef FROM canonical_import_origins WHERE source_revision_id = ? ORDER BY origin_segment_ref").all(imported.sourceRevisionId);
        assert.equal(origins.length, value.document.segments.length);
        assert.ok(origins.every((origin) => origin.packageId === value.package_id));
      }
    }
  } finally {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});
