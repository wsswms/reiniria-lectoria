import { fstatSync, readSync } from "node:fs";
import { adapterManifest } from "./adapter-manifest.mjs";
import { SerperSearchAdapter, TavilyExtractAdapter, TavilySearchAdapter } from "./provider-web-adapters.mjs";
import { BraveResearchSearchAdapter, ResearchWebAdapterBroker } from "./web-adapter-broker.mjs";

async function input(maximum) { const chunks = []; let size = 0; for await (const chunk of process.stdin) {
  size += chunk.length; if (size > maximum) throw new Error(); chunks.push(chunk); } return Buffer.concat(chunks).toString("utf8"); }
function secret(fd, maximum = 16 * 1024) { const buffer = Buffer.alloc(maximum + 1); const positional = fstatSync(fd).isFile(); let size = 0;
  while (size < buffer.length) { const count = readSync(fd, buffer, size, buffer.length - size, positional ? size : null); if (!count) break; size += count; }
  if (size > maximum) throw new Error(); return buffer.subarray(0, size).toString("utf8").trim(); }

try {
  const envelope = JSON.parse(await input(64 * 1024));
  if (!envelope || Object.keys(envelope).some((key) => !["providerId", "capability", "request", "credentialRef"].includes(key))) throw Object.assign(new Error(), { category: "policy" });
  const manifest = adapterManifest(envelope.providerId, envelope.capability);
  if (envelope.credentialRef !== manifest.credentialRef) throw Object.assign(new Error(), { category: "policy" });
  const adapters = new Map([["brave-search", new BraveResearchSearchAdapter()], ["serper-search", new SerperSearchAdapter()],
    ["tavily-search", new TavilySearchAdapter()], ["tavily-extract", new TavilyExtractAdapter()]]);
  const broker = new ResearchWebAdapterBroker({ adapters, resolveCredential: async (reference) => {
    if (reference !== manifest.credentialRef) throw new Error(); return secret(3); } });
  const response = await broker.invoke(envelope.providerId, envelope.capability, envelope.request);
  process.stdout.write(`${JSON.stringify({ ok: true, response })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { category: error?.category ?? "provider", retryable: error?.retryable === true,
    ...(error?.providerCode === undefined ? {} : { providerCode: String(error.providerCode) }) } })}\n`);
  process.exitCode = 1;
}
