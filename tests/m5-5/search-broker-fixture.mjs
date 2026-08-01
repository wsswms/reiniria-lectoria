import { readFileSync } from "node:fs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const credential = readFileSync(3, "utf8").trim();
if (envelope.credentialRef !== "external-file:brave-search/m5" || credential.length === 0) process.exit(2);
process.stdout.write(`${JSON.stringify({ ok: true, response: {
  adapterId: "brave-search", adapterVersion: "brave-web-search-v1",
  results: [{ rank: 1, url: "https://example.com/", title: "Fixture", description: "Broker fixture" }],
} })}\n`);
