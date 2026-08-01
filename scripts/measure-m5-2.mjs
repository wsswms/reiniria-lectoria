import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspaceDatabase } from "../src/db/connection.mjs";
import { stableJson } from "../src/domain/contracts.mjs";
import { FtsRetriever } from "../src/knowledge/fts-retriever.mjs";
import { KnowledgeFactService } from "../src/knowledge/fact-service.mjs";

const FACT_COUNT = 10_000;
const workspaceId = "00000000-0000-4000-8000-000000000001";
const uuid = (value) => `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const languages = ["en", "zh-CN", "ja"];
const root = await mkdtemp(join(tmpdir(), "lectoria-m5-2-scale-"));
for (const directory of ["private/objects", "private/ledger", "derived", "staging", "dictionary", "style", "knowledge"]) await mkdir(join(root, directory), { recursive: true });
const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId, now: () => new Date(0) });
const service = new KnowledgeFactService(root, database, workspaceId, { now: () => new Date(0) });

try {
  const sources = Array.from({ length: FACT_COUNT }, (_, index) => {
    const language = languages[index % languages.length];
    return {
      schemaVersion: "1.0", factId: uuid(index * 2 + 1), revisionId: uuid(index * 2 + 2), kind: "knowledge", language,
      scope: { targetLanguages: [language], tags: ["scale", `bucket-${index % 100}`] },
      content: {
        title: `Scale topic ${index}`,
        body: `Deterministic scale corpus record ${index} for workspace retrieval benchmark bucket ${index % 100}.`,
        tags: ["scale", `row-${index}`], source: "public-synthetic-m5-2-scale",
      },
    };
  });
  for (let offset = 0; offset < sources.length; offset += 100) {
    await Promise.all(sources.slice(offset, offset + 100).map((source) => service.create(source, { type: "fixture", id: "m5-2-scale" })));
  }
  const retriever = new FtsRetriever(root, database, workspaceId, { now: () => new Date(0), id: () => "00000000-0000-4000-8000-000000000099" });
  const rebuildStarted = performance.now();
  const manifest = await retriever.rebuild();
  const rebuildMs = performance.now() - rebuildStarted;
  for (let warm = 0; warm < 20; warm += 1) retriever.search({ query: `Scale topic ${warm}`, language: languages[warm % 3], kinds: ["knowledge"], tags: ["scale"], documentIds: [], topK: 10 });
  const latencies = [];
  for (let sample = 0; sample < 200; sample += 1) {
    const started = performance.now();
    retriever.search({ query: `Scale topic ${sample % 100}`, language: languages[sample % 3], kinds: ["knowledge"], tags: ["scale"], documentIds: [], topK: 10 });
    latencies.push(performance.now() - started);
  }
  latencies.sort((left, right) => left - right);
  const result = {
    format: "m5-2-scale-result-v1",
    factCount: FACT_COUNT,
    fixtureDigest: `sha256:${createHash("sha256").update(stableJson(sources)).digest("hex")}`,
    factSetDigest: manifest.factSetDigest,
    rebuildMs: Number(rebuildMs.toFixed(3)),
    warmQueryP95Ms: Number(latencies[Math.ceil(latencies.length * 0.95) - 1].toFixed(3)),
    processMaxRssMiB: Number((process.resourceUsage().maxRSS / 1024).toFixed(3)),
    thresholds: { rebuildMs: 60_000, warmQueryP95Ms: 100, processMaxRssMiB: 512 },
  };
  process.stdout.write(`${stableJson(result)}\n`);
  if (result.rebuildMs > 60_000 || result.warmQueryP95Ms > 100 || result.processMaxRssMiB > 512) process.exitCode = 1;
} finally {
  database.close();
  await rm(root, { recursive: true, force: true });
}
