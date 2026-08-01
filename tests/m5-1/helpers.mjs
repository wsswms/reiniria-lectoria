import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspaceDatabase } from "../../src/db/connection.mjs";

export async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "lectoria-m5-1-"));
  for (const directory of ["private/objects", "private/ledger", "derived", "staging", "dictionary", "style", "knowledge"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  const workspaceId = randomUUID();
  const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId, now: () => new Date(0) });
  return {
    root,
    workspaceId,
    database,
    async close() { database.close(); await rm(root, { recursive: true, force: true }); },
  };
}

export function termInput(overrides = {}) {
  return {
    schemaVersion: "1.0",
    factId: randomUUID(),
    revisionId: randomUUID(),
    kind: "term",
    language: "en",
    scope: { targetLanguages: ["zh-CN"], tags: ["product"] },
    content: {
      term: "workspace",
      preferredTranslations: [{ language: "zh-CN", text: "工作区" }],
      forbiddenTranslations: [{ language: "zh-CN", text: "工作空间" }],
      variants: ["work space"],
      note: "Use the product term.",
    },
    ...overrides,
  };
}

export function styleInput(overrides = {}) {
  return {
    schemaVersion: "1.0",
    factId: randomUUID(),
    revisionId: randomUUID(),
    kind: "style",
    language: "zh-CN",
    scope: { targetLanguages: ["zh-CN"], tags: ["documentation"] },
    content: {
      title: "避免敬语",
      description: "技术文档使用直接陈述语气。",
      severity: "warning",
      forbiddenPatterns: ["您可以"],
      requiredPatterns: [],
    },
    ...overrides,
  };
}

export function knowledgeInput(overrides = {}) {
  return {
    schemaVersion: "1.0",
    factId: randomUUID(),
    revisionId: randomUUID(),
    kind: "knowledge",
    language: "ja",
    scope: { targetLanguages: ["zh-CN"], tags: ["architecture"] },
    content: {
      title: "ワークスペース境界",
      body: "各ワークスペースのデータは分離されます。",
      tags: ["workspace", "security"],
      source: "public-fixture",
    },
    ...overrides,
  };
}
