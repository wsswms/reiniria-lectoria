import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { buildP1LiteDeepSeekBody } from "../src/m5e/p1-lite.mjs";

const FIXED = Object.freeze([
  Object.freeze({ articleId: "nikon-omoshiro-part1", env: "M5E_P1LITE_INPUT_ONE", localItems: 239,
    digest: "sha256:f08ec7290eb4266a563385b31667e7fcea38989c517c93746b21590147a8936a" }),
  Object.freeze({ articleId: "nikon-omoshiro-part2", env: "M5E_P1LITE_INPUT_TWO", localItems: 226,
    digest: "sha256:3d35fb21871658ba1ee94eeb0a38c99e0b61ef804ef76c73213178fc9020f54d" }),
]);
const sha = (value) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

async function plannerRequest(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > 512 * 1024) {
    throw new Error("P1-Lite input is not a current-user 0600 audit file");
  }
  const events = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line)); const request = events.find((event) => event?.event === "request");
  if (events.filter((event) => event?.event === "request").length !== 1 || !request?.request?.body?.messages?.[1]?.content) throw new Error("P1-Lite audit request is missing");
  return JSON.parse(request.request.body.messages[1].content);
}

if (process.env.M5E_P1LITE_PREFLIGHT !== "check") throw new Error("P1-Lite preflight requires explicit check gate");
let credential;
try {
  credential = await openCredentialFile(process.env.DEEPSEEK_KEY_FILE); const articles = [];
  for (const expected of FIXED) {
    const request = await plannerRequest(process.env[expected.env]);
    if (sha(request) !== expected.digest || request.localItems?.length !== expected.localItems || request.schemaVersion !== "m5c-planner-request-v1") {
      throw new Error("P1-Lite fixed request identity mismatch");
    }
    const disabled = buildP1LiteDeepSeekBody({ plannerRequest: request, modelId: "deepseek-v4-flash", thinking: "disabled", maxOutputTokens: 65_536 });
    const enabled = buildP1LiteDeepSeekBody({ plannerRequest: request, modelId: "deepseek-v4-flash", thinking: "enabled", maxOutputTokens: 65_536 });
    if (JSON.stringify({ ...disabled, thinking: null }) !== JSON.stringify({ ...enabled, thinking: null })) throw new Error("thinking is not the only request variable");
    const bytes = Buffer.byteLength(JSON.stringify(disabled)); if (bytes > 4 * 1024 * 1024) throw new Error("P1-Lite request exceeds broker input ceiling");
    articles.push(Object.freeze({ articleId: expected.articleId, requestDigest: expected.digest, localItems: expected.localItems, requestBytes: bytes }));
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: "m5e-p1-lite-preflight-v1", status: "ready", articles,
    modes: ["disabled", "enabled"], logicalCalls: 4, maximumNewActualAttempts: 4, priorDiagnosticActualAttempts: 2,
    maximumCumulativeActualAttempts: 8, maximumCostMicrosCny: 5_000_000,
    maximumOutputTokensPerAttempt: 65_536, braveCalls: 0, fetchUrls: 0, researchModelCalls: 0, credentialRead: false })}\n`);
} finally { await credential?.close(); }
