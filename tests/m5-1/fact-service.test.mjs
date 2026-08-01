import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stableJson } from "../../src/domain/contracts.mjs";
import { KnowledgeFactService } from "../../src/knowledge/fact-service.mjs";
import { knowledgeInput, styleInput, termInput, workspace } from "./helpers.mjs";

const actor = Object.freeze({ type: "user", id: "owner" });

test("facts keep immutable revisions canonical source files private snapshots and explicit activation history", async () => {
  const fixture = await workspace();
  try {
    const service = new KnowledgeFactService(fixture.root, fixture.database, fixture.workspaceId, { now: () => new Date(0) });
    for (const input of [termInput(), styleInput(), knowledgeInput()]) {
      const created = await service.create(input, actor);
      assert.equal(created.head.state, "active");
      assert.equal(created.head.version, 0);
      assert.equal(created.revision.version, 1);
      assert.equal(JSON.parse(await readFile(`${fixture.root}/${created.revision.sourcePath}`, "utf8")).factId, input.factId);
      assert.equal((await service.readSnapshot(created.revision.revisionId)).toString("utf8"), `${stableJson(created.source)}\n`);

      const revisedContent = input.kind === "term" ? { ...input.content, note: "revised" }
        : input.kind === "style" ? { ...input.content, description: `${input.content.description} revised` }
          : { ...input.content, body: `${input.content.body} revised` };
      const next = await service.revise(input.factId, 0, { ...input, revisionId: randomUUID(), content: revisedContent }, actor);
      assert.equal(next.head.version, 1);
      assert.equal(next.revision.version, 2);
      assert.equal(service.listRevisions(input.factId).length, 2);
      const inactive = service.setActive(input.factId, 1, false, actor);
      assert.equal(inactive.state, "inactive");
      assert.equal(inactive.version, 2);
      assert.equal(service.get(input.factId).head.state, "inactive");
      assert.throws(() => service.setActive(input.factId, 1, true, actor), /version conflict/);
    }
    assert.equal(service.list().length, 3);
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM knowledge_fact_events").get().total, 9);
    assert.equal((await service.verifySources()).failures.length, 0);
  } finally { await fixture.close(); }
});

test("service and database reject cross-workspace forged relationships and immutable mutations", async () => {
  const first = await workspace();
  const second = await workspace();
  try {
    const service = new KnowledgeFactService(first.root, first.database, first.workspaceId, { now: () => new Date(0) });
    const created = await service.create(termInput(), actor);
    const foreignDocumentId = randomUUID();
    second.database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)")
      .run(second.workspaceId, foreignDocumentId, "foreign", new Date(0).toISOString());
    for (let index = 0; index < 100; index += 1) {
      assert.throws(() => new KnowledgeFactService(first.root, first.database, second.workspaceId), /workspace identity mismatch/);
      await assert.rejects(service.create(termInput({
        scope: { targetLanguages: ["zh-CN"], tags: ["product"], documentIds: [foreignDocumentId] },
      }), actor), /document scope mismatch/);
      assert.throws(() => first.database.prepare("INSERT INTO knowledge_fact_heads VALUES (?, ?, ?, ?, ?, 0, 'active', ?)")
        .run(second.workspaceId, created.source.factId, created.source.kind, randomUUID(), 1, new Date(0).toISOString()), /FOREIGN KEY/);
      assert.throws(() => first.database.prepare("INSERT INTO knowledge_fact_scope_documents VALUES (?, ?, ?, ?)")
        .run(first.workspaceId, created.source.factId, created.revision.revisionId, foreignDocumentId), /FOREIGN KEY/);
      assert.throws(() => first.database.prepare(`
        INSERT INTO knowledge_fact_revisions (
          workspace_id, fact_id, revision_id, kind, version, language, scope_json, content_json,
          content_digest, object_id, source_path, actor_type, actor_id, created_at
        ) VALUES (?, ?, ?, ?, 2, 'en', '{}', '{}', ?, ?, '../forged.json', 'fixture', 'attack', ?)
      `).run(
        first.workspaceId, created.source.factId, randomUUID(), created.source.kind,
        created.revision.contentDigest, created.revision.objectId, new Date(0).toISOString(),
      ), /CHECK/);
    }
    assert.equal(service.list().length, 1);
    assert.throws(() => first.database.prepare("UPDATE knowledge_fact_revisions SET language = 'fr' WHERE revision_id = ?").run(created.revision.revisionId), /immutable/);
    assert.throws(() => first.database.prepare("DELETE FROM knowledge_fact_revisions WHERE revision_id = ?").run(created.revision.revisionId), /immutable/);
    assert.throws(() => first.database.prepare("UPDATE knowledge_fact_events SET action = 'forged'").run(), /append-only/);
  } finally { await first.close(); await second.close(); }
});

