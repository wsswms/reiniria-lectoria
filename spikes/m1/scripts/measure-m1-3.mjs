import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { evaluateQueries, FtsSpikeIndex } from "../src/m1-3/fts.mjs";
import { documents, mirroredWorkspaceDocuments, queries } from "../tests/fixtures/m1-3/corpus.mjs";

const facts = [...documents, ...mirroredWorkspaceDocuments];
const index = new FtsSpikeIndex();
const started = performance.now();
index.replaceFacts(facts);
const indexedMs = performance.now() - started;
const before = evaluateQueries(index, queries);
const orderedBefore = before.results.map((result) => result.hits);
const rebuildStarted = performance.now();
index.rebuild();
const rebuildMs = performance.now() - rebuildStarted;
const after = evaluateQueries(index, queries);
const orderedAfter = after.results.map((result) => result.hits);

const output = {
  stage: "M1.3",
  corpus: {
    workspace_documents: documents.length,
    total_index_rows: facts.length,
    queries: queries.length,
    exact_queries: queries.filter((query) => query.kind === "exact").length,
    sha256: createHash("sha256").update(JSON.stringify({ documents, queries })).digest("hex"),
  },
  sqlite: index.sqliteInfo(),
  metrics: {
    exact_first_rate: before.exactFirstRate,
    macro_recall_at_5: before.macroRecallAt5,
    recall_at_5_by_language: before.byLanguage,
    wrong_workspace_hits: before.wrongWorkspace,
    ordered_results_identical_after_rebuild: JSON.stringify(orderedBefore) === JSON.stringify(orderedAfter),
    index_ms: indexedMs,
    rebuild_ms: rebuildMs,
  },
};

index.close();
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
