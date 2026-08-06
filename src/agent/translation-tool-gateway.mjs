import { stableJson } from "../domain/contracts.mjs";
import { TranslationNumberTool } from "../tools/translation-number-tool.mjs";
import { TranslationReferenceTool } from "../tools/translation-reference-tool.mjs";
import { TranslationToolConfigurationConflictError, TranslationToolConfigurationService } from "../tools/translation-tool-configuration-service.mjs";

const mapping = Object.freeze({ lookup_dictionary: "dictionary", lookup_entity: "entity", calculate_number: "number" });
const textResult = (value, details) => Object.freeze({ content: Object.freeze([{ type: "text", text: stableJson(value) }]), details: Object.freeze(details) });

export class AgentTranslationToolGateway {
  constructor(database, workspaceId, { configurations, referenceTool, numberTool, adapters } = {}) {
    this.configurations = configurations ?? new TranslationToolConfigurationService(database, workspaceId);
    this.reference = referenceTool ?? new TranslationReferenceTool(database, workspaceId, { adapters: adapters ?? new Map() });
    this.number = numberTool ?? new TranslationNumberTool(database, workspaceId, { configurations: this.configurations });
  }

  enabledTools(taskId) {
    let configuration;
    try { configuration = this.configurations.get(taskId).configuration; }
    catch (error) { if (error instanceof TranslationToolConfigurationConflictError && /not found/u.test(error.message)) return Object.freeze([]); throw error; }
    return Object.freeze(Object.entries(mapping).filter(([, kind]) => configuration[kind] !== null).map(([name]) => name));
  }

  estimate(taskId, toolName) {
    const kind = mapping[toolName]; if (!kind || kind === "number") return Object.freeze({ calls: 0, inputTokens: 0, outputTokens: 0,
      costMicrosCny: 0, costMicrosUsd: 0, durationMs: 0 });
    const binding = this.configurations.binding(taskId, kind);
    return Object.freeze({ calls: 1, inputTokens: 128 * 1024, outputTokens: 16 * 1024, costMicrosCny: 0,
      costMicrosUsd: binding.maxCostMicrosUsd, durationMs: 60_000 });
  }

  async execute(taskId, request, options = {}) {
    const kind = mapping[request?.toolName]; if (!kind) throw new TypeError("translation tool is not allowed");
    this.configurations.binding(taskId, kind);
    if (kind === "number") {
      const prior = this.number.receipts.find(taskId, request.arguments); const receipt = this.number.execute(taskId, request.arguments);
      return Object.freeze({ result: textResult(receipt, { receiptDigest: receipt.receiptDigest, exact: true }), cacheHit: prior !== null,
        receiptDigest: receipt.receiptDigest });
    }
    const execution = await this.reference.execute(taskId, kind, request.arguments, options); const value = execution.result; const cached = execution.cached;
    const usage = Object.freeze({ calls: cached ? 0 : 1, inputTokens: cached ? 0 : value.usage.modelTokens, outputTokens: 0,
      costMicrosCny: 0, costMicrosUsd: cached ? 0 : value.usage.costMicrosUsd, durationMs: 0 });
    return Object.freeze({ result: textResult(value, { resultDigest: value.resultDigest, mayModifyTranslation: false, mayApproveKnowledge: false }),
      cacheHit: cached, usage });
  }
}