test("one hundred same-version revisions permit one writer and preserve one active head", async () => {
  const fixture = await workspace();
  try {
    const service = new KnowledgeFactService(fixture.root, fixture.database, fixture.workspaceId, { now: () => new Date(0) });
    const initial = termInput();
    await service.create(initial, actor);
    const outcomes = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => service.revise(initial.factId, 0, {
      ...initial,
      revisionId: randomUUID(),
      content: { ...initial.content, note: `revision-${index}` },
    }, actor)));
    assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(service.get(initial.factId).head.version, 1);
    assert.equal(service.listRevisions(initial.factId).length, 2);
  } finally { await fixture.close(); }
});

test("create and revise fault points converge to the complete old or new fact state", async () => {
  const createPoints = [
    "object:after-temp", "object:after-rename", "object:after-db-insert", "object:after-db-commit",
    "after-source-write", "before-create", "after-create-writes", "after-create-commit",
  ];
  for (const point of createPoints) for (let repeat = 0; repeat < 10; repeat += 1) {
    const fixture = await workspace();
    const input = termInput();
    let fired = false;
    const service = new KnowledgeFactService(fixture.root, fixture.database, fixture.workspaceId, {
      now: () => new Date(0),
      inject(current) { if (!fired && current === point) { fired = true; throw new Error(`injected ${point}`); } },
    });
    try {
      await assert.rejects(service.create(input, actor), /injected/);
      const committed = point === "after-create-commit";
      assert.equal(service.list().length, committed ? 1 : 0);
      assert.equal((await service.verifySources()).failures.length, 0);
      const filename = `${fixture.root}/dictionary/${input.factId}/${input.revisionId}.json`;
      if (committed) assert.equal(JSON.parse(await readFile(filename, "utf8")).revisionId, input.revisionId);
      else await assert.rejects(readFile(filename), /ENOENT/);
    } finally { await fixture.close(); }
  }

  const revisePoints = [
    "object:after-temp", "object:after-rename", "object:after-db-insert", "object:after-db-commit",
    "after-source-write", "before-revise", "after-revise-writes", "after-revise-commit",
  ];
  for (const point of revisePoints) for (let repeat = 0; repeat < 10; repeat += 1) {
    const fixture = await workspace();
    const initial = termInput();
    const baseline = new KnowledgeFactService(fixture.root, fixture.database, fixture.workspaceId, { now: () => new Date(0) });
    await baseline.create(initial, actor);
    const revisionId = randomUUID();
    let fired = false;
    const service = new KnowledgeFactService(fixture.root, fixture.database, fixture.workspaceId, {
      now: () => new Date(0),
      inject(current) { if (!fired && current === point) { fired = true; throw new Error(`injected ${point}`); } },
    });
    try {
      await assert.rejects(service.revise(initial.factId, 0, {
        ...initial, revisionId, content: { ...initial.content, note: `fault-${point}-${repeat}` },
      }, actor), /injected/);
      const committed = point === "after-revise-commit";
      assert.equal(service.listRevisions(initial.factId).length, committed ? 2 : 1);
      assert.equal(service.get(initial.factId).revision.revisionId, committed ? revisionId : initial.revisionId);
      assert.equal((await service.verifySources()).failures.length, 0);
      const filename = `${fixture.root}/dictionary/${initial.factId}/${revisionId}.json`;
      if (committed) assert.equal(JSON.parse(await readFile(filename, "utf8")).revisionId, revisionId);
      else await assert.rejects(readFile(filename), /ENOENT/);
    } finally { await fixture.close(); }
  }
});

test("one hundred concurrent activation and deactivation commands each permit one CAS winner", async () => {
  const fixture = await workspace();
  try {
    const service = new KnowledgeFactService(fixture.root, fixture.database, fixture.workspaceId, { now: () => new Date(0) });
    const input = termInput();
    await service.create(input, actor);
    const deactivate = Array.from({ length: 100 }, () => {
      try { service.setActive(input.factId, 0, false, actor); return true; } catch { return false; }
    });
    assert.equal(deactivate.filter(Boolean).length, 1);
    assert.equal(service.get(input.factId).head.state, "inactive");
    const activate = Array.from({ length: 100 }, () => {
      try { service.setActive(input.factId, 1, true, actor); return true; } catch { return false; }
    });
    assert.equal(activate.filter(Boolean).length, 1);
    assert.equal(service.get(input.factId).head.state, "active");
    assert.equal(fixture.database.prepare("SELECT count(*) AS total FROM knowledge_fact_events").get().total, 3);
  } finally { await fixture.close(); }
});
