import { readFileSync } from "node:fs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const credential = readFileSync(3, "utf8").trim();
if (credential !== "fixture-agent-secret" || process.argv.includes(credential) || process.env.DEEPSEEK_API_KEY) {
  process.stdout.write(JSON.stringify({ ok: false, error: { category: "auth", retryable: false } }));
  process.exitCode = 1;
} else {
  const segmentId = envelope.request.context.messages[0].segmentId;
  process.stdout.write(JSON.stringify({ ok: true, response: { responseId: "fixture-agent", providerId: "deepseek", modelId: envelope.request.modelId,
    candidates: [{ segmentId, text: "离线译文" }], usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 } } }));
}
