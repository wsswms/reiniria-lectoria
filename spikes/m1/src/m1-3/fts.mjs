import { DatabaseSync } from "node:sqlite";

function quoteQuery(text) {
  return `"${text.replaceAll('"', '""')}"`;
}

function thematicQuery(text) {
  const normalized = text.normalize("NFKC").trim();
  const terms = normalized.includes(" ")
    ? normalized.split(/\s+/).filter((term) => [...term].length >= 3)
    : [...normalized].map((_, index, characters) => characters.slice(index, index + 3).join("")).filter((term) => [...term].length === 3);
  return [...new Set(terms)].map(quoteQuery).join(" OR ");
}

export class FtsSpikeIndex {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.facts = [];
    this.createSchema();
  }

  createSchema() {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        document_id UNINDEXED,
        workspace_id UNINDEXED,
        language UNINDEXED,
        title,
        body,
        tokenize='trigram case_sensitive 0'
      );
    `);
  }

  replaceFacts(documents) {
    this.facts = documents.map((document) => ({ ...document }));
    this.db.exec("DELETE FROM knowledge_fts;");
    const insert = this.db.prepare(`
      INSERT INTO knowledge_fts(document_id, workspace_id, language, title, body)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      for (const document of this.facts) {
        insert.run(document.id, document.workspaceId, document.language, document.title, document.body);
      }
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  search({ workspaceId, language, query, exact = false, limit = 5 }) {
    if (!workspaceId) throw new Error("workspaceId is required");
    if (!language) throw new Error("language is required");
    const statement = this.db.prepare(`
      SELECT document_id AS id, workspace_id AS workspaceId, language, bm25(knowledge_fts) AS score
      FROM knowledge_fts
      WHERE knowledge_fts MATCH ? AND workspace_id = ? AND language = ?
      ORDER BY score ASC, document_id ASC
      LIMIT ?
    `);
    return statement.all(exact ? quoteQuery(query) : thematicQuery(query), workspaceId, language, limit);
  }

  rebuild() {
    const facts = this.facts.map((document) => ({ ...document }));
    this.db.exec("DROP TABLE knowledge_fts;");
    this.createSchema();
    this.replaceFacts(facts);
  }

  sqliteInfo() {
    const version = this.db.prepare("SELECT sqlite_version() AS version").get().version;
    const options = this.db.prepare("PRAGMA compile_options").all().map((row) => row.compile_options);
    return { version, fts5: options.includes("ENABLE_FTS5"), tokenizer: "trigram" };
  }

  close() {
    this.db.close();
  }
}

export function evaluateQueries(index, queries) {
  const results = queries.map((query) => {
    const hits = index.search({ ...query, exact: query.kind === "exact" });
    const hitIds = hits.map((hit) => hit.id);
    const relevantHits = query.relevant.filter((id) => hitIds.includes(id));
    return {
      id: query.id,
      language: query.language,
      kind: query.kind,
      hits: hitIds,
      recallAt5: relevantHits.length / query.relevant.length,
      firstRelevant: query.relevant.includes(hitIds[0]),
      wrongWorkspace: hits.filter((hit) => hit.workspaceId !== query.workspaceId).length,
    };
  });
  const average = (items) => items.reduce((sum, item) => sum + item.recallAt5, 0) / items.length;
  return {
    results,
    macroRecallAt5: average(results),
    byLanguage: Object.fromEntries(
      ["zh", "ja", "en"].map((language) => [language, average(results.filter((result) => result.language === language))]),
    ),
    exactFirstRate: results.filter((result) => result.kind === "exact" && result.firstRelevant).length
      / results.filter((result) => result.kind === "exact").length,
    wrongWorkspace: results.reduce((sum, result) => sum + result.wrongWorkspace, 0),
  };
}
