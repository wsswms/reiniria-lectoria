import { DeterministicFakeProvider, FaultInjectingFakeProvider } from "./fake-provider.mjs";
import { GEMINI_PROVIDER_ID, GoogleGeminiProvider } from "./gemini-provider.mjs";

export function createProviderRegistry({ faultMode = "transport", fetchImpl = globalThis.fetch } = {}) {
  return new Map([
    ["fake-primary", new DeterministicFakeProvider({ id: "fake-primary" })],
    ["fake-fault", new FaultInjectingFakeProvider({ id: "fake-fault", mode: faultMode })],
    [GEMINI_PROVIDER_ID, new GoogleGeminiProvider({ fetchImpl })],
  ]);
}
