import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CURRENT_SCHEMA_VERSION } from "../../src/db/migrations.mjs";
import { TranslationNumberTool } from "../../src/tools/translation-number-tool.mjs";
import {
  TranslationToolConfigurationConflictError,
  TranslationToolConfigurationService,
} from "../../src/tools/translation-tool-configuration-service.mjs";
import { researchWorkspace } from "../m5r-2/helpers.mjs";

const request = (value = "20") => ({ schemaVersion: "number-calculation-request-v1", operation: "convert-unit",
  value, from: "lb", to: "kg", precision: 6, rounding: "half-even" });

function configuration({ number = true, maxCalls = 2 } = {}) {
  return { schemaVersion: "translation-tool-configuration-v1",
    dictionary: { providerId: "deepseek-flash", providerVersion: "flash-v1", maxCalls: 8,
      maxCostMicrosUsd: 20_000, allowedDomains: ["dictionary.cambridge.org"] },
    entity: { providerId: "brave-web", providerVersion: "brave-v1", maxCalls: 8,
      maxCostMicrosUsd: 40_000, allowedDomains: ["nasa.gov"] },
    number: number ? { providerId: "local-number", providerVersion: "local-number-v1", maxCalls } : null };
}

async function fixture() {
  const value = await researchWorkspace();
  return { value, database: value.setup.fixture.database, workspaceId: value.setup.fixture.workspaceId,
    taskId: value.bound.task.task.task_id };
}

test("current schema retains immutable scoped tool configuration receipt and cache tables", async () => {
  const f = await fixture();
  try {
    assert.equal(CURRENT_SCHEMA_VERSION, 31);
    for (const name of ["translation_tool_configurations", "translation_calculation_receipts", "translation_reference_cache_entries"]) {
      assert.ok(f.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    }
    new TranslationToolConfigurationService(f.database, f.workspaceId).bind(f.taskId, configuration());
    assert.throws(() => f.database.prepare("UPDATE translation_tool_configurations SET created_at = created_at").run(), /immutable/);
    assert.throws(() => f.database.prepare("DELETE FROM translation_tool_configurations").run(), /immutable/);
  } finally { await f.value.close(); }
});

test("task tool configuration is idempotent immutable and workspace scoped", async () => {
  const f = await fixture();
  try {
    const service = new TranslationToolConfigurationService(f.database, f.workspaceId);
    const first = service.bind(f.taskId, configuration());
    assert.deepEqual(service.bind(f.taskId, configuration()), first);
    assert.equal(service.binding(f.taskId, "dictionary").providerId, "deepseek-flash");
    assert.throws(() => service.bind(f.taskId, configuration({ maxCalls: 3 })), TranslationToolConfigurationConflictError);
    assert.throws(() => new TranslationToolConfigurationService(f.database, randomUUID()).get(f.taskId), /not found/);
    assert.throws(() => new TranslationToolConfigurationService(f.database, randomUUID()).bind(f.taskId, configuration()), /not found/);
  } finally { await f.value.close(); }
});

test("number tool reads its trusted binding and deterministically caches receipts", async () => {
  const f = await fixture();
  try {
    const configurations = new TranslationToolConfigurationService(f.database, f.workspaceId);
    configurations.bind(f.taskId, configuration({ maxCalls: 2 }));
    const tool = new TranslationNumberTool(f.database, f.workspaceId);
    const first = tool.execute(f.taskId, request());
    assert.equal(first.formattedValue, "9.071847");
    assert.deepEqual(tool.execute(f.taskId, request()), first);
    assert.equal(f.database.prepare("SELECT count(*) AS value FROM translation_calculation_receipts").get().value, 1);
    tool.execute(f.taskId, request("21"));
    assert.throws(() => tool.execute(f.taskId, request("22")), /limit exceeded/);
    assert.throws(() => f.database.prepare("UPDATE translation_calculation_receipts SET created_at = created_at").run(), /immutable/);
    assert.throws(() => f.database.prepare("DELETE FROM translation_calculation_receipts").run(), /immutable/);
  } finally { await f.value.close(); }
});

test("disabled number tool is not callable", async () => {
  const f = await fixture();
  try {
    new TranslationToolConfigurationService(f.database, f.workspaceId).bind(f.taskId, configuration({ number: false }));
    assert.throws(() => new TranslationNumberTool(f.database, f.workspaceId).execute(f.taskId, request()), /disabled/);
  } finally { await f.value.close(); }
});
