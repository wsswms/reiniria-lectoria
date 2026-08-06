import { dictionaryLookupRequestContract, entityLookupRequestContract } from "./contracts.mjs";
import { createReferenceResult } from "./reference-result.mjs";

export const BRAVE_REFERENCE_PROVIDER_ID = "brave-web";
export const BRAVE_REFERENCE_PROVIDER_VERSION = "brave-reference-web-v1";

const contract = (kind, input) => kind === "dictionary"
  ? dictionaryLookupRequestContract(input) : entityLookupRequestContract(input);
const hostAllowed = (url, domains) => {
  try { const host = new URL(url).hostname.toLocaleLowerCase(); return domains.some((domain) => host === domain || host.endsWith(`.${domain}`)); }
  catch { return false; }
};

export function buildBraveReferenceQuery(kind, requestInput, allowedDomains) {
  const request = contract(kind, requestInput);
  const hints = kind === "dictionary" ? [request.partOfSpeech, ...request.requestedFields]
    : [request.entityType, ...request.requestedFacts, request.timeHint];
  return [`"${request.term.replaceAll('"', "")}"`, ...hints.filter(Boolean),
    `(${allowedDomains.map((domain) => `site:${domain}`).join(" OR ")})`].join(" ").slice(0, 2_048);
}

function excerpt(text, term) {
  const lower = text.toLocaleLowerCase(); const index = lower.indexOf(term.toLocaleLowerCase());
  if (index < 0) return null;
  const start = Math.max(0, index - 240); const end = Math.min(text.length, index + term.length + 360);
  return text.slice(start, end).trim();
}

export class BraveReferenceProvider {
  constructor({ search, restrictedFetch, normalizeEvidence, now = () => new Date(), maxPages = 3 } = {}) {
    if (typeof search !== "function" || !restrictedFetch || typeof restrictedFetch.fetchSelected !== "function"
      || normalizeEvidence !== undefined && typeof normalizeEvidence !== "function"
      || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 4) throw new TypeError("Brave reference provider dependencies are invalid");
    this.id = BRAVE_REFERENCE_PROVIDER_ID; this.search = search; this.restrictedFetch = restrictedFetch;
    this.normalizeEvidence = normalizeEvidence; this.now = now; this.maxPages = maxPages;
  }

  async lookup(kind, requestInput, binding, { signal } = {}) {
    const request = contract(kind, requestInput);
    if (binding.providerId !== this.id || binding.providerVersion !== BRAVE_REFERENCE_PROVIDER_VERSION) {
      throw new TypeError("Brave reference provider binding is invalid");
    }
    const found = await this.search({ query: buildBraveReferenceQuery(kind, request, binding.allowedDomains), count: 10,
      country: "US", searchLanguage: request.sourceLanguage, signal });
    const candidates = (found.results ?? []).filter((item) => hostAllowed(item.url, binding.allowedDomains)).slice(0, this.maxPages);
    const evidence = [];
    for (const item of candidates) {
      const page = await this.restrictedFetch.fetchSelected({ url: item.url, signal });
      if (!hostAllowed(page.finalUrl, binding.allowedDomains)) continue;
      const quote = excerpt(page.extractedText, request.term);
      if (quote) evidence.push({ url: page.finalUrl, title: page.title || item.title, quote,
        sourceClass: kind === "dictionary" ? "dictionary" : "official", retrievedAt: this.now().toISOString() });
    }
    const normalized = this.normalizeEvidence ? await this.normalizeEvidence({ kind, request, evidence, signal })
      : { status: evidence.length ? "unresolved" : "not-found", canonicalName: null, targetCandidates: [], details: { excerptsAvailable: evidence.length } };
    return createReferenceResult({ schemaVersion: "reference-lookup-result-v1", toolKind: kind, status: normalized.status,
      term: request.term, canonicalName: normalized.canonicalName ?? null, targetCandidates: normalized.targetCandidates ?? [],
      details: normalized.details ?? {}, sources: evidence, providerId: this.id, providerVersion: binding.providerVersion,
      usage: { searchCalls: found.usage?.searchCalls ?? 1, contentUrls: evidence.length, modelTokens: normalized.modelTokens ?? 0,
        costMicrosUsd: (found.usage?.costMicrosUsd ?? 0) + (normalized.costMicrosUsd ?? 0) },
      permissions: { mayModifyTranslation: false, mayApproveKnowledge: false } });
  }
}
