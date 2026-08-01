import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { factSourceContract } from "./contracts.mjs";
import { stableJson } from "../domain/contracts.mjs";
import { ObjectStore } from "../storage/object-store.mjs";
import { resolveWorkspaceFile, writeWorkspaceFile } from "../workspace/path-guard.mjs";

const DIRECTORIES = Object.freeze({ term: "dictionary", style: "style", knowledge: "knowledge" });
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function actorContract(actor) {
  if (!actor || !["user", "system", "fixture"].includes(actor.type) || typeof actor.id !== "string" || actor.id.length === 0) {
    throw new TypeError("actor is invalid");
  }
  return Object.freeze({ type: actor.type, id: actor.id });
}

function parseSource(row) {
  return factSourceContract({
    schemaVersion: "1.0", factId: row.factId, revisionId: row.revisionId,
    kind: row.kind, language: row.language,
    scope: JSON.parse(row.scopeJson), content: JSON.parse(row.contentJson),
  });
}

function revisionView(row) {
  return Object.freeze({
    factId: row.factId, revisionId: row.revisionId, kind: row.kind,
    version: row.revisionVersion, language: row.language,
    contentDigest: row.contentDigest, objectId: row.objectId,
    sourcePath: row.sourcePath, actorType: row.actorType,
    actorId: row.actorId, createdAt: row.createdAt,
  });
}

function headView(row) {
  return Object.freeze({
    factId: row.factId, kind: row.kind, revisionId: row.revisionId,
    revisionVersion: row.revisionVersion, version: row.headVersion,
    state: row.state, updatedAt: row.updatedAt,
  });
}

const SELECT_CURRENT = `
  SELECT fact.fact_id AS factId, fact.kind,
         revision.revision_id AS revisionId, revision.version AS revisionVersion,
         revision.language, revision.scope_json AS scopeJson, revision.content_json AS contentJson,
         revision.content_digest AS contentDigest, revision.object_id AS objectId,
         revision.source_path AS sourcePath, revision.actor_type AS actorType,
         revision.actor_id AS actorId, revision.created_at AS createdAt,
         head.version AS headVersion, head.state, head.updated_at AS updatedAt
  FROM knowledge_facts fact
  JOIN knowledge_fact_heads head
    ON head.workspace_id = fact.workspace_id AND head.fact_id = fact.fact_id
  JOIN knowledge_fact_revisions revision
    ON revision.workspace_id = head.workspace_id AND revision.revision_id = head.revision_id
  WHERE fact.workspace_id = ?`;

export class KnowledgeFactService {
  constructor(root, database, trustedWorkspaceId, { now = () => new Date(), id = () => randomUUID(), inject = () => {} } = {}) {
    const identities = database.prepare("SELECT workspace_id AS workspaceId FROM workspace_meta").all();
    if (identities.length !== 1 || identities[0].workspaceId !== trustedWorkspaceId) throw new Error("workspace identity mismatch");
    this.root = root;
    this.database = database;
    this.workspaceId = trustedWorkspaceId;
    this.now = now;
    this.id = id;
    this.inject = inject;
    this.objects = new ObjectStore(root, database, trustedWorkspaceId, { now, inject: (point, details) => inject(`object:${point}`, details) });
  }

  async create(input, actorInput) {
    const source = factSourceContract(input);
    const actor = actorContract(actorInput);
    this.#assertScope(source);
    if (this.database.prepare("SELECT 1 FROM knowledge_facts WHERE workspace_id = ? AND fact_id = ?").get(this.workspaceId, source.factId)) {
      throw new Error("knowledge fact already exists");
    }
    const prepared = await this.#prepare(source);
    let committed = false;
    try {
      const timestamp = this.now().toISOString();
      this.database.transaction(() => {
        this.inject("before-create", source);
        this.database.prepare("INSERT INTO knowledge_facts VALUES (?, ?, ?, ?)")
          .run(this.workspaceId, source.factId, source.kind, timestamp);
        this.#insertRevision(source, 1, prepared, actor, timestamp);
        this.database.prepare("INSERT INTO knowledge_fact_heads VALUES (?, ?, ?, ?, 1, 0, 'active', ?)")
          .run(this.workspaceId, source.factId, source.kind, source.revisionId, timestamp);
        this.#event(source, "created", actor, timestamp, { headVersion: 0, revisionVersion: 1 });
        this.inject("after-create-writes", source);
      })();
      committed = true;
      this.inject("after-create-commit", source);
      return this.get(source.factId);
    } catch (error) {
      if (!committed) await this.#removePrepared(prepared);
      throw error;
    }
  }

