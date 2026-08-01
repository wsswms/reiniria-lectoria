import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { assertDatabaseIntegrity, openWorkspaceDatabase } from "../../src/db/connection.mjs";
import { applyMigrations, CURRENT_SCHEMA_VERSION, MIGRATIONS, migrationChecksum } from "../../src/db/migrations.mjs";
import { DomainStateService } from "../../src/domain/state-service.mjs";
import { M4FoundationStore } from "../../src/provider/foundation-store.mjs";

const timestamp = new Date(0).toISOString();
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function createV10(filename) {
  const workspaceId = randomUUID();
  const database = new Database(filename);
  database.pragma("foreign_keys = ON");
  database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;");
  for (const migration of MIGRATIONS.filter((item) => item.version <= 10)) {
    database.exec(migration.sql);
    database.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)").run(migration.version, migration.name, migrationChecksum(migration), timestamp);
    database.pragma(`user_version = ${migration.version}`);
  }
  database.prepare("INSERT INTO workspace_meta VALUES (1, ?, ?)").run(workspaceId, timestamp);
  return { database, workspaceId };
}

function seedWorkflow(database, workspaceId) {
  const documentId = randomUUID();
  const sourceRevisionId = randomUUID();
  const segmentId = randomUUID();
  const workflowId = randomUUID();
  database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)").run(workspaceId, documentId, "M4", timestamp);
  database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)").run(workspaceId, sourceRevisionId, documentId, sha("o"), sha("n"), timestamp);
  database.prepare("INSERT INTO document_segments VALUES (?, ?, ?, ?)").run(workspaceId, documentId, segmentId, timestamp);
  database.prepare("INSERT INTO source_segment_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(workspaceId, documentId, sourceRevisionId, segmentId, "paragraph", "/0", "source", sha("source"), 0, 1, "[]", "initial");
  new DomainStateService(database, workspaceId).create({ workflowId, documentId, sourceRevisionId, targetLanguage: "zh-CN" });
  return { documentId, sourceRevisionId, segmentId, workflowId, targetLanguage: "zh-CN" };
}

function createAtVersion(filename, version) {
  const workspaceId = randomUUID();
  const documentId = randomUUID();
  const database = new Database(filename);
  database.pragma("foreign_keys = ON");
  database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;");
  for (const migration of MIGRATIONS.filter((item) => item.version <= version)) {
    if (migration.foreignKeysOff) database.pragma("foreign_keys = OFF");
    database.exec(migration.sql);
    if (migration.foreignKeysOff) database.pragma("foreign_keys = ON");
    database.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)").run(migration.version, migration.name, migrationChecksum(migration), timestamp);
    database.pragma(`user_version = ${migration.version}`);
  }
  database.prepare("INSERT INTO workspace_meta VALUES (1, ?, ?)").run(workspaceId, timestamp);
  database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)").run(workspaceId, documentId, `historical-v${version}`, timestamp);

  let m3Facts;
  if (version >= 6) {
    const sourceRevisionId = randomUUID();
    const segmentId = randomUUID();
    const workflowId = randomUUID();
    database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)").run(workspaceId, sourceRevisionId, documentId, sha("original"), sha("normalized"), timestamp);
    database.prepare("INSERT INTO document_segments VALUES (?, ?, ?, ?)").run(workspaceId, documentId, segmentId, timestamp);
    database.prepare("INSERT INTO source_segment_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(workspaceId, documentId, sourceRevisionId, segmentId, "paragraph", "/0", "historical source", sha("historical source"), 0, 1, "[]", "initial");
    database.prepare("INSERT INTO translation_workflows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(workspaceId, workflowId, documentId, sourceRevisionId, "zh-CN", 0, "source-confirmed", "{}", "native", timestamp);
    m3Facts = { sourceRevisionId, segmentId, workflowId };
  }
  return { database, workspaceId, documentId, m3Facts };
}

