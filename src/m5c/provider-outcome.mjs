const UNCERTAIN_AFTER_HANDOFF = new Set([
  "canceled",
  "malformed-response",
  "provider",
  "timeout",
  "unknown-outcome",
]);

export function isUncertainProviderOutcome(errorOrCategory) {
  const category = typeof errorOrCategory === "string" ? errorOrCategory : errorOrCategory?.category;
  return UNCERTAIN_AFTER_HANDOFF.has(category);
}

export const M5C_UNCERTAIN_PROVIDER_OUTCOMES = Object.freeze([...UNCERTAIN_AFTER_HANDOFF]);
