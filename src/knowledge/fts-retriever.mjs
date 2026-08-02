import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import Database from "better-sqlite3";
import { stableJson } from "../domain/contracts.mjs";
import { ensureWorkspaceDirectory, resolveWorkspaceFile } from "../workspace/path-guard.mjs";
import { factSourceContract, knowledgeHitContract, retrieverRequestContract } from "./contracts.mjs";
import { KnowledgeFactService } from "./fact-service.mjs";

export const FTS_RETRIEVER_VERSION = "fts5-trigram-bm25-v1";
export const FTS_INDEX_SCHEMA_VERSION = 1;
export const FTS_NORMALIZER_VERSION = "nfkc-lower-whitespace-v1";
export const FTS_TOKENIZER = "trigram case_sensitive 0";

const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const normalize = (value) => value.normalize("NFKC").trim().toLocaleLowerCase("und").replace(/\s+/gu, " ");
const queryQuote = (value) => `"${value.replaceAll('"', '""')}"`;

function ftsQuery(value) {
  const text = normalize(value);
  const characters = [...text];
  const terms = text.includes(" ")
    ? text.split(" ").filter((term) => [...term].length >= 3)
    : characters.map((_, index) => characters.slice(index, index + 3).join("")).filter((term) => [...term].length === 3);
  return [...new Set(terms)].map(queryQuote).join(" AND ");
}

function indexDocument(row) {
  const scope = JSON.parse(row.scopeJson);
  const content = JSON.parse(row.contentJson);
  if (row.kind === "term") {
    const translations = [...content.preferredTranslations, ...content.forbiddenTranslations].map((item) => item.text);
    return {
      title: content.term,
      body: [content.note ?? "",
        ...content.preferredTranslations.map((item) => `preferredTranslation[${item.language}]: ${item.text}`),
        ...content.forbiddenTranslations.map((item) => `forbiddenTranslation[${item.language}]: ${item.text}`),
      ].join("\n"),
      terms: [content.term, ...content.variants, ...translations].join("\n"),
      exact: [content.term, ...content.variants, ...translations],
      tags: scope.tags,
      documentIds: scope.documentIds,
      targetLanguages: scope.targetLanguages,
    };
  }
  if (row.kind === "style") return {
    title: content.title,
    body: [content.description, ...content.forbiddenPatterns, ...content.requiredPatterns].join("\n"),
    terms: [...content.forbiddenPatterns, ...content.requiredPatterns].join("\n"),
    exact: [content.title, ...content.forbiddenPatterns, ...content.requiredPatterns],
    tags: scope.tags,
    documentIds: scope.documentIds,
    targetLanguages: scope.targetLanguages,
  };
  return {
    title: content.title,
    body: content.body,
    terms: "",
    exact: [content.title],
    tags: [...new Set([...scope.tags, ...content.tags])].sort(),
    documentIds: scope.documentIds,
    targetLanguages: scope.targetLanguages,
  };
}

function applies(row, request) {
  const tags = JSON.parse(row.tags_json);
  const documents = JSON.parse(row.document_ids_json);
  const targetLanguages = JSON.parse(row.target_languages_json);
  if (targetLanguages.length > 0 && !targetLanguages.includes(request.language)) return false;
  if (request.tags.some((tag) => !tags.includes(tag))) return false;
  if (documents.length > 0 && !request.documentIds.some((id) => documents.includes(id))) return false;
  return true;
}

function matchedField(row, query) {
  const needle = normalize(query);
  for (const [field, value] of [["title", row.title], ["terms", row.terms], ["body", row.body], ["tags", JSON.parse(row.tags_json).join(" ")]]) {
    if (normalize(value).includes(needle)) return field;
  }
  return "body";
}

function snippet(row, field) {
  const value = field === "tags" ? JSON.parse(row.tags_json).join(", ") : row[field];
  return [...value.trim()].slice(0, 512).join("") || row.title;
}

function hit(row, rank) {
  const field = matchedField(row, row.query);
  return knowledgeHitContract({
    factId: row.fact_id,
    revisionId: row.revision_id,
    kind: row.kind,
    language: row.language,
    matchedField: field,
    snippet: snippet(row, field),
    contentDigest: row.content_digest,
    retrieverVersion: FTS_RETRIEVER_VERSION,
    score: row.score,
    rank,
  });
}

function assertWorkspace(database, workspaceId) {
  const rows = database.prepare("SELECT workspace_id AS workspaceId FROM workspace_meta").all();
  if (rows.length !== 1 || rows[0].workspaceId !== workspaceId) throw new Error("workspace identity mismatch");
}

