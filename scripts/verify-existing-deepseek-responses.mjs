import { readFile } from "node:fs/promises";
import { normalizeDeepSeekServerResearchResponse } from "../src/research/deepseek-server-research-adapter.mjs";
import { ConfiguredResearchSourcePolicy, DeepSeekResearchSourceVerifier } from "../src/research/deepseek-research-source-verifier.mjs";
import { RestrictedFetchProxy } from "../src/search/fetch-proxy.mjs";
import { createPinnedHttpsTransport, createRestrictedRobotsPolicy } from "../src/search/node-https-transport.mjs";

const rawDir = process.env.DEEPSEEK_EXISTING_RESPONSE_DIR;
const ids = String(process.env.DEEPSEEK_EXISTING_RESPONSE_IDS ?? "").split(",").filter(Boolean);
if (!rawDir || ids.length < 1 || ids.length > 12 || ids.some((id) => !/^[a-z0-9-]{3,64}$/.test(id))) throw new Error("existing response scope is invalid");
const manifest = JSON.parse(await readFile(new URL("../tests/fixtures/m5f-1/deepseek-real-integration-manifest.json", import.meta.url), "utf8"));
const historicalCases = JSON.parse(await readFile(`${rawDir}/../cases.json`, "utf8"));
const transport = createPinnedHttpsTransport();
const verifier = new DeepSeekResearchSourceVerifier({
  restrictedFetch: new RestrictedFetchProxy({ transport, robotsAllowed: createRestrictedRobotsPolicy({ transport }), timeoutMs: 20_000, maxConcurrency: 4 }),
  sourcePolicy: new ConfiguredResearchSourcePolicy({ rules: manifest.sourceRules }),
});
const observations = [];
for (const id of ids) {
  const testCase = historicalCases.find((item) => item.id === id);
  if (!testCase) throw new Error("historical case is missing");
  try {
    const raw = JSON.parse(await readFile(`${rawDir}/${id}.raw.json`, "utf8"));
    const provider = normalizeDeepSeekServerResearchResponse(raw.response.body, { schemaVersion: "deepseek-server-research-case-v1",
      caseId: id, question: testCase.question, responseLanguage: "zh-CN", maxOutputTokens: 6000, reasoningEffort: "medium" });
    const result = await verifier.verify(provider);
    observations.push({ id, providerOutcome: provider.outcome, resultOutcome: result.outcome,
      candidateHosts: provider.sources.map((source) => new URL(source.url).hostname),
      verifiedHosts: result.sources.map((source) => new URL(source.finalUrl).hostname),
      dropReasons: result.droppedSources.map((source) => source.reason) });
  } catch (error) { observations.push({ id, errorCategory: error?.category ?? "failed" }); }
}
process.stdout.write(`${JSON.stringify({ schemaVersion: "m5f1-existing-response-verification-v1", calls: 0, observations })}\n`);
