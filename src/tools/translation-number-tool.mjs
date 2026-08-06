import { CalculationReceiptService } from "./calculation-receipt-service.mjs";
import { LocalNumberService, LOCAL_NUMBER_PROVIDER_ID, LOCAL_NUMBER_PROVIDER_VERSION } from "./local-number-service.mjs";
import { TranslationToolConfigurationService } from "./translation-tool-configuration-service.mjs";

export class TranslationNumberTool {
  constructor(database, workspaceId, options = {}) {
    this.configurations = options.configurations ?? new TranslationToolConfigurationService(database, workspaceId, options);
    this.receipts = options.receipts ?? new CalculationReceiptService(database, workspaceId, options);
    this.calculator = options.calculator ?? new LocalNumberService();
  }

  execute(taskId, request) {
    const binding = this.configurations.binding(taskId, "number");
    if (binding.providerId !== LOCAL_NUMBER_PROVIDER_ID || binding.providerVersion !== LOCAL_NUMBER_PROVIDER_VERSION) {
      throw new Error("untrusted number provider binding");
    }
    const existing = this.receipts.find(taskId, request);
    if (existing) return existing;
    return this.receipts.persist(taskId, request, this.calculator.calculate(request), binding.maxCalls);
  }
}
