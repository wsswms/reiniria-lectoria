import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { translationToolConfigurationContract } from "./contracts.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export class TranslationToolConfigurationConflictError extends Error {}

export class TranslationToolConfigurationService {
  constructor(database, workspaceId, { now = () => new Date() } = {}) {
    this.database = database;
    this.workspaceId = workspaceId;
    this.now = now;
  }

  bind(taskId, input) {
    const configuration = translationToolConfigurationContract(input);
    const configurationJson = stableJson(configuration);
    const configurationDigest = sha(configurationJson);
    const task = this.database.prepare("SELECT task_id FROM translation_tasks WHERE workspace_id = ? AND task_id = ?")
      .get(this.workspaceId, taskId);
    if (!task) throw new TranslationToolConfigurationConflictError("translation task not found in workspace");
    const existing = this.#row(taskId);
    if (existing) {
      if (existing.configurationDigest !== configurationDigest || existing.configurationJson !== configurationJson) {
        throw new TranslationToolConfigurationConflictError("translation tool configuration is immutable");
      }
      return this.get(taskId);
    }
    try {
      this.database.prepare(`INSERT INTO translation_tool_configurations
        (workspace_id, task_id, schema_version, configuration_json, configuration_digest, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(this.workspaceId, taskId, configuration.schemaVersion,
        configurationJson, configurationDigest, this.now().toISOString());
    } catch {
      const concurrent = this.#row(taskId);
      if (!concurrent || concurrent.configurationDigest !== configurationDigest || concurrent.configurationJson !== configurationJson) {
        throw new TranslationToolConfigurationConflictError("translation tool configuration binding conflict");
      }
    }
    return this.get(taskId);
  }

  get(taskId) {
    const row = this.#row(taskId);
    if (!row) throw new TranslationToolConfigurationConflictError("translation tool configuration not found");
    return Object.freeze({ taskId, configuration: translationToolConfigurationContract(JSON.parse(row.configurationJson)),
      configurationDigest: row.configurationDigest, createdAt: row.createdAt });
  }

  binding(taskId, kind) {
    if (!["dictionary", "entity", "number"].includes(kind)) throw new TypeError("translation tool kind is invalid");
    const binding = this.get(taskId).configuration[kind];
    if (binding === null) throw new TranslationToolConfigurationConflictError(`${kind} tool is disabled`);
    return binding;
  }

  #row(taskId) {
    return this.database.prepare(`SELECT configuration_json AS configurationJson,
      configuration_digest AS configurationDigest, created_at AS createdAt
      FROM translation_tool_configurations WHERE workspace_id = ? AND task_id = ?`).get(this.workspaceId, taskId);
  }
}
