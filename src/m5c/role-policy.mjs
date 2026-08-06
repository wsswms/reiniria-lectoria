export const PRODUCTION_PROVIDER_OUTPUT_CEILING = 65_536;
export const PRODUCTION_RESPONSE_BYTES_CEILING = 4 * 1024 * 1024;
export const PRODUCTION_REQUEST_BYTES_CEILING = 2 * 1024 * 1024;

export function documentSizeTier(segmentCount) {
  if (!Number.isSafeInteger(segmentCount) || segmentCount < 1 || segmentCount > 128) throw new TypeError("segmentCount is out of bounds");
  return segmentCount <= 16 ? "short" : segmentCount <= 48 ? "medium" : "long";
}

export function roleOutputReservation({ role, segmentCount, qaMode = "enabled" }) {
  const tier = documentSizeTier(segmentCount);
  if (role === "planner") return Object.freeze({ role, tier, maxOutputTokens: { short: 24_576, medium: 49_152, long: 65_536 }[tier] });
  if (role !== "qa" || !["disabled", "enabled"].includes(qaMode)) throw new TypeError("role reservation is invalid");
  const enabled = { short: 32_768, medium: 49_152, long: 65_536 }[tier];
  const disabled = { short: 16_384, medium: 32_768, long: 49_152 }[tier];
  return Object.freeze({ role, tier, qaMode, maxOutputTokens: qaMode === "enabled" ? enabled : disabled });
}

export function productionFlowBudget(base, segmentCount, { qaMode = "enabled" } = {}) {
  const planner = roleOutputReservation({ role: "planner", segmentCount });
  const qa = roleOutputReservation({ role: "qa", segmentCount, qaMode });
  const categories = Object.fromEntries(Object.entries(base.categories).map(([name, value]) => [name, { ...value }]));
  categories.planner.maxOutputTokens = Math.max(categories.planner.maxOutputTokens, planner.maxOutputTokens);
  categories.qa.maxOutputTokens = Math.max(categories.qa.maxOutputTokens, qa.maxOutputTokens * base.maxQaCycles);
  const maxOutputTokens = Object.values(categories).reduce((sum, category) => sum + category.maxOutputTokens, 0);
  return Object.freeze({ ...base, maxOutputTokens, categories: Object.freeze(Object.fromEntries(Object.entries(categories)
    .map(([name, value]) => [name, Object.freeze(value)]))), roleReservations: Object.freeze({ planner, qa }) });
}
