import { openCredentialFile } from "../provider/credential-file.mjs";
import { invokeDeepSeekResearchBroker } from "./research-broker-process.mjs";
import { DEEPSEEK_RESEARCH_ADAPTER_VERSION, DEEPSEEK_RESEARCH_PROVIDER_ID } from "./deepseek-research-adapter.mjs";

function price(usage, pricing) { const uncached = usage.inputTokens - usage.cachedInputTokens;
  return Math.ceil((uncached * pricing.inputMicrosPerMillion + usage.cachedInputTokens * pricing.cachedInputMicrosPerMillion
    + usage.outputTokens * pricing.outputMicrosPerMillion) / 1_000_000); }

export class BrokeredDeepSeekResearchAdapter {
  constructor({ credentialPath, modelId, maxOutputTokens, thinkingMode = "disabled", pricing, brokerOptions = {} } = {}) {
    this.id = DEEPSEEK_RESEARCH_PROVIDER_ID; this.credentialPath = credentialPath; this.modelId = modelId; this.maxOutputTokens = maxOutputTokens;
    this.thinkingMode = thinkingMode; this.pricing = pricing; this.brokerOptions = brokerOptions;
  }
  estimateReason(input) { const fixture = input.fixture ?? {}; const inputTokens = Buffer.byteLength(JSON.stringify({ prompt: input.prompt, fixture }));
    const amount = Math.ceil((inputTokens * this.pricing.inputMicrosPerMillion + this.maxOutputTokens * this.pricing.outputMicrosPerMillion) / 1_000_000);
    return Object.freeze({ searchCalls: 0, contentUrls: 0, modelTokens: inputTokens + this.maxOutputTokens, costMicrosUsd: amount }); }
  async reason(input) { const fixture = input.fixture ?? {}; const request = { modelId: this.modelId, questions: fixture.questions, evidence: fixture.evidence,
    maxOutputTokens: this.maxOutputTokens, thinkingMode: this.thinkingMode };
    const handle = await openCredentialFile(this.credentialPath); try { const response = await invokeDeepSeekResearchBroker({ request, credentialFd: handle.fd }, this.brokerOptions);
      const costMicrosUsd = price(response.usage, this.pricing); return Object.freeze({ ...response, adapterId: this.id, adapterVersion: DEEPSEEK_RESEARCH_ADAPTER_VERSION,
        usage: Object.freeze({ searchCalls: 0, contentUrls: 0, modelTokens: response.usage.totalTokens, costMicrosUsd }), tokenUsage: response.usage }); }
    finally { await handle.close(); } }
}
