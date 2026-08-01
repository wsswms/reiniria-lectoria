import {
  providerErrorContract,
  providerRequestContract,
  providerResponseContract,
} from "./contracts.mjs";

const CREDENTIAL_REFERENCE = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9._/-]{1,160}$/;

export class BrokerInvocationError extends Error {
  constructor(contract) {
    const normalized = providerErrorContract(contract);
    super(normalized.message);
    this.name = "BrokerInvocationError";
    this.category = normalized.category;
    this.retryable = normalized.retryable;
    if (normalized.providerCode !== undefined) this.providerCode = normalized.providerCode;
  }
}

export function credentialReferenceContract(input) {
  if (typeof input !== "string" || !CREDENTIAL_REFERENCE.test(input)) {
    throw new TypeError("credentialRef must be an opaque namespaced reference");
  }
  return input;
}

export function createCredentialResolver(resolve) {
  if (typeof resolve !== "function") throw new TypeError("credential resolver must be a function");
  return Object.freeze({
    async withCredential({ providerId, credentialRef }, operation) {
      if (typeof providerId !== "string" || providerId.length === 0) throw new TypeError("providerId must be a non-empty string");
      const reference = credentialReferenceContract(credentialRef);
      if (typeof operation !== "function") throw new TypeError("credential operation must be a function");
      const credential = await resolve(Object.freeze({ providerId, credentialRef: reference }));
      if (typeof credential !== "string" || credential.length === 0) throw new BrokerInvocationError({
        category: "auth", message: "provider credential is unavailable", retryable: false,
      });
      return operation(credential);
    },
  });
}

function normalizeFailure(error) {
  if (error && typeof error === "object") {
    try {
      return providerErrorContract({
        category: error.category,
        message: error instanceof BrokerInvocationError ? error.message : "provider invocation failed",
        retryable: error.retryable,
        ...(error.providerCode === undefined ? {} : { providerCode: String(error.providerCode) }),
      });
    } catch {
      // Provider-private errors are deliberately collapsed below.
    }
  }
  return providerErrorContract({ category: "provider", message: "provider invocation failed", retryable: false });
}

export function createProviderBroker({ adapters, credentialResolver }) {
  if (!(adapters instanceof Map) || adapters.size === 0) throw new TypeError("adapters must be a non-empty Map");
  if (!credentialResolver || typeof credentialResolver.withCredential !== "function") {
    throw new TypeError("credentialResolver must implement withCredential");
  }
  const registry = new Map(adapters);
  for (const [providerId, adapter] of registry) {
    if (typeof providerId !== "string" || !adapter || typeof adapter.invoke !== "function") {
      throw new TypeError("each provider adapter must implement invoke");
    }
  }

  return Object.freeze({
    async invoke({ request: input, credentialRef, signal } = {}) {
      const request = providerRequestContract(input);
      const adapter = registry.get(request.providerId);
      if (!adapter) throw new BrokerInvocationError({ category: "policy", message: "provider is not allowed", retryable: false });
      try {
        const response = await credentialResolver.withCredential(
          { providerId: request.providerId, credentialRef },
          (credential) => adapter.invoke(request, Object.freeze({ credential, signal })),
        );
        return providerResponseContract(response, request);
      } catch (error) {
        if (error instanceof BrokerInvocationError) throw error;
        throw new BrokerInvocationError(normalizeFailure(error));
      }
    },
  });
}
