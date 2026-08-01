import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspaceDatabase } from "../src/db/connection.mjs";
import { stableJson } from "../src/domain/contracts.mjs";
import { FtsRetriever } from "../src/knowledge/fts-retriever.mjs";
import { KnowledgeFactService } from "../src/knowledge/fact-service.mjs";
import { evaluateRetrieval } from "../src/knowledge/retrieval-evaluation.mjs";
import { retrievalDigest, retrievalFacts, retrievalManifest, retrievalQueries } from "../tests/fixtures/m5-2/retrieval-corpus.mjs";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const root = await mkdtemp(join(tmpdir(), "lectoria-m5-2-evaluation-"));
for (const directory of ["private/objects", "private/ledger", "derived", "staging", "dictionary", "style", "knowledge"]) await mkdir(join(root, directory), { recursive: true });
const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId, now: () => new Date(0) });
try {
  const service = new KnowledgeFactService(root, database, workspaceId, { now: () => new Date(0) });
  for (const source of retrievalFacts) await service.create(source, { type: "fixture", id: "m5-2-evaluation" });
  const retriever = new FtsRetriever(root, database, workspaceId, { now: () => new Date(0) });
  await retriever.rebuild();
  const evaluation = evaluateRetrieval(retriever, retrievalQueries);
  process.stdout.write(`${stableJson({
    format: "m5-2-relevance-result-v1", corpusDigest: retrievalDigest, manifest: retrievalManifest,
    metrics: {
      exactRecallAt1: evaluation.exactRecallAt1, shortRecallAt5: evaluation.shortRecallAt5,
      macroRecallAt5: evaluation.macroRecallAt5, mrrAt10: evaluation.mrrAt10,
      ndcgAt10: evaluation.ndcgAt10, byLanguageRecallAt5: evaluation.byLanguageRecallAt5,
      hardNegativeTop5Rate: evaluation.hardNegativeTop5Rate, noResultFailures: evaluation.noResultFailures,
    },
  })}\n`);
} finally { database.close(); await rm(root, { recursive: true, force: true }); }
