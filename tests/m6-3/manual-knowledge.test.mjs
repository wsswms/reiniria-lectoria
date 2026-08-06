import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { WorkspaceManager } from "../../src/workspace/manager.mjs";
import { ManualKnowledgeService } from "../../src/knowledge/manual-knowledge-service.mjs";

const user = { type: "user", id: "owner" };

test("manual knowledge uses immutable revisions, user actor and rebuilds the derived index", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-manual-knowledge-"));
  const manager = await WorkspaceManager.create(root);
  const workspace = await manager.createWorkspace("manual knowledge");
  const handle = manager.open(workspace.workspaceId);
  let rebuilds = 0;
  const service = new ManualKnowledgeService({ root: handle.root, database: handle.database,
    workspaceId: workspace.workspaceId, retriever: { rebuild: async () => { rebuilds += 1; } }, id: (() => {
      const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004"];
      return () => ids.shift();
    })() });
  try {
    const created = await service.create({ kind: "knowledge", language: "zh-CN", initialState: "draft",
      content: { title: "术语背景", body: "这是用户手动录入的背景知识。", tags: ["product"], source: "user" } }, user);
    assert.equal(created.head.state, "inactive");
    assert.equal(created.revision.actorId, "owner");
    const revised = await service.revise({ factId: created.source.factId, expectedHeadVersion: created.head.version,
      kind: "knowledge", language: "zh-CN", content: { title: "术语背景", body: "修订后的背景知识。", tags: ["product"], source: "user" } }, user);
    assert.equal(revised.revision.version, 2);
    assert.equal(service.list({ state: "inactive" }).length, 1);
    const active = await service.setState({ factId: created.source.factId, expectedHeadVersion: revised.head.version, state: "active" }, user);
    assert.equal(active.state, "active");
    assert.ok(rebuilds >= 3);
    await assert.rejects(() => service.revise({ factId: created.source.factId, expectedHeadVersion: 0,
      kind: "knowledge", language: "zh-CN", content: { title: "x", body: "y", tags: [], source: "user" } }, user), /version conflict/);
  } finally { handle.database.close(); manager.close(); await rm(root, { recursive: true, force: true }); }
});
