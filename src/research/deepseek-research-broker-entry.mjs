import { fstatSync, readSync } from "node:fs";
import { DEEPSEEK_RESEARCH_CREDENTIAL_REF } from "./deepseek-research-broker-process.mjs";
import { DeepSeekServerResearchAdapter } from "./deepseek-server-research-adapter.mjs";

async function input(maximum) { const chunks = []; let size = 0; for await (const chunk of process.stdin) {
  size += chunk.length; if (size > maximum) throw new Error(); chunks.push(chunk); } return Buffer.concat(chunks).toString("utf8"); }
function secret(fd, maximum = 16 * 1024) { const buffer = Buffer.alloc(maximum + 1); const positional = fstatSync(fd).isFile(); let size = 0;
  while (size < buffer.length) { const count = readSync(fd, buffer, size, buffer.length - size, positional ? size : null); if (!count) break; size += count; }
  if (size > maximum) throw new Error(); return buffer.subarray(0, size).toString("utf8").trim(); }

try {
  const envelope = JSON.parse(await input(64 * 1024));
  if (!envelope || Object.keys(envelope).sort().join(",") !== "credentialRef,researchCase,schemaVersion"
    || envelope.schemaVersion !== "deepseek-research-broker-envelope-v1" || envelope.credentialRef !== DEEPSEEK_RESEARCH_CREDENTIAL_REF) {
    throw Object.assign(new Error(), { category: "policy" });
  }
  const response = await new DeepSeekServerResearchAdapter().research(envelope.researchCase, { credential: secret(3) });
  process.stdout.write(`${JSON.stringify({ ok: true, response })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { category: error?.category ?? "provider", retryable: error?.retryable === true,
    ...(error?.providerStatus === undefined ? {} : { providerStatus: String(error.providerStatus) }) } })}\n`);
  process.exitCode = 1;
}
