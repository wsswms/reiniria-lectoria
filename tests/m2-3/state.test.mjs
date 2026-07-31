import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openWorkspaceDatabase } from "../../src/db/connection.mjs";
import { ALLOWED_TRANSITIONS, DomainStateService, STATES, StateConflictError } from "../../src/domain/state-service.mjs";

const user = Object.freeze({ type: "user", id: "fixture-user" });
const system = Object.freeze({ type: "system", id: "fixture-system" });

function insertDocument(database, workspaceId, documentId) {
  database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)").run(workspaceId, documentId, "Fixture", new Date(0).toISOString());
}

async function withService(prefix, run) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const workspaceId = randomUUID();
  const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId });
  const service = new DomainStateService(database, workspaceId, { now: () => new Date(0) });
  try { await run({ database, service, workspaceId }); }
  finally { database.close(); await rm(root, { recursive: true, force: true }); }
}

test("the complete allowed and forbidden state transition matrix is enforced", async () => {
  await withService("lectoria-m2-3-matrix-", ({ database, service, workspaceId }) => {
    let allowed = 0;
    let forbidden = 0;
    for (const from of STATES) for (const to of STATES) {
      const documentId = randomUUID();
      insertDocument(database, workspaceId, documentId);
      service.create(documentId, {}, from);
      const shouldAllow = ALLOWED_TRANSITIONS.get(from).has(to);
      const by = ["human-reviewed", "approved-for-export"].includes(to) ? user : system;
      if (shouldAllow) {
        assert.equal(service.transition(documentId, 0, to, by).state, to);
        allowed += 1;
      } else {
        assert.throws(() => service.transition(documentId, 0, to, by), StateConflictError);
        assert.equal(service.get(documentId).state, from);
        forbidden += 1;
      }
    }
    assert.equal(allowed + forbidden, STATES.length ** 2);
  });
});

test("only user actors can enter reviewed and approved states", async () => {
  await withService("lectoria-m2-3-actor-", ({ database, service, workspaceId }) => {
    const reviewed = randomUUID();
    insertDocument(database, workspaceId, reviewed);
    service.create(reviewed, {}, "editing");
    assert.throws(() => service.transition(reviewed, 0, "human-reviewed", system), /rejected/);
    assert.equal(service.transition(reviewed, 0, "human-reviewed", user).state, "human-reviewed");
    assert.throws(() => service.transition(reviewed, 1, "approved-for-export", system), /rejected/);
    assert.equal(service.transition(reviewed, 1, "approved-for-export", user).state, "approved-for-export");
    assert.equal(STATES.includes("published"), false);
  });
});

test("one hundred same-version updates permit exactly one writer", async () => {
  await withService("lectoria-m2-3-cas-", async ({ database, service, workspaceId }) => {
    const documentId = randomUUID();
    insertDocument(database, workspaceId, documentId);
    service.create(documentId, { text: "initial" }, "editing");
    const attempts = await Promise.all(Array.from({ length: 100 }, async (_, index) => {
      try { service.updateContent(documentId, 0, { text: `writer-${index}` }, user); return "success"; }
      catch (error) { assert.ok(error instanceof StateConflictError); return "conflict"; }
    }));
    assert.equal(attempts.filter((value) => value === "success").length, 1);
    assert.equal(attempts.filter((value) => value === "conflict").length, 99);
    assert.equal(service.get(documentId).version, 1);
    const audit = database.prepare("SELECT succeeded, count(*) AS total FROM domain_audit_events GROUP BY succeeded ORDER BY succeeded").all();
    assert.deepEqual(audit, [{ succeeded: 0, total: 99 }, { succeeded: 1, total: 1 }]);
  });
});

test("one hundred duplicate commands create one result and isolate workspace scopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m2-3-idempotency-"));
  const firstId = randomUUID();
  const secondId = randomUUID();
  const firstDb = openWorkspaceDatabase(join(root, "first.sqlite3"), { workspaceId: firstId });
  const secondDb = openWorkspaceDatabase(join(root, "second.sqlite3"), { workspaceId: secondId });
  const first = new DomainStateService(firstDb, firstId);
  const second = new DomainStateService(secondDb, secondId);
  let executions = 0;
  try {
    const results = Array.from({ length: 100 }, () => first.executeIdempotent("import", "same-key", { digest: "same" }, () => ({ businessId: ++executions })));
    assert.equal(executions, 1);
    assert.ok(results.every((entry) => entry.result.businessId === 1));
    assert.equal(results.filter((entry) => entry.reused === false).length, 1);
    assert.throws(() => first.executeIdempotent("import", "same-key", { digest: "different" }, () => ({})), /payload conflict/);
    const other = second.executeIdempotent("import", "same-key", { digest: "same" }, () => ({ businessId: ++executions }));
    assert.equal(other.reused, false);
    assert.equal(executions, 2);
  } finally {
    firstDb.close();
    secondDb.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("source facts and audit events are append-only", async () => {
  await withService("lectoria-m2-3-immutable-", ({ database, service, workspaceId }) => {
    const documentId = randomUUID();
    insertDocument(database, workspaceId, documentId);
    const revisionId = randomUUID();
    database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)").run(workspaceId, revisionId, documentId, `sha256:${"0".repeat(64)}`, `sha256:${"1".repeat(64)}`, new Date(0).toISOString());
    assert.throws(() => database.prepare("UPDATE source_revisions SET original_digest = ? WHERE workspace_id = ? AND source_revision_id = ?").run(`sha256:${"2".repeat(64)}`, workspaceId, revisionId), /immutable/);
    service.create(documentId, {}, "editing");
    service.transition(documentId, 0, "human-reviewed", user);
    assert.throws(() => database.prepare("UPDATE domain_audit_events SET action = 'tampered'").run(), /append-only/);
    assert.throws(() => database.prepare("DELETE FROM domain_audit_events").run(), /append-only/);
  });
});

test("database constraints independently reject invalid state values and edges", async () => {
  await withService("lectoria-m2-3-db-state-", ({ database, service, workspaceId }) => {
    const invalidDocument = randomUUID();
    insertDocument(database, workspaceId, invalidDocument);
    assert.throws(() => service.create(invalidDocument, {}, "published"), /invalid state/);
    for (const from of STATES) for (const to of STATES) {
      const documentId = randomUUID();
      insertDocument(database, workspaceId, documentId);
      service.create(documentId, {}, from);
      if (ALLOWED_TRANSITIONS.get(from).has(to)) {
        assert.equal(database.prepare("UPDATE working_translations SET state = ? WHERE workspace_id = ? AND document_id = ?").run(to, workspaceId, documentId).changes, 1);
      } else {
        assert.throws(() => database.prepare("UPDATE working_translations SET state = ? WHERE workspace_id = ? AND document_id = ?").run(to, workspaceId, documentId), /invalid working translation state transition/);
        assert.equal(service.get(documentId).state, from);
      }
    }
  });
});
