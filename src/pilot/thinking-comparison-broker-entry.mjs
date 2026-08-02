import { fstatSync, readSync } from "node:fs";
import { buildDeepSeekThinkingComparisonRequest } from "./deepseek-thinking-comparison.mjs";

const MAX_INPUT = 512 * 1024;
const MAX_CREDENTIAL = 16 * 1024;
const MAX_RESPONSE = 4 * 1024 * 1024;

async function stdin() { const chunks = []; let size = 0; for await (const chunk of process.stdin) {
  size += chunk.length; if (size > MAX_INPUT) throw new Error("input-limit"); chunks.push(chunk); } return Buffer.concat(chunks).toString("utf8"); }
function credential(fd) { const output = Buffer.alloc(MAX_CREDENTIAL + 1); const positional = fstatSync(fd).isFile(); let size = 0;
  while (size < output.length) { const count = readSync(fd, output, size, output.length - size, positional ? size : null); if (!count) break; size += count; }
  if (size < 1 || size > MAX_CREDENTIAL) throw new Error("credential"); return output.subarray(0, size).toString("utf8").trim(); }
async function bounded(response) { const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > MAX_RESPONSE) throw new Error("output-limit"); return bytes.toString("utf8"); }

try {
  const envelope = JSON.parse(await stdin());
  if (!envelope || Object.keys(envelope).sort().join(",") !== "credentialRef,request"
    || envelope.credentialRef !== "external-file:deepseek/thinking-comparison") throw new Error("policy");
  const outbound = buildDeepSeekThinkingComparisonRequest(envelope.request);
  const started = Date.now();
  const response = await fetch(outbound.url, { method: "POST", headers: { authorization: `Bearer ${credential(3)}`, "content-type": "application/json" },
    body: JSON.stringify(outbound.body), redirect: "error" });
  const responseText = await bounded(response);
  process.stdout.write(`${JSON.stringify({ ok: true, result: { outbound, status: response.status, responseText, durationMs: Date.now() - started } })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, category: ["input-limit", "output-limit", "policy"].includes(error?.message) ? error.message : "unknown-outcome" })}\n`);
  process.exitCode = 1;
}
