import { finalResearchResultContract } from "./deepseek-server-research-contracts.mjs";

const PERMISSIONS = Object.freeze({ mayModifyTranslation: false, mayApproveKnowledge: false });

export class DeepSeekServerResearchService {
  constructor({ adapter, verifier } = {}) {
    if (!adapter || typeof adapter.research !== "function" || !verifier || typeof verifier.verify !== "function") {
      throw new TypeError("DeepSeek research service dependencies are required");
    }
    this.adapter = adapter;
    this.verifier = verifier;
  }

  async research(input, options = {}) {
    const provider = await this.adapter.research(input, options);
    if (provider.outcome === "resolved-candidate") return this.verifier.verify(provider,
      { signal: options.signal, onVerifiedSource: options.onVerifiedSource });
    return finalResearchResultContract({ ...provider, schemaVersion: "deepseek-server-research-result-v1",
      answer: "", sources: [], permissions: PERMISSIONS });
  }
}
