import { dictionaryLookupRequestContract, entityLookupRequestContract } from "./contracts.mjs";
import { TranslationReferenceCacheService } from "./translation-reference-cache-service.mjs";
import { TranslationToolConfigurationService } from "./translation-tool-configuration-service.mjs";
import { verifyReferenceResult } from "./reference-result.mjs";

const contract = (kind, input) => kind === "dictionary"
  ? dictionaryLookupRequestContract(input) : entityLookupRequestContract(input);

export class TranslationReferenceTool {
  constructor(database, workspaceId, { adapters, configurations, cache } = {}) {
    if (!(adapters instanceof Map)) throw new TypeError("reference provider adapters are required");
    this.adapters = adapters;
    this.configurations = configurations ?? new TranslationToolConfigurationService(database, workspaceId);
    this.cache = cache ?? new TranslationReferenceCacheService(database, workspaceId, { configurations: this.configurations });
  }

  async execute(taskId, kind, input, options = {}) {
    if (!["dictionary", "entity"].includes(kind)) throw new TypeError("reference tool kind is invalid");
    const request = contract(kind, input);
    const binding = this.configurations.binding(taskId, kind);
    const cached = this.cache.get(taskId, kind, request);
    if (cached) return Object.freeze({ result: cached, cached: true });
    const adapter = this.adapters.get(binding.providerId);
    if (!adapter || typeof adapter.lookup !== "function") throw new Error("configured reference provider is unavailable");
    const result = verifyReferenceResult(await adapter.lookup(kind, request, binding, options));
    return Object.freeze({ result: this.cache.persist(taskId, kind, request, result), cached: false });
  }

  lookupDictionary(taskId, input, options) { return this.execute(taskId, "dictionary", input, options); }
  lookupEntity(taskId, input, options) { return this.execute(taskId, "entity", input, options); }
}