test("schemas v1 through v10 migrate to v11 ten times without losing M2 or M3 facts", async () => {
  for (let version = 1; version <= 10; version += 1) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const root = await mkdtemp(join(tmpdir(), `lectoria-m4-1-v${version}-`));
      const filename = join(root, "app.sqlite3");
      const historical = createAtVersion(filename, version);
      historical.database.close();
      const database = openWorkspaceDatabase(filename, { workspaceId: historical.workspaceId });
      try {
        assert.equal(database.pragma("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
        assert.equal(database.prepare("SELECT title FROM documents WHERE workspace_id = ? AND document_id = ?").get(historical.workspaceId, historical.documentId).title, `historical-v${version}`);
        if (historical.m3Facts) {
          assert.equal(database.prepare("SELECT count(*) AS total FROM source_segment_versions WHERE workspace_id = ? AND source_revision_id = ? AND segment_id = ?").get(historical.workspaceId, historical.m3Facts.sourceRevisionId, historical.m3Facts.segmentId).total, 1);
          assert.equal(database.prepare("SELECT state FROM translation_workflows WHERE workspace_id = ? AND workflow_id = ?").get(historical.workspaceId, historical.m3Facts.workflowId).state, "source-confirmed");
        }
        assertDatabaseIntegrity(database);
      } finally {
        database.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});

test("schema 11 migration fault points leave only retryable v10 or complete v11", async () => {
  for (const point of ["before-migration-11", "after-sql-11", "after-commit-11"]) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const root = await mkdtemp(join(tmpdir(), "lectoria-m4-1-fault-"));
      const filename = join(root, "app.sqlite3");
      const { database, workspaceId } = createV10(filename);
      try {
        assert.throws(() => applyMigrations(database, { inject(current) { if (current === point) throw new Error(`injected ${point}`); } }), /injected/);
        assert.ok([10, 11].includes(database.pragma("user_version", { simple: true })));
      } finally { database.close(); }
      const reopened = openWorkspaceDatabase(filename, { workspaceId });
      assert.equal(reopened.pragma("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
      assertDatabaseIntegrity(reopened);
      reopened.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("task attempt capability and usage facts are strongly bound to workflow scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m4-1-relations-"));
  const workspaceId = randomUUID();
  const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId });
  try {
    const workflow = seedWorkflow(database, workspaceId);
    const taskId = randomUUID();
    const attemptId = randomUUID();
    database.prepare("INSERT INTO translation_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)")
      .run(workspaceId, taskId, workflow.workflowId, workflow.documentId, workflow.sourceRevisionId, workflow.targetLanguage, "idem-1", sha("request"), "policy-v1", timestamp, timestamp);
    database.prepare("INSERT INTO translation_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, NULL)")
      .run(workspaceId, attemptId, taskId, workflow.workflowId, workflow.documentId, workflow.sourceRevisionId, workflow.targetLanguage, workflow.segmentId, "fake-primary", "fixture-model-v1", "prompt-v1", sha("context"), sha("request"), timestamp);
    database.prepare("INSERT INTO capability_grants VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(workspaceId, randomUUID(), taskId, attemptId, sha("capability"), '["segment:read","candidate:submit"]', new Date(60_000).toISOString(), timestamp);
    database.prepare("INSERT INTO usage_cost_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)")
      .run(workspaceId, randomUUID(), taskId, attemptId, "fake-primary", "fixture-model-v1", "fake-response", 10, 4, 2, 14, "pricing-v1", timestamp);
    assertDatabaseIntegrity(database);

    const store = new M4FoundationStore(database, workspaceId, { now: () => new Date(0) });

    for (let index = 0; index < 100; index += 1) {
      assert.throws(() => database.prepare("INSERT INTO translation_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)")
        .run(workspaceId, randomUUID(), randomUUID(), workflow.documentId, workflow.sourceRevisionId, workflow.targetLanguage, `bad-${index}`, sha(`bad-${index}`), "policy-v1", timestamp, timestamp), /FOREIGN KEY/);
      assert.throws(() => database.prepare("INSERT INTO translation_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, NULL)")
        .run(workspaceId, randomUUID(), taskId, workflow.workflowId, workflow.documentId, workflow.sourceRevisionId, "fr", workflow.segmentId, "fake-primary", "fixture-model-v1", "prompt-v1", sha("context"), sha("request"), timestamp), /FOREIGN KEY/);
      assert.throws(() => database.prepare("INSERT INTO usage_cost_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)")
        .run(workspaceId, randomUUID(), taskId, randomUUID(), "fake-primary", "fixture-model-v1", "fake-response", 1, 1, 0, 2, "pricing-v1", timestamp), /FOREIGN KEY/);

      assert.throws(() => store.createTask({
        ...workflow, workflowId: randomUUID(), idempotencyKey: `service-bad-${index}`,
        requestDigest: sha(`service-bad-${index}`), policyVersion: "policy-v1",
      }), /scope mismatch/);
      assert.throws(() => store.createAttempt({
        taskId, ...workflow, targetLanguage: "fr", providerId: "fake-primary", modelId: "fixture-model-v1",
        promptVersion: "prompt-v1", contextDigest: sha("context"), requestDigest: sha("request"),
      }), /scope mismatch/);
      assert.throws(() => store.recordUsage({
        taskId, attemptId: randomUUID(), providerId: "fake-primary", modelId: "fixture-model-v1", providerResponseId: `bad-${index}`,
        inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2, pricingVersion: "pricing-v1",
      }), /scope mismatch/);
    }
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("schema stores only capability digests and normalized metadata, never raw secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m4-1-secret-"));
  const workspaceId = randomUUID();
  const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId });
  try {
    const sql = database.prepare("SELECT group_concat(sql, '\n') AS value FROM sqlite_master WHERE sql IS NOT NULL").get().value.toLowerCase();
    for (const forbidden of ["api_key", "apikey", "authorization", "raw_request", "raw_response", "secret_value"]) assert.equal(sql.includes(forbidden), false);
    assert.equal(sql.includes("token_digest"), true);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
