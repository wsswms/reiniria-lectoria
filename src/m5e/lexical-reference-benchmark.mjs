import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function subjects(value) {
  // The descriptions mix source text, Chinese explanations and proposed target
  // translations.  Han runs are therefore deliberately not mined: a Chinese
  // explanation can otherwise appear to be an exact Japanese source anchor by
  // accident. Only explicitly quoted subjects are recovered, and every value
  // must still occur in the family-declared source segment. This intentionally
  // leaves unquoted historical questions for human anchoring.
  const quoted = [
    ...value.matchAll(/「([^」]{2,96})」/gu),
    ...value.matchAll(/“([^”]{2,96})”/gu),
    ...value.matchAll(/"([^"\r\n]{2,96})"/gu),
    ...value.matchAll(/‘([^’]{2,96})’/gu),
    ...value.matchAll(/'([^'\r\n]{2,96})'/gu),
  ].map((match) => match[1]);
  return [...new Set(quoted)];
}
function sourceSurface(source, subject) {
  const exact = source.indexOf(subject); if (exact >= 0) return source.slice(exact, exact + subject.length);
  const folded = source.toLocaleLowerCase("und"), target = subject.toLocaleLowerCase("und"); const index = folded.indexOf(target);
  return index < 0 ? null : source.slice(index, index + subject.length);
}

export function buildLexicalReferenceBenchmark(proposal, documents) {
  if (!object(proposal) || proposal.status !== "pending-user-confirmation" || !Array.isArray(proposal.proposedFamilies)
    || !Array.isArray(documents)) throw new TypeError("lexical reference benchmark input is invalid");
  const segments = new Map();
  for (const document of documents.filter((item) => item.language === "ja")) for (const segment of document.segments ?? []) {
    if (segments.has(segment.segmentId)) throw new TypeError("reference segment identity is duplicated"); segments.set(segment.segmentId, segment.sourceText);
  }
  const lexical = proposal.proposedFamilies.filter((item) => ["term", "entity"].includes(item.kind)); const unanchored = [];
  const anchored = lexical.flatMap((family) => {
    const pairs = (family.segmentIds ?? []).flatMap((segmentId) => subjects(family.description ?? "")
      .map((subject) => sourceSurface(segments.get(segmentId) ?? "", subject)).filter(Boolean)
      .map((quote) => [`${segmentId}\0${quote}`, Object.freeze({ segmentId, quote })]));
    const anchors = [...new Map(pairs).values()];
    if (anchors.length === 0) { unanchored.push(family.familyId); return []; }
    return [Object.freeze({ familyId: family.familyId, kind: family.kind, impact: family.impact, anchors: Object.freeze(anchors) })];
  }).sort((left, right) => left.familyId.localeCompare(right.familyId));
  const surfaces = [...new Set(anchored.flatMap((item) => item.anchors.map((anchor) => anchor.quote)))].sort();
  const value = { status: "provisional", lexicalFamilies: lexical.length, anchoredFamilies: Object.freeze(anchored),
    unanchoredFamilyIds: Object.freeze(unanchored.sort()), exactSurfaces: Object.freeze(surfaces) };
  return Object.freeze({ ...value, benchmarkDigest: sha(value) });
}

export function scoreLexicalReferenceBenchmark(benchmark, candidates) {
  if (!object(benchmark) || benchmark.status !== "provisional" || !Array.isArray(benchmark.anchoredFamilies) || !Array.isArray(candidates)) {
    throw new TypeError("lexical reference score input is invalid");
  }
  const candidateAnchors = candidates.flatMap((candidate) => (candidate.quotes ?? []).flatMap((quote) => (quote.occurrences ?? [])
    .map((occurrence) => ({ segmentId: occurrence.segmentId, quote: quote.text }))));
  const captures = (anchor) => candidateAnchors.some((candidate) => candidate.segmentId === anchor.segmentId
    && candidate.quote.includes(anchor.quote));
  const covered = benchmark.anchoredFamilies.filter((family) => family.anchors.some(captures));
  const coveredSurfaces = benchmark.exactSurfaces.filter((surface) => benchmark.anchoredFamilies
    .some((family) => family.anchors.some((anchor) => anchor.quote === surface && captures(anchor))));
  const impacts = (impact) => benchmark.anchoredFamilies.filter((item) => item.impact === impact);
  const count = (impact) => covered.filter((item) => item.impact === impact).length;
  return Object.freeze({ benchmarkDigest: benchmark.benchmarkDigest, anchoredFamilies: benchmark.anchoredFamilies.length,
    coveredFamilies: covered.length, criticalFamilies: impacts("critical").length, criticalCovered: count("critical"),
    highFamilies: impacts("high").length, highCovered: count("high"), exactSurfaces: benchmark.exactSurfaces.length,
    capturedExactSurfaces: coveredSurfaces.length,
    missedExactSurfaces: Object.freeze(benchmark.exactSurfaces.filter((surface) => !coveredSurfaces.includes(surface))),
    missedFamilyIds: Object.freeze(benchmark.anchoredFamilies.filter((item) => !covered.includes(item)).map((item) => item.familyId)) });
}