  async revise(factId, expectedHeadVersion, input, actorInput) {
    const source = factSourceContract(input);
    const actor = actorContract(actorInput);
    this.#assertScope(source);
    if (source.factId !== factId) throw new Error("knowledge fact scope mismatch");
    const current = this.get(factId);
    if (current.head.version !== expectedHeadVersion) throw new Error("knowledge fact version conflict");
    if (current.source.kind !== source.kind) throw new Error("knowledge fact kind mismatch");
    const prepared = await this.#prepare(source);
    let committed = false;
    try {
      const timestamp = this.now().toISOString();
      const nextRevisionVersion = current.revision.version + 1;
      const changed = this.database.transaction(() => {
        this.inject("before-revise", source);
        this.#insertRevision(source, nextRevisionVersion, prepared, actor, timestamp);
        const result = this.database.prepare(`
          UPDATE knowledge_fact_heads SET revision_id = ?, revision_version = ?, version = version + 1, updated_at = ?
          WHERE workspace_id = ? AND fact_id = ? AND version = ?
        `).run(source.revisionId, nextRevisionVersion, timestamp, this.workspaceId, factId, expectedHeadVersion);
        if (result.changes !== 1) throw new Error("knowledge fact version conflict");
        this.#event(source, "revised", actor, timestamp, { headVersion: expectedHeadVersion + 1, revisionVersion: nextRevisionVersion });
        this.inject("after-revise-writes", source);
        return result.changes;
      })();
      if (changed !== 1) throw new Error("knowledge fact version conflict");
      committed = true;
      this.inject("after-revise-commit", source);
      return this.get(factId);
    } catch (error) {
      if (!committed) await this.#removePrepared(prepared);
      throw error;
    }
  }