export function activeFactSetDigest(database, workspaceId) {
  const rows = database.prepare(`
    SELECT fact.fact_id AS factId, head.revision_id AS revisionId, revision.content_digest AS contentDigest
    FROM knowledge_facts AS fact
    JOIN knowledge_fact_heads AS head
      ON head.workspace_id = fact.workspace_id AND head.fact_id = fact.fact_id AND head.state = 'active'
    JOIN knowledge_fact_revisions AS revision
      ON revision.workspace_id = head.workspace_id AND revision.revision_id = head.revision_id
    WHERE fact.workspace_id = ? ORDER BY fact.fact_id
  `).all(workspaceId);
  return sha(Buffer.from(stableJson(rows)));
}

function createIndex(filename, workspaceId, rows, builtAt, inject) {
  const index = new Database(filename);
  try {
    index.pragma("journal_mode = DELETE");
    index.pragma("synchronous = FULL");
    index.exec(`
      CREATE TABLE index_manifest (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), workspace_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL, retriever_version TEXT NOT NULL,
        normalizer_version TEXT NOT NULL, tokenizer TEXT NOT NULL,
        fact_set_digest TEXT NOT NULL, fact_count INTEGER NOT NULL, built_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE knowledge_rows (
        fact_id TEXT PRIMARY KEY, revision_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
        language TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, terms TEXT NOT NULL,
        tags_json TEXT NOT NULL, document_ids_json TEXT NOT NULL, target_languages_json TEXT NOT NULL,
        content_digest TEXT NOT NULL
      ) STRICT;
      CREATE TABLE knowledge_exact (
        normalized TEXT NOT NULL, fact_id TEXT NOT NULL,
        PRIMARY KEY(normalized, fact_id), FOREIGN KEY(fact_id) REFERENCES knowledge_rows(fact_id)
      ) STRICT;
      CREATE VIRTUAL TABLE knowledge_fts USING fts5(
        fact_id UNINDEXED, revision_id UNINDEXED, kind UNINDEXED, language UNINDEXED,
        title, body, terms, tags, tokenize='trigram case_sensitive 0'
      );
    `);
    const insertRow = index.prepare("INSERT INTO knowledge_rows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertExact = index.prepare("INSERT OR IGNORE INTO knowledge_exact VALUES (?, ?)");
    const insertFts = index.prepare("INSERT INTO knowledge_fts VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    index.transaction(() => {
      for (const row of rows) {
        const document = indexDocument(row);
        const tagsJson = stableJson(document.tags);
        insertRow.run(row.factId, row.revisionId, row.kind, row.language, document.title, document.body, document.terms,
          tagsJson, stableJson(document.documentIds), stableJson(document.targetLanguages), row.contentDigest);
        for (const value of document.exact) insertExact.run(normalize(value), row.factId);
        insertFts.run(row.factId, row.revisionId, row.kind, row.language, document.title, document.body, document.terms, document.tags.join(" "));
      }
      const digest = sha(Buffer.from(stableJson(rows.map(({ factId, revisionId, contentDigest }) => ({ factId, revisionId, contentDigest })))));
      index.prepare("INSERT INTO index_manifest VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(workspaceId, FTS_INDEX_SCHEMA_VERSION, FTS_RETRIEVER_VERSION, FTS_NORMALIZER_VERSION, FTS_TOKENIZER, digest, rows.length, builtAt);
      inject("after-manifest");
    })();
    if (index.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("knowledge index integrity failed");
  } finally { index.close(); }
}

export class FtsRetriever {
  constructor(root, database, trustedWorkspaceId, { now = () => new Date(), id = () => randomUUID(), inject = () => {} } = {}) {
    assertWorkspace(database, trustedWorkspaceId);
    this.root = root;
    this.database = database;
    this.workspaceId = trustedWorkspaceId;
    this.now = now;
    this.id = id;
    this.inject = inject;
  }

  async rebuild() {
    const rows = this.database.prepare(`
      SELECT f.fact_id AS factId, h.revision_id AS revisionId, f.kind, r.language,
             r.scope_json AS scopeJson, r.content_json AS contentJson, r.content_digest AS contentDigest,
             r.source_path AS sourcePath
      FROM knowledge_facts f
      JOIN knowledge_fact_heads h ON h.workspace_id = f.workspace_id AND h.fact_id = f.fact_id
      JOIN knowledge_fact_revisions r ON r.workspace_id = h.workspace_id AND r.revision_id = h.revision_id
      WHERE f.workspace_id = ? AND h.state = 'active' ORDER BY f.fact_id
    `).all(this.workspaceId);
    const factService = new KnowledgeFactService(this.root, this.database, this.workspaceId);
    for (const row of rows) {
      try {
        const bytes = await readFile(await resolveWorkspaceFile(this.root, row.sourcePath));
        const snapshot = await factService.readSnapshot(row.revisionId);
        const source = factSourceContract(JSON.parse(bytes.toString("utf8")));
        if (!bytes.equals(snapshot) || sha(bytes) !== row.contentDigest || source.factId !== row.factId || source.revisionId !== row.revisionId
          || source.kind !== row.kind || source.language !== row.language || stableJson(source.scope) !== row.scopeJson || stableJson(source.content) !== row.contentJson) throw new Error();
      } catch { throw new Error("knowledge fact source verification failed"); }
    }
    const directory = await ensureWorkspaceDirectory(this.root, "derived");
    const target = join(directory, "knowledge-index.sqlite3");
    const temporary = join(directory, `.knowledge-index-${this.id()}.sqlite3`);
    try {
      createIndex(temporary, this.workspaceId, rows, this.now().toISOString(), this.inject);
      this.inject("after-build");
      this.inject("before-swap");
      await rename(temporary, target);
      this.inject("after-swap");
      return this.manifest();
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  manifest() {
    const index = this.#open();
    try {
      const row = index.prepare("SELECT * FROM index_manifest WHERE singleton = 1").get();
      return Object.freeze({
        workspaceId: row.workspace_id, schemaVersion: row.schema_version,
        retrieverVersion: row.retriever_version, normalizerVersion: row.normalizer_version,
        tokenizer: row.tokenizer, factSetDigest: row.fact_set_digest,
        factCount: row.fact_count, builtAt: row.built_at,
      });
    } finally { index.close(); }
  }

  diagnostics() {
    const index = this.#open();
    try {
      const compileOptions = index.pragma("compile_options").map((row) => row.compile_options);
      return Object.freeze({
        sqliteVersion: index.prepare("SELECT sqlite_version() AS version").get().version,
        fts5: compileOptions.includes("ENABLE_FTS5"), tokenizer: FTS_TOKENIZER,
        schemaVersion: FTS_INDEX_SCHEMA_VERSION, retrieverVersion: FTS_RETRIEVER_VERSION,
        normalizerVersion: FTS_NORMALIZER_VERSION,
      });
    } finally { index.close(); }
  }

  search(input) {
    const request = retrieverRequestContract(input);
    const index = this.#open();
    try {
      const candidates = [];
      const seen = new Set();
      const exactRows = index.prepare(`
        SELECT r.*, -1000000000.0 AS score FROM knowledge_exact e
        JOIN knowledge_rows r ON r.fact_id = e.fact_id
        WHERE e.normalized = ? AND r.language = ? ORDER BY r.fact_id
      `).all(normalize(request.query), request.language);
      for (const row of exactRows) if (request.kinds.includes(row.kind) && applies(row, request)) {
        candidates.push({ ...row, query: request.query }); seen.add(row.fact_id);
      }
      const match = ftsQuery(request.query);
      if (match) {
        const rows = index.prepare(`
          SELECT r.*, bm25(knowledge_fts, 0, 0, 0, 0, 8.0, 2.0, 12.0, 4.0) AS score
          FROM knowledge_fts JOIN knowledge_rows r ON r.fact_id = knowledge_fts.fact_id
          WHERE knowledge_fts MATCH ? AND r.language = ?
          ORDER BY score, r.fact_id LIMIT 500
        `).all(match, request.language);
        for (const row of rows) if (!seen.has(row.fact_id) && request.kinds.includes(row.kind) && applies(row, request)) {
          candidates.push({ ...row, query: request.query }); seen.add(row.fact_id);
        }
      }
      return Object.freeze(candidates.slice(0, request.topK).map((row, index) => hit(row, index + 1)));
    } finally { index.close(); }
  }

  #open() {
    const filename = join(this.root, "derived", "knowledge-index.sqlite3");
    const root = realpathSync(this.root);
    const derivedInfo = lstatSync(join(this.root, "derived"));
    const fileInfo = lstatSync(filename);
    const resolved = realpathSync(filename);
    const relation = relative(root, resolved);
    if (derivedInfo.isSymbolicLink() || !derivedInfo.isDirectory() || fileInfo.isSymbolicLink() || !fileInfo.isFile()
      || relation === "" || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw new Error("knowledge index path is invalid");
    const index = new Database(filename, { readonly: true, fileMustExist: true });
    try {
      const manifest = index.prepare("SELECT workspace_id AS workspaceId, schema_version AS schemaVersion, retriever_version AS retrieverVersion FROM index_manifest WHERE singleton = 1").get();
      if (!manifest || manifest.workspaceId !== this.workspaceId || manifest.schemaVersion !== FTS_INDEX_SCHEMA_VERSION || manifest.retrieverVersion !== FTS_RETRIEVER_VERSION) {
        throw new Error("knowledge index identity mismatch");
      }
      const digest = index.prepare("SELECT fact_set_digest AS factSetDigest FROM index_manifest WHERE singleton = 1").get().factSetDigest;
      if (digest !== activeFactSetDigest(this.database, this.workspaceId)) throw new Error("knowledge index is stale");
      return index;
    } catch (error) { index.close(); throw error; }
  }
}
