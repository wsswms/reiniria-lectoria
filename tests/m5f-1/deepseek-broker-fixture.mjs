import { readSync } from "node:fs";
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const secret = Buffer.alloc(1024); const count = readSync(3, secret, 0, secret.length, 0);
if (!secret.subarray(0, count).toString("utf8").includes("M5F1-FD-CANARY")) process.exit(2);
const response = { schemaVersion: "deepseek-server-research-provider-result-v1", adapterId: "deepseek-server-research",
  adapterVersion: "deepseek-responses-web-search-v1", caseId: envelope.researchCase.caseId, responseId: "resp-broker-fixture",
  modelId: "deepseek-v4-flash", outcome: "not-found", answer: "", explanation: "No public synthetic result.", sources: [],
  droppedSources: [], actions: [{ type: "search", queries: ["synthetic"], url: null }],
  usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 1, totalTokens: 15 } };
process.stdout.write(`${JSON.stringify({ ok: true, response })}\n`);
