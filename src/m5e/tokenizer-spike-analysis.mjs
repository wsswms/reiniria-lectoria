const HAN = /^\p{Script=Han}$/u;
const TEXT = /[\p{L}\p{N}]/u;

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function percentile(values, fraction) {
  if (values.length === 0) return 0; const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}
function occurrences(text, phrase) {
  const output = []; let offset = 0;
  while (offset <= text.length - phrase.length) { const index = text.indexOf(phrase, offset); if (index < 0) break; output.push(index); offset = index + 1; }
  return output;
}
function canCompose(tokens, start, end, text, maximumTokens = 4) {
  const relevant = tokens.filter((token) => token.start >= start && token.end <= end).sort((left, right) => left.start - right.start || right.end - left.end);
  const visit = (cursor, used) => {
    if (cursor === end) return true; if (used >= maximumTokens) return false;
    let next = cursor; while (next < end && /\s/u.test(text[next])) next += 1;
    if (next === end) return true;
    return relevant.some((token) => token.start === next && token.end > next && visit(token.end, used + 1));
  };
  return visit(start, 0);
}

export function referenceCoverage(document, result, phrases, maximumTokens = 4) {
  if (!object(document) || !Array.isArray(document.segments) || !object(result) || !Array.isArray(result.tokens) || !Array.isArray(phrases)) throw new TypeError("reference coverage input is invalid");
  const tokens = new Map(document.segments.map((segment) => [segment.segmentId, result.tokens.filter((token) => token.segmentId === segment.segmentId)]));
  return Object.freeze(phrases.map((phrase) => {
    let present = false, singleToken = false, composable = false;
    for (const segment of document.segments) {
      const text = segment[result.language]; for (const start of occurrences(text, phrase)) {
        present = true; const end = start + phrase.length; const segmentTokens = tokens.get(segment.segmentId);
        if (segmentTokens.some((token) => token.start === start && token.end === end && token.value === phrase)) singleToken = true;
        if (canCompose(segmentTokens, start, end, text, maximumTokens)) composable = true;
      }
    }
    return Object.freeze({ phrase, present, singleToken, composable: singleToken || composable });
  }));
}

function repeatedPhrases(document, result) {
  const segments = new Map(document.segments.map((segment) => [segment.segmentId, segment[result.language]])); const grouped = new Map();
  for (const [segmentId, text] of segments) {
    const tokens = result.tokens.filter((token) => token.segmentId === segmentId).sort((left, right) => left.start - right.start || left.end - right.end);
    for (let start = 0; start < tokens.length; start += 1) for (let size = 1; size <= 4 && start + size <= tokens.length; size += 1) {
      const window = tokens.slice(start, start + size); if (window.some((token, index) => index > 0
        && (token.start < window[index - 1].end || !/^\s*$/u.test(text.slice(window[index - 1].end, token.start))))) break;
      const phrase = text.slice(window[0].start, window.at(-1).end).normalize("NFKC").trim(); if (phrase.length < 2 || !TEXT.test(phrase)) continue;
      grouped.set(phrase, (grouped.get(phrase) ?? 0) + 1);
    }
  }
  return [...grouped.values()].filter((count) => count >= 2).length;
}

export function summarizeTokenizerResult(document, result, references) {
  if (result.documentId !== document.articleId || !["ja", "zh"].includes(result.language) || !Array.isArray(result.determinismDigests)
    || new Set(result.determinismDigests).size !== 1) throw new TypeError("tokenizer result is invalid or non-deterministic");
  const segmentMap = new Map(document.segments.map((segment) => [segment.segmentId, segment[result.language]]));
  for (const token of result.tokens) {
    const text = segmentMap.get(token.segmentId); if (typeof text !== "string" || text.slice(token.start, token.end) !== token.value) throw new TypeError("token offset mismatch");
  }
  const coverage = referenceCoverage(document, result, references); const present = coverage.filter((item) => item.present);
  const lengths = result.tokens.map((token) => [...token.value].length); const unique = new Set(result.tokens.map((token) => token.value.normalize("NFKC")));
  return Object.freeze({ documentId: document.articleId, language: result.language, engine: result.engine, tokenOccurrences: result.tokens.length,
    uniqueTokens: unique.size, averageTokenLength: lengths.length ? lengths.reduce((sum, value) => sum + value, 0) / lengths.length : 0,
    p50TokenLength: percentile(lengths, 0.5), p95TokenLength: percentile(lengths, 0.95), maximumTokenLength: Math.max(0, ...lengths),
    singleHanTokenRatio: lengths.length ? result.tokens.filter((token) => HAN.test(token.value)).length / lengths.length : 0,
    repeatedPhraseCandidates: repeatedPhrases(document, result), referencePresent: present.length,
    referenceSingleToken: present.filter((item) => item.singleToken).length, referenceComposable: present.filter((item) => item.composable).length,
    referenceMisses: Object.freeze(present.filter((item) => !item.composable).map((item) => item.phrase)), timing: result.timing,
    tokenDigest: result.tokenDigest });
}

export function analyzeTokenizerSpike(corpus, referenceSet, resultSets) {
  if (corpus?.schemaVersion !== "m5e-tokenizer-corpus-v1" || referenceSet?.schemaVersion !== "m5e-tokenizer-reference-v1"
    || !Array.isArray(resultSets) || resultSets.some((value) => value?.schemaVersion !== "m5e-tokenizer-results-v1")) throw new TypeError("tokenizer analysis input is invalid");
  const allResults = resultSets.flatMap((value) => value.results); const summaries = allResults.map((result) => {
    const document = corpus.documents.find((item) => item.articleId === result.documentId); return summarizeTokenizerResult(document, result, referenceSet[result.language]);
  });
  const engines = [...new Set(summaries.map((item) => item.engine))].sort().map((engine) => {
    const values = summaries.filter((item) => item.engine === engine); const present = values.reduce((sum, item) => sum + item.referencePresent, 0);
    return Object.freeze({ engine, language: values[0].language, documents: values.length,
      tokenOccurrences: values.reduce((sum, item) => sum + item.tokenOccurrences, 0), uniqueTokenSum: values.reduce((sum, item) => sum + item.uniqueTokens, 0),
      repeatedPhraseCandidateSum: values.reduce((sum, item) => sum + item.repeatedPhraseCandidates, 0), referencePresent: present,
      referenceSingleToken: values.reduce((sum, item) => sum + item.referenceSingleToken, 0),
      referenceComposable: values.reduce((sum, item) => sum + item.referenceComposable, 0),
      composableRecall: present === 0 ? 0 : values.reduce((sum, item) => sum + item.referenceComposable, 0) / present,
      misses: Object.freeze([...new Set(values.flatMap((item) => item.referenceMisses))].sort()),
      p50MsSum: values.reduce((sum, item) => sum + item.timing.p50Ms, 0), p95MsMaximum: Math.max(...values.map((item) => item.timing.p95Ms)) });
  });
  return Object.freeze({ schemaVersion: "m5e-tokenizer-analysis-v1", summaries: Object.freeze(summaries), engines: Object.freeze(engines),
    runtimes: Object.freeze(resultSets.map((value) => value.runtime)) });
}
