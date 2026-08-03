import { createHash } from "node:crypto";
import { chmod, lstat, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { analyzeTokenizerSpike } from "../src/m5e/tokenizer-spike-analysis.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
async function json(path, privateRequired = true) {
  const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || (privateRequired && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
    || stat.size < 1 || stat.size > 32 * 1024 * 1024) throw new Error("tokenizer analysis file is invalid"); return JSON.parse(await readFile(path, "utf8"));
}
async function save(path, value) {
  const parent = await lstat(dirname(path)); if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0) throw new Error("tokenizer analysis parent is invalid");
  const handle = await open(path, "wx", 0o600); try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); } finally { await handle.close(); }
  await chmod(path, 0o600); return sha(await readFile(path));
}

if (process.env.M5E_TOKENIZER_ANALYZE !== "execute") throw new Error("tokenizer analysis requires explicit execute gate");
const corpus = await json(process.env.M5E_TOKENIZER_CORPUS); const references = await json(process.env.M5E_TOKENIZER_REFERENCES, false);
const intl = await json(process.env.M5E_TOKENIZER_INTL_RESULTS); const specialized = await json(process.env.M5E_TOKENIZER_SPECIALIZED_RESULTS);
const analysis = analyzeTokenizerSpike(corpus, references, [intl, specialized]); const digest = await save(process.env.M5E_TOKENIZER_ANALYSIS_OUTPUT, analysis);
process.stdout.write(`${JSON.stringify({ status: "completed", engines: analysis.engines, digest })}\n`);
