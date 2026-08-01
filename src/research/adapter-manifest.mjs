const CAPABILITIES = new Set(["search", "extract", "fetch"]);
const RESULT_TYPES = new Set(["search-snippet", "provider-content", "direct-content"]);

function exact(input, keys, name) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key))) throw new TypeError(`${name} is invalid`);
}

export function adapterManifestContract(input) {
  exact(input, ["schemaVersion", "adapterId", "adapterVersion", "capability", "origin", "resultType", "filters",
    "directWebEvidence", "credentialRef", "policySnapshot"], "adapter manifest");
  if (input.schemaVersion !== "research-adapter-manifest-v1" || !CAPABILITIES.has(input.capability) || !RESULT_TYPES.has(input.resultType)) throw new TypeError("adapter manifest contract is invalid");
  for (const key of ["adapterId", "adapterVersion"]) if (typeof input[key] !== "string" || input[key].length < 1 || input[key].length > 128) throw new TypeError("adapter manifest identity is invalid");
  if (input.origin !== null) { const origin = new URL(input.origin); if (origin.protocol !== "https:" || origin.origin !== input.origin) throw new TypeError("adapter origin is invalid"); }
  exact(input.filters, ["country", "language", "timeRange", "includeDomains", "excludeDomains"], "adapter filters");
  if (Object.values(input.filters).some((value) => typeof value !== "boolean")) throw new TypeError("adapter filters are invalid");
  const direct = input.capability === "fetch" && input.resultType === "direct-content";
  if (input.directWebEvidence !== direct) throw new TypeError("direct evidence is reserved for Restricted Fetch");
  if ((input.capability === "fetch") !== (input.credentialRef === null)) throw new TypeError("adapter credential declaration is invalid");
  exact(input.policySnapshot, ["pricing", "terms", "privacy", "retention", "verifiedAt"], "policy snapshot");
  if (Object.values(input.policySnapshot).some((value) => value !== null)) throw new TypeError("unverified policy snapshot values must remain null");
  return Object.freeze({ ...input, filters: Object.freeze({ ...input.filters }), policySnapshot: Object.freeze({ ...input.policySnapshot }) });
}

const unknownPolicy = Object.freeze({ pricing: null, terms: null, privacy: null, retention: null, verifiedAt: null });
const filters = (values) => Object.freeze({ country: false, language: false, timeRange: false, includeDomains: false, excludeDomains: false, ...values });

export const RESEARCH_ADAPTER_MANIFESTS = Object.freeze([
  { adapterId: "brave-search", adapterVersion: "brave-web-search-v1", capability: "search", origin: "https://api.search.brave.com",
    resultType: "search-snippet", filters: filters({ country: true, language: true }), credentialRef: "external-file:brave-search/m5r" },
  { adapterId: "serper-search", adapterVersion: "serper-search-fixture-v1", capability: "search", origin: "https://google.serper.dev",
    resultType: "search-snippet", filters: filters({ country: true, language: true, timeRange: true }), credentialRef: "external-file:serper-search/m5r" },
  { adapterId: "tavily-search", adapterVersion: "tavily-search-fixture-v1", capability: "search", origin: "https://api.tavily.com",
    resultType: "search-snippet", filters: filters({ timeRange: true, includeDomains: true, excludeDomains: true }), credentialRef: "external-file:tavily-search/m5r" },
  { adapterId: "tavily-extract", adapterVersion: "tavily-extract-fixture-v1", capability: "extract", origin: "https://api.tavily.com",
    resultType: "provider-content", filters: filters({}), credentialRef: "external-file:tavily-extract/m5r" },
  { adapterId: "restricted-fetch", adapterVersion: "restricted-fetch-v1", capability: "fetch", origin: null,
    resultType: "direct-content", filters: filters({ includeDomains: true, excludeDomains: true }), credentialRef: null },
].map((item) => adapterManifestContract({ schemaVersion: "research-adapter-manifest-v1", directWebEvidence: item.capability === "fetch",
  policySnapshot: unknownPolicy, ...item })));

export function adapterManifest(adapterId, capability) {
  const manifest = RESEARCH_ADAPTER_MANIFESTS.find((item) => item.adapterId === adapterId && item.capability === capability);
  if (!manifest) throw new TypeError("adapter capability is not declared");
  return manifest;
}
