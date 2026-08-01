import { readSync } from "node:fs";
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const secret = Buffer.alloc(1024); const count = readSync(3, secret, 0, secret.length, 0);
if (!secret.subarray(0, count).toString("utf8").includes("M5R3-FD-CANARY")) process.exit(2);
const response = envelope.capability === "search"
  ? { adapterId: envelope.providerId, adapterVersion: "serper-search-fixture-v1", results: [], responseDigest: `sha256:${"0".repeat(64)}`,
    usage: { searchCalls: 1, contentUrls: 0, modelTokens: 0, costMicrosUsd: 0 } }
  : { adapterId: envelope.providerId, adapterVersion: "tavily-extract-fixture-v1", url: envelope.request.url, content: "fixture",
    contentDigest: `sha256:${"0".repeat(64)}`, lineage: "provider-processed", directWebEvidence: false,
    usage: { searchCalls: 0, contentUrls: 1, modelTokens: 0, costMicrosUsd: 0 } };
process.stdout.write(`${JSON.stringify({ ok: true, response })}\n`);
