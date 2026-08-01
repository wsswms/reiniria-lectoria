import { fstatSync, readSync } from "node:fs";
import { BraveSearchAdapter } from "./brave-search-adapter.mjs";
import { searchRequestContract } from "./contracts.mjs";

async function readInput(maximum) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > maximum) throw new Error(); chunks.push(chunk); }
  return Buffer.concat(chunks).toString("utf8");
}

function credential(fd, maximum = 16 * 1024) {
  const buffer = Buffer.alloc(maximum + 1);
  const positional = fstatSync(fd).isFile();
  let size = 0;
  while (size < buffer.length) { const count = readSync(fd, buffer, size, buffer.length - size, positional ? size : null); if (count === 0) break; size += count; }
  if (size > maximum) throw new Error();
  return buffer.subarray(0, size).toString("utf8").trim();
}

try {
  const envelope = JSON.parse(await readInput(64 * 1024));
  if (envelope.credentialRef !== "external-file:brave-search/m5") throw Object.assign(new Error(), { category: "policy" });
  const response = await new BraveSearchAdapter().search(searchRequestContract(envelope.request), { credential: credential(3) });
  process.stdout.write(`${JSON.stringify({ ok: true, response })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { category: error?.category ?? "provider", retryable: error?.retryable === true,
    ...(error?.providerCode === undefined ? {} : { providerCode: String(error.providerCode) }) } })}\n`);
  process.exitCode = 1;
}
