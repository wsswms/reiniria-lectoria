import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stableJson } from "../src/domain/contracts.mjs";
import { ConfiguredResearchSourcePolicy, DeepSeekResearchSourceVerifier } from "../src/research/deepseek-research-source-verifier.mjs";
import { DEEPSEEK_RESEARCH_CREDENTIAL_REF, invokeDeepSeekResearchBroker } from "../src/research/deepseek-research-broker-process.mjs";
import { DeepSeekResearchIntegrationService } from "../src/research/deepseek-research-integration-service.mjs";
import { RestrictedFetchProxy } from "../src/search/fetch-proxy.mjs";
import { createPinnedHttpsTransport, createRestrictedRobotsPolicy } from "../src/search/node-https-transport.mjs";
import { researchWorkspace } from "../tests/m5r-2/helpers.mjs";

if (process.env.DEEPSEEK_REAL_RESEARCH !== "1") throw new Error("real DeepSeek research requires DEEPSEEK_REAL_RESEARCH=1");
const credentialPath = process.env.DEEPSEEK_KEY_FILE;
const auditDir = process.env.DEEPSEEK_RESEARCH_AUDIT_DIR;
if (!credentialPath || !auditDir) throw new Error("credential and audit paths are required");
const manifest = JSON.parse(await readFile(new URL("../tests/fixtures/m5f-1/deepseek-real-integration-manifest.json", import.meta.url), "utf8"));
if (manifest.schemaVersion !== "m5f1-deepseek-real-integration-v1" || manifest.modelId !== "deepseek-v4-flash"
  || manifest.dataClass !== "public-synthetic" || manifest.maximumCalls !== manifest.cases.length || manifest.maximumCalls > 12
  || manifest.concurrency < 1 || manifest.concurrency > 4 || manifest.rawResponseRetention !== false || manifest.credentialInjection !== "fd-3") {
  throw new Error("real integration manifest is invalid");
}
const selectedIds = String(process.env.DEEPSEEK_RESEARCH_CASE_IDS ?? "").split(",").filter(Boolean);
const selectedCases = selectedIds.length ? selectedIds.map((id) => manifest.cases.find((item) => item.id === id)) : manifest.cases;
if (selectedCases.some((item) => !item) || new Set(selectedIds).size !== selectedIds.length) throw new Error("real case selection is invalid");
const credentialCheck = await open(credentialPath, "r");
const credentialStat = await credentialCheck.stat(); await credentialCheck.close();
if (!credentialStat.isFile() || (credentialStat.mode & 0o077) !== 0 || credentialStat.size < 1 || credentialStat.size > 16 * 1024) {
  throw new Error("credential file boundary is invalid");
}
await mkdir(auditDir, { recursive: true, mode: 0o700 }); await chmod(auditDir, 0o700);
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const transport = createPinnedHttpsTransport();
const fetchProxy = new RestrictedFetchProxy({ transport, robotsAllowed: createRestrictedRobotsPolicy({ transport }), timeoutMs: 20_000, maxConcurrency: 4 });
const policy = new ConfiguredResearchSourcePolicy({ rules: manifest.sourceRules });
const queue = [...selectedCases]; const observations = []; let providerCalls = 0;
const workers = Array.from({ length: manifest.concurrency }, async () => {
  while (queue.length) {
    const item = queue.shift();
    const fixture = await researchWorkspace({ modelProviderId: "deepseek-server-research", questions: [item.question],
      allowedLanguages: [...new Set([item.queryLanguage, item.responseLanguage])], startMilliseconds: Date.now(),
      limits: { maxSearchCalls: 30, maxContentUrls: 40, maxModelTokens: 100_000, maxCostMicrosUsd: 50_000 },
      providerBudgets: { "deepseek-server-research": { maxSearchCalls: 30, maxContentUrls: 40, maxModelTokens: 100_000, maxCostMicrosUsd: 50_000 } } });
    const started = Date.now();
    try {
      const integration = new DeepSeekResearchIntegrationService(fixture.setup.fixture.database, fixture.setup.fixture.workspaceId, {
        capabilities: fixture.capabilities, budgets: fixture.budgets, runs: fixture.runs, evidence: fixture.evidence,
        verifier: new DeepSeekResearchSourceVerifier({ restrictedFetch: fetchProxy, sourcePolicy: policy }),
        invokeProvider: async (input) => {
          providerCalls += 1; const credential = await open(credentialPath, "r");
          try { return await invokeDeepSeekResearchBroker({ ...input, credentialFd: credential.fd }, { timeoutMs: 180_000 }); }
          finally { await credential.close(); }
        },
        pricingSnapshot: { version: "deepseek-2026-08-05-usd-7.2", inputMicrosUsdPerMillion: 277_778,
          cachedInputMicrosUsdPerMillion: 27_778, outputMicrosUsdPerMillion: 416_667 },
      });
      const completed = await integration.execute({ runId: fixture.run.runId, capabilityToken: fixture.capability,
        researchCase: { schemaVersion: "deepseek-server-research-case-v1", caseId: item.id, question: item.question,
          responseLanguage: item.responseLanguage, maxOutputTokens: 12000, reasoningEffort: "medium" },
        round: 1, language: item.queryLanguage, country: item.queryLanguage === "ja" ? "JP" : item.queryLanguage === "zh-CN" ? "CN" : "US",
        idempotencyKey: `m5f1-real:${item.id}`, estimate: { searchCalls: 30, contentUrls: 40, modelTokens: 100_000, costMicrosUsd: 50_000 },
        credentialRef: DEEPSEEK_RESEARCH_CREDENTIAL_REF, credentialFd: 3 });
      observations.push({ id: item.id, expected: item.expected, resultOutcome: completed.result.outcome,
        reportOutcome: completed.report.outcome, termMatch: item.expectedTerms.length === 0 ? null
          : item.expectedTerms.every((term) => completed.result.answer.toLocaleLowerCase().includes(term.toLocaleLowerCase())),
        usage: completed.report.usage, latencyMs: Date.now() - started,
        sources: completed.result.sources.map((source) => ({ host: new URL(source.finalUrl).hostname, tier: source.tier,
          quoteExact: source.quoteExact, phraseCoverage: source.phraseCoverage })),
        dropReasons: completed.result.droppedSources.map((source) => source.reason) });
    } catch (error) {
      observations.push({ id: item.id, expected: item.expected, errorCategory: error?.category ?? "failed", latencyMs: Date.now() - started });
    } finally { await fixture.close(); }
  }
});
await Promise.all(workers); observations.sort((a, b) => a.id.localeCompare(b.id));
const positive = observations.filter((item) => item.expected === "resolved");
const negative = observations.filter((item) => item.expected === "unresolved");
const summary = { schemaVersion: "m5f1-deepseek-real-integration-result-v1", manifestDigest: sha(stableJson(manifest)),
  calls: providerCalls, cases: observations.length, selectedCaseIds: selectedCases.map((item) => item.id).sort(),
  positiveResolved: positive.filter((item) => item.resultOutcome === "resolved").length,
  positiveSupportedReports: positive.filter((item) => ["supported", "partial"].includes(item.reportOutcome)).length,
  negativeFalseClosures: negative.filter((item) => item.resultOutcome === "resolved").length,
  unknown: observations.filter((item) => item.errorCategory === "unknown-outcome").length,
  totalUsage: observations.reduce((sum, item) => Object.fromEntries(Object.keys(sum).map((key) => [key, sum[key] + (item.usage?.[key] ?? 0)])),
    { searchCalls: 0, contentUrls: 0, modelTokens: 0, costMicrosUsd: 0 }), rawResponsePersisted: false,
  fullPageTextInReport: false, observations };
const filename = join(auditDir, "report.json"); await writeFile(filename, `${stableJson(summary)}\n`, { mode: 0o600, flag: "wx" });
process.stdout.write(`${stableJson({ ...summary, observations: observations.map(({ sources, ...item }) => ({ ...item, sourceCount: sources?.length ?? 0 })) })}\n`);
