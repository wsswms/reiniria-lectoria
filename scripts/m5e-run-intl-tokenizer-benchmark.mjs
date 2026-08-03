import { createHash } from "node:crypto";
import { chmod, lstat, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

const WARMUPS = 3; const ITERATIONS = 30;
const sha = (value) => `sha256:${createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
async function privateJson(path) {
  const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0
    || stat.size < 1 || stat.size > 16 * 1024 * 1024) throw new Error("Intl tokenizer input is invalid");
  return JSON.parse(await readFile(path, "utf8"));
}
async function writePrivate(path, value) {
  const parent = await lstat(dirname(path)); if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0) throw new Error("Intl output parent is invalid");
  const handle = await open(path, "wx", 0o600); try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); } finally { await handle.close(); }
  await chmod(path, 0o600);
}
function tokenize(document, language, instance) {
  const tokens = [];
  for (const segment of document.segments) for (const item of instance.segment(segment[language])) if (item.isWordLike) {
    tokens.push(Object.freeze({ segmentId: segment.segmentId, value: item.segment, start: item.index, end: item.index + item.segment.length }));
  }
  return tokens;
}
function percentile(values, fraction) { const sorted = [...values].sort((left, right) => left - right); return sorted[Math.floor((sorted.length - 1) * fraction)]; }
function median(values) { const sorted = [...values].sort((left, right) => left - right); return (sorted[14] + sorted[15]) / 2; }
function benchmark(document, language, locale) {
  const instance = new Intl.Segmenter(locale, { granularity: "word" }); for (let index = 0; index < WARMUPS; index += 1) tokenize(document, language, instance);
  const durations = [], digests = []; let tokens;
  for (let index = 0; index < ITERATIONS; index += 1) {
    const started = performance.now(); const current = tokenize(document, language, instance); durations.push(performance.now() - started);
    if (index < 5) digests.push(sha(current)); if (tokens === undefined) tokens = current;
  }
  return Object.freeze({ documentId: document.articleId, language, engine: `intl-${locale}`, tokens, tokenDigest: sha(tokens), determinismDigests: Object.freeze(digests),
    timing: Object.freeze({ iterations: ITERATIONS, minimumMs: Math.min(...durations), p50Ms: median(durations), p95Ms: percentile(durations, 0.95), maximumMs: Math.max(...durations) }) });
}

if (process.env.M5E_TOKENIZER_SPIKE !== "execute") throw new Error("Intl tokenizer spike requires explicit execute gate");
const corpus = await privateJson(process.env.M5E_TOKENIZER_CORPUS); if (corpus?.schemaVersion !== "m5e-tokenizer-corpus-v1" || corpus.documents?.length !== 2) throw new Error("Intl corpus schema mismatch");
const results = corpus.documents.flatMap((document) => [benchmark(document, "ja", "ja"), benchmark(document, "zh", "zh-CN")]);
const output = Object.freeze({ schemaVersion: "m5e-tokenizer-results-v1", runtime: Object.freeze({ node: process.version, icu: process.versions.icu,
  unicode: process.versions.unicode, cldr: process.versions.cldr, peakRssBytes: process.memoryUsage.rss() }), warmups: WARMUPS, iterations: ITERATIONS, results: Object.freeze(results) });
await writePrivate(process.env.M5E_TOKENIZER_OUTPUT, output);
process.stdout.write(`${JSON.stringify({ status: "completed", results: results.length, runtime: output.runtime })}\n`);
