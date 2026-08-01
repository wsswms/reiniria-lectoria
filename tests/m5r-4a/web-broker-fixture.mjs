import { createHash } from "node:crypto";
import { readSync } from "node:fs";
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const credential = Buffer.alloc(16 * 1024 + 1); const size = readSync(3, credential, 0, credential.length, 0);
if (envelope.providerId !== "brave-search" || envelope.capability !== "search"
  || envelope.credentialRef !== "external-file:brave-search/m5r" || !credential.subarray(0, size).toString("utf8").includes("M5R4A-FD-CANARY")) process.exit(2);
const results = [{ rank: 1, title: "Public fixture", url: "https://example.com/public", description: "Bounded public fixture." }];
const digest = `sha256:${createHash("sha256").update(JSON.stringify(results)).digest("hex")}`;
process.stdout.write(`${JSON.stringify({ ok: true, response: { adapterId: "brave-search", adapterVersion: "brave-web-search-v1",
  results, responseDigest: digest, usage: { searchCalls: 1, contentUrls: 0, modelTokens: 0, costMicrosUsd: 0 } } })}\n`);