  setActive(factId, expectedHeadVersion, active, actorInput) {
    if (typeof active !== "boolean") throw new TypeError("active must be boolean");
    const actor = actorContract(actorInput);
    const current = this.get(factId);
    if (current.head.version !== expectedHeadVersion) throw new Error("knowledge fact version conflict");
    const nextState = active ? "active" : "inactive";
    if (current.head.state === nextState) throw new Error("knowledge fact state is unchanged");
    const timestamp = this.now().toISOString();
    this.database.transaction(() => {
      const result = this.database.prepare(`
        UPDATE knowledge_fact_heads SET state = ?, version = version + 1, updated_at = ?
        WHERE workspace_id = ? AND fact_id = ? AND version = ?
      `).run(nextState, timestamp, this.workspaceId, factId, expectedHeadVersion);
      if (result.changes !== 1) throw new Error("knowledge fact version conflict");
      this.#event(current.source, active ? "activated" : "deactivated", actor, timestamp, {
        headVersion: expectedHeadVersion + 1, revisionVersion: current.revision.version,
      });
    })();
    return this.get(factId).head;
  }

  get(factId) {
    const row = this.database.prepare(`${SELECT_CURRENT} AND fact.fact_id = ?`).get(this.workspaceId, factId);
    if (!row) throw new Error("knowledge fact not found");
    return Object.freeze({ source: parseSource(row), revision: revisionView(row), head: headView(row) });
  }

  list({ state, kinds } = {}) {
    if (state !== undefined && !["active", "inactive"].includes(state)) throw new TypeError("knowledge fact state is invalid");
    if (kinds !== undefined && (!Array.isArray(kinds) || kinds.some((kind) => !DIRECTORIES[kind]))) throw new TypeError("knowledge fact kinds are invalid");
    const rows = this.database.prepare(`${SELECT_CURRENT} ORDER BY fact.fact_id`).all(this.workspaceId);
    return Object.freeze(rows.filter((row) => (state === undefined || row.state === state) && (kinds === undefined || kinds.includes(row.kind)))
      .map((row) => Object.freeze({ source: parseSource(row), revision: revisionView(row), head: headView(row) })));
  }

  listRevisions(factId) {
    const rows = this.database.prepare(`
      SELECT fact_id AS factId, revision_id AS revisionId, kind, version AS revisionVersion,
             language, scope_json AS scopeJson, content_json AS contentJson,
             content_digest AS contentDigest, object_id AS objectId, source_path AS sourcePath,
             actor_type AS actorType, actor_id AS actorId, created_at AS createdAt
      FROM knowledge_fact_revisions WHERE workspace_id = ? AND fact_id = ? ORDER BY version
    `).all(this.workspaceId, factId);
    return Object.freeze(rows.map(revisionView));
  }

  async readSnapshot(revisionId) {
    const row = this.database.prepare("SELECT object_id AS objectId FROM knowledge_fact_revisions WHERE workspace_id = ? AND revision_id = ?")
      .get(this.workspaceId, revisionId);
    if (!row) throw new Error("knowledge fact revision not found");
    return this.objects.read(row.objectId);
  }

  async verifySources() {
    const rows = this.database.prepare(`
      SELECT revision_id AS revisionId, content_digest AS contentDigest, object_id AS objectId, source_path AS sourcePath
      FROM knowledge_fact_revisions WHERE workspace_id = ? ORDER BY revision_id
    `).all(this.workspaceId);
    const failures = [];
    for (const row of rows) {
      try {
        const filename = await resolveWorkspaceFile(this.root, row.sourcePath);
        const sourceBytes = await readFile(filename);
        const objectBytes = await this.objects.read(row.objectId);
        if (sha(sourceBytes) !== row.contentDigest || !sourceBytes.equals(objectBytes)) throw new Error();
        factSourceContract(JSON.parse(sourceBytes.toString("utf8")));
      } catch { failures.push(row.revisionId); }
    }
    return Object.freeze({ checked: rows.length, failures: Object.freeze(failures) });
  }

  async #prepare(source) {
    const bytes = Buffer.from(`${stableJson(source)}\n`);
    const sourcePath = `${DIRECTORIES[source.kind]}/${source.factId}/${source.revisionId}.json`;
    try {
      const object = await this.objects.commit(bytes);
      await writeWorkspaceFile(this.root, sourcePath, bytes);
      this.inject("after-source-write", source);
      return Object.freeze({ bytes, digest: sha(bytes), object, sourcePath });
    } catch (error) {
      await this.#removePrepared({ sourcePath });
      throw error;
    }
  }

  async #removePrepared(prepared) {
    try {
      const filename = await resolveWorkspaceFile(this.root, prepared.sourcePath);
      await rm(filename);
    } catch {}
  }

  #assertScope(source) {
    const hasDocument = this.database.prepare("SELECT 1 FROM documents WHERE workspace_id = ? AND document_id = ?");
    for (const documentId of source.scope.documentIds) {
      if (!hasDocument.get(this.workspaceId, documentId)) throw new Error("knowledge fact document scope mismatch");
    }
  }

  #insertRevision(source, version, prepared, actor, timestamp) {
    this.database.prepare(`
      INSERT INTO knowledge_fact_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.workspaceId, source.factId, source.revisionId, source.kind, version, source.language,
      stableJson(source.scope), stableJson(source.content), prepared.digest, prepared.object.objectId,
      prepared.sourcePath, actor.type, actor.id, timestamp,
    );
    const insertScopeDocument = this.database.prepare("INSERT INTO knowledge_fact_scope_documents VALUES (?, ?, ?, ?)");
    for (const documentId of source.scope.documentIds) {
      insertScopeDocument.run(this.workspaceId, source.factId, source.revisionId, documentId);
    }
  }

  #event(source, action, actor, timestamp, details) {
    this.database.prepare("INSERT INTO knowledge_fact_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.workspaceId, this.id(), source.factId, source.revisionId, action, actor.type, actor.id, stableJson(details), timestamp);
  }
}
