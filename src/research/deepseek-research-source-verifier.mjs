import { finalResearchResultContract, providerResearchResultContract } from "./deepseek-server-research-contracts.mjs";
import { isIP } from "node:net";

const PERMISSIONS = Object.freeze({ mayModifyTranslation: false, mayApproveKnowledge: false });

export class DeepSeekResearchVerificationError extends Error {
  constructor(category) {
    super("DeepSeek research verification failed");
    this.name = "DeepSeekResearchVerificationError";
    this.category = category;
    this.retryable = false;
  }
}

function assertNotCanceled(signal) {
  if (signal?.aborted) throw new DeepSeekResearchVerificationError("canceled");
}

function compact(value) {
  return String(value).normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") && url.href.length <= 4_096 ? url.toString() : null;
  } catch { return null; }
}

export function quoteCoverage(quote, pageText) {
  const normalizedQuote = compact(quote);
  const normalizedPage = compact(pageText);
  const quoteExact = normalizedQuote.length >= 4 && normalizedPage.includes(normalizedQuote);
  const phrases = String(quote).split(/[|：:,，。；;\n]+/).map(compact).filter((part) => part.length >= 4);
  const matched = phrases.filter((part) => normalizedPage.includes(part)).length;
  const phraseCoverage = phrases.length ? Number((matched / phrases.length).toFixed(4)) : 0;
  return Object.freeze({ quoteExact, phraseCoverage });
}

function terminal(provider, outcome = provider.outcome) {
  return finalResearchResultContract({ ...provider, schemaVersion: "deepseek-server-research-result-v1", outcome,
    answer: outcome === "resolved" ? provider.answer : "", sources: [], permissions: PERMISSIONS });
}

export class ConfiguredResearchSourcePolicy {
  constructor({ rules } = {}) {
    if (!Array.isArray(rules) || rules.length < 1 || rules.length > 256) throw new TypeError("source policy rules are required");
    const seen = new Set();
    this.rules = Object.freeze(rules.map((rule) => {
      if (!rule || typeof rule !== "object" || Array.isArray(rule) || Object.keys(rule).sort().join(",") !== "hostname,includeSubdomains,tier"
        || typeof rule.hostname !== "string" || typeof rule.includeSubdomains !== "boolean" || !new Set(["S1", "S2", "S3"]).has(rule.tier)) {
        throw new TypeError("source policy rule is invalid");
      }
      let hostname;
      try { hostname = new URL(`https://${rule.hostname}`).hostname.toLocaleLowerCase(); } catch { throw new TypeError("source policy hostname is invalid"); }
      if (hostname !== rule.hostname.toLocaleLowerCase() || hostname.endsWith(".") || hostname === "localhost" || isIP(hostname)) throw new TypeError("source policy hostname is invalid");
      const identity = `${hostname}\0${rule.includeSubdomains}`;
      if (seen.has(identity)) throw new TypeError("source policy rule is duplicated");
      seen.add(identity);
      return Object.freeze({ hostname, includeSubdomains: rule.includeSubdomains, tier: rule.tier });
    }).sort((a, b) => b.hostname.length - a.hostname.length));
  }

  assess({ url } = {}) {
    let hostname;
    try { hostname = new URL(url).hostname.toLocaleLowerCase(); } catch { return Object.freeze({ eligible: false, tier: null, reason: "invalid-url" }); }
    const rule = this.rules.find((item) => hostname === item.hostname || item.includeSubdomains && hostname.endsWith(`.${item.hostname}`));
    return rule ? Object.freeze({ eligible: true, tier: rule.tier, reason: "configured-host" })
      : Object.freeze({ eligible: false, tier: null, reason: "unconfigured-host" });
  }
}

