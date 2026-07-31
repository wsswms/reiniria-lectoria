import { randomUUID } from "node:crypto";
import { ResourceNotFoundError } from "./errors.mjs";

const TABLES = Object.freeze({
  objects: "object_records",
  documents: "documents",
  revisions: "source_revisions",
  segments: "segments",
  tasks: "task_placeholders",
  idempotency: "idempotency_keys",
  cache: "cache_entries",
  derived: "derived_indexes",
  audit: "audit_events",
});

function tableFor(resourceClass) {
  const table = TABLES[resourceClass];
  if (!table) throw new TypeError("unsupported resource class");
  return table;
}

export class ScopedWorkspaceStore {
  #database;
  #workspaceId;

  constructor(database, trustedWorkspaceId) {
    this.#database = database;
    this.#workspaceId = trustedWorkspaceId;
  }

  get workspaceId() { return this.#workspaceId; }

  put(resourceClass, resourceId = randomUUID(), value = "fixture") {
    const table = tableFor(resourceClass);
    if (["documents", "revisions", "segments"].includes(resourceClass)) {
      throw new TypeError("structured resources require their domain service");
    }
    this.#database.prepare(`INSERT INTO ${table}(workspace_id, resource_id, value) VALUES (?, ?, ?)`)
      .run(this.#workspaceId, resourceId, value);
    return resourceId;
  }

  get(resourceClass, resourceId, _untrustedWorkspaceId = undefined) {
    const table = tableFor(resourceClass);
    let row;
    if (resourceClass === "documents") {
      row = this.#database.prepare(`SELECT document_id AS resourceId, title AS value FROM ${table} WHERE workspace_id = ? AND document_id = ?`)
        .get(this.#workspaceId, resourceId);
    } else if (resourceClass === "revisions") {
      row = this.#database.prepare(`SELECT source_revision_id AS resourceId, original_digest AS value FROM ${table} WHERE workspace_id = ? AND source_revision_id = ?`)
        .get(this.#workspaceId, resourceId);
    } else if (resourceClass === "segments") {
      row = this.#database.prepare(`SELECT segment_id AS resourceId, source_text AS value FROM ${table} WHERE workspace_id = ? AND segment_id = ?`)
        .get(this.#workspaceId, resourceId);
    } else {
      row = this.#database.prepare(`SELECT resource_id AS resourceId, value FROM ${table} WHERE workspace_id = ? AND resource_id = ?`)
        .get(this.#workspaceId, resourceId);
    }
    if (!row) throw new ResourceNotFoundError();
    return Object.freeze(row);
  }
}
