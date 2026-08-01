import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { searchWithCredentialFile } from "../src/search/credential-file.mjs";
import { stableJson } from "../src/domain/contracts.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

if (process.env.BRAVE_REAL_SEARCH !== "1") throw new Error("real Brave Search requires BRAVE_REAL_SEARCH=1");
const credentialPath = process.env.BRAVE_KEY_FILE;
if (typeof credentialPath !== "string" || credentialPath.length === 0) throw new Error("BRAVE_KEY_FILE is required");
const manifest = JSON.parse(await readFile(new URL("../tests/fixtures/m5-5/brave-real-search-manifest.json", import.meta.url), "utf8"));
if (manifest.schemaVersion !== "brave-real-search-manifest-v1" || !Array.isArray(manifest.queries)
  || manifest.queries.length < 2 || manifest.queries.length > 20 || manifest.maximumCalls !== manifest.queries.length) {
  throw new Error("real Brave manifest is invalid");
}

const results = [];
for (const item of manifest.queries) {
  const response = await searchWithCredentialFile({ credentialPath,
    credentialRef: "external-file:brave-search/m5",
    request: { query: item.query, count: item.count, country: item.country, searchLanguage: item.searchLanguage },
  }, { timeoutMs: 15_000 });
  results.push(Object.freeze({ id: item.id, adapterId: response.adapterId, adapterVersion: response.adapterVersion,
    resultCount: response.results.length, normalizedDigest: sha(stableJson(response)) }));
}

process.stdout.write(`${stableJson({ schemaVersion: "brave-real-search-result-v1", calls: results.length,
  manifestDigest: sha(stableJson(manifest)), results })}\n`);