export class DeepSeekResearchSourceVerifier {
  constructor({ restrictedFetch, sourcePolicy, minimumPhraseCoverage = 0.8 } = {}) {
    if (!restrictedFetch || typeof restrictedFetch.fetchSelected !== "function" || !sourcePolicy || typeof sourcePolicy.assess !== "function") {
      throw new TypeError("source verifier dependencies are required");
    }
    if (typeof minimumPhraseCoverage !== "number" || minimumPhraseCoverage < 0.5 || minimumPhraseCoverage > 1) throw new TypeError("phrase coverage threshold is invalid");
    this.restrictedFetch = restrictedFetch;
    this.sourcePolicy = sourcePolicy;
    this.minimumPhraseCoverage = minimumPhraseCoverage;
  }

  async verify(input, { signal, onVerifiedSource } = {}) {
    const provider = providerResearchResultContract(input);
    if (onVerifiedSource !== undefined && typeof onVerifiedSource !== "function") throw new TypeError("verified source collector is invalid");
    if (provider.outcome !== "resolved-candidate") return terminal(provider);
    assertNotCanceled(signal);
    const sources = [];
    const droppedSources = [...provider.droppedSources];
    for (const source of provider.sources) {
      assertNotCanceled(signal);
      let assessment;
      try { assessment = await this.sourcePolicy.assess({ url: source.url, title: source.title, declaredClass: source.sourceClass }); }
      catch { assessment = null; }
      if (!assessment || assessment.eligible !== true || !new Set(["S1", "S2", "S3"]).has(assessment.tier)) {
        droppedSources.push({ url: source.url, reason: typeof assessment?.reason === "string" && /^[a-z0-9-]{1,64}$/.test(assessment.reason)
          ? `policy-${assessment.reason}` : "policy-rejected" });
        continue;
      }
      let snapshot;
      try { snapshot = await this.restrictedFetch.fetchSelected({ url: source.url, signal }); }
      catch (error) {
        assertNotCanceled(signal);
        const category = typeof error?.category === "string" && /^[a-z-]{1,64}$/.test(error.category) ? error.category : "failed";
        droppedSources.push({ url: source.url, reason: `fetch-${category}` });
        continue;
      }
      let requestedUrl = null;
      let finalUrl = null;
      requestedUrl = safeHttpsUrl(snapshot?.requestedUrl);
      finalUrl = safeHttpsUrl(snapshot?.finalUrl);
      if (!snapshot || snapshot.untrusted !== true || requestedUrl !== safeHttpsUrl(source.url)
        || !finalUrl || typeof snapshot.extractedText !== "string"
        || typeof snapshot.contentDigest !== "string" || typeof snapshot.snapshotDigest !== "string") {
        droppedSources.push({ url: source.url, reason: "fetch-malformed-response" });
        continue;
      }
      let finalAssessment;
      try { finalAssessment = await this.sourcePolicy.assess({ url: finalUrl, title: source.title,
        declaredClass: source.sourceClass, redirectedFrom: source.url }); } catch { finalAssessment = null; }
      if (!finalAssessment || finalAssessment.eligible !== true || !new Set(["S1", "S2", "S3"]).has(finalAssessment.tier)) {
        droppedSources.push({ url: source.url, reason: "policy-final-url-rejected" });
        continue;
      }
      const match = quoteCoverage(source.quote, snapshot.extractedText);
      if (!match.quoteExact && match.phraseCoverage < this.minimumPhraseCoverage) {
        droppedSources.push({ url: source.url, reason: "quote-mismatch" });
        continue;
      }
      if (onVerifiedSource) await onVerifiedSource(Object.freeze({ source, snapshot,
        assessment: Object.freeze({ tier: finalAssessment.tier, reason: finalAssessment.reason }), match }));
      sources.push({ ...source, finalUrl, tier: finalAssessment.tier,
        contentDigest: snapshot.contentDigest, snapshotDigest: snapshot.snapshotDigest,
        quoteExact: match.quoteExact, phraseCoverage: match.phraseCoverage });
    }
    if (sources.length === 0) return terminal({ ...provider, droppedSources }, "unresolved");
    return finalResearchResultContract({ ...provider, schemaVersion: "deepseek-server-research-result-v1", outcome: "resolved",
      sources, droppedSources, permissions: PERMISSIONS });
  }
}
