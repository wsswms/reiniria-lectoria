import { fstatSync, readSync } from "node:fs";
import { DeepSeekResearchAdapter } from "./deepseek-research-adapter.mjs";

async function readInput(maximum) { const chunks = []; let size = 0; for await (const chunk of process.stdin) {
  size += chunk.length; if (size > maximum) throw new Error(); chunks.push(chunk); } return Buffer.concat(chunks).toString("utf8"); }
function credential(fd, maximum = 16 * 1024) { const buffer = Buffer.alloc(maximum + 1); const positional = fstatSync(fd).isFile(); let size = 0;
  while (size < buffer.length) { const count = readSync(fd, buffer, size, buffer.length - size, positional ? size : null); if (!count) break; size += count; }
  if (size > maximum) throw new Error(); return buffer.subarray(0, size).toString("utf8").trim(); }

try {
  const envelope = JSON.parse(await readInput(8 * 1024 * 1024));
  if (!envelope || Object.keys(envelope).sort().join(",") !== "credentialRef,request"
    || envelope.credentialRef !== "external-file:deepseek/research-pilot") throw Object.assign(new Error(), { category: "policy" });
  const response = await new DeepSeekResearchAdapter().reason(envelope.request, { credential: credential(3) });
  process.stdout.write(`${JSON.stringify({ ok: true, response })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { category: error?.category ?? "provider", retryable: error?.retryable === true,
    ...(error?.providerCode === undefined ? {} : { providerCode: String(error.providerCode) }) } })}\n`); process.exitCode = 1;
}
