import { createHash } from "node:crypto";
import { chmod, lstat, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const EXPECTED_MANIFEST_DIGEST = "sha256:46329be71e7fb9b6cbbab5027d3d6220719eb8c4272294b0124e75c78eda287f";
const EXPECTED = Object.freeze({ "nikon-omoshiro-part1": 54, "nikon-omoshiro-part2": 62 });
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function privateFile(path, maximum = 16 * 1024 * 1024) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > maximum) {
    throw new Error("tokenizer spike input is invalid");
  }
  return readFile(path);
}
async function writePrivate(path, value) {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0) throw new Error("tokenizer output parent is invalid");
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); } finally { await handle.close(); }
  await chmod(path, 0o600); return sha(await readFile(path));
}
function parseCall(bytes) {
  const events = bytes.toString("utf8").trim().split("\n").map(JSON.parse); const requestEvent = events.find((event) => event?.event === "request");
  const responseEvent = events.find((event) => event?.event === "response");
  const request = JSON.parse(requestEvent?.request?.body?.messages?.[1]?.content ?? "null"); const response = JSON.parse(responseEvent?.response?.content ?? "null");
  if (request?.segments?.length !== 1 || response?.candidates?.length !== 1 || responseEvent?.outcome?.normalized !== true
    || request.segments[0].segmentId !== response.candidates[0].segmentId) throw new Error("translation audit call is invalid");
  const segmentId = request.segments[0].segmentId, ja = request.segments[0].sourceText, zh = response.candidates[0].text;
  if (![segmentId, ja, zh].every((value) => typeof value === "string" && value.length > 0)) throw new Error("translation audit text is invalid");
  return Object.freeze({ segmentId, ja, zh });
}

if (process.env.M5E_TOKENIZER_CORPUS_BUILD !== "execute") throw new Error("tokenizer corpus build requires explicit execute gate");
const manifestPath = process.env.M5E_TOKENIZER_AUDIT_MANIFEST; const manifestBytes = await privateFile(manifestPath);
if (sha(manifestBytes) !== EXPECTED_MANIFEST_DIGEST) throw new Error("tokenizer source manifest digest mismatch");
const manifest = JSON.parse(manifestBytes.toString("utf8")); const entries = manifest.entries.filter((entry) => entry?.role === "translation")
  .sort((left, right) => left.sequence - right.sequence);
const grouped = new Map(Object.keys(EXPECTED).map((articleId) => [articleId, []]));
for (const entry of entries) {
  if (!grouped.has(entry.articleId) || entry.status !== "completed" || entry.normalized !== true) throw new Error("translation manifest entry is invalid");
  grouped.get(entry.articleId).push(parseCall(await privateFile(join(dirname(manifestPath), "llm-calls", entry.filename))));
}
for (const [articleId, count] of Object.entries(EXPECTED)) if (grouped.get(articleId).length !== count) throw new Error("translation corpus count mismatch");
const corpus = Object.freeze({ schemaVersion: "m5e-tokenizer-corpus-v1", sourceManifestDigest: EXPECTED_MANIFEST_DIGEST,
  documents: Object.freeze([...grouped.entries()].map(([articleId, segments]) => Object.freeze({ articleId, segments: Object.freeze(segments) }))) });
const digest = await writePrivate(process.env.M5E_TOKENIZER_CORPUS_OUTPUT, corpus);
process.stdout.write(`${JSON.stringify({ status: "completed", documents: corpus.documents.map((document) => ({ articleId: document.articleId,
  segments: document.segments.length, jaCharacters: document.segments.reduce((sum, segment) => sum + segment.ja.length, 0),
  zhCharacters: document.segments.reduce((sum, segment) => sum + segment.zh.length, 0) })), digest })}\n`);
