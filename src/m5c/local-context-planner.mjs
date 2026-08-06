const MEASUREMENT = /(?:\b\d{1,4}(?:[.,]\d+)?\s*(?:mm|cm|km|kg|mg|°c|°f|%|hz|mah|v|w|mp|fps|inch(?:es)?|ft)\b|\d+(?:[.,]\d+)?\s*(?:枚|個|个|片|组|組|台|本|倍|年|月|日))/giu;
const KATAKANA = /[ァ-ヺー]{3,}/gu;
const LATIN_TERM = /\b(?:[A-Z][A-Za-z0-9-]{2,}|[A-Z]{2,}[A-Z0-9-]*)\b/g;
const RELATION = /(?:not|never|without|because|therefore|causes?|prevents?|不是|没有|并非|由于|因此|导致|防止|ない|なく|ため|ので|従って|原因)/iu;

function uniqueMatches(text, patterns) {
  const values = []; for (const pattern of patterns) for (const match of text.matchAll(pattern)) values.push(match[0].trim());
  return [...new Set(values)].slice(0, 24);
}

export class LocalContextPlanner {
  constructor(database, trustedWorkspaceId, { retriever = null } = {}) {
    this.database = database; this.workspaceId = trustedWorkspaceId; this.retriever = retriever;
  }

  build({ workflowId, sourceRevisionId, targetLanguage }) {
    const segments = this.database.prepare(`SELECT segment_id AS segmentId, source_text AS sourceText, source_digest AS sourceDigest
      FROM source_segment_versions WHERE workspace_id = ? AND source_revision_id = ? AND translatable = 1 ORDER BY ordinal`)
      .all(this.workspaceId, sourceRevisionId);
    if (!segments.length) throw new Error("confirmed source has no translatable segments");
    const items = [];
    for (const segment of segments) {
      for (const value of uniqueMatches(segment.sourceText, [MEASUREMENT])) items.push(this.#item("measurement", value, segment, targetLanguage));
      for (const value of uniqueMatches(segment.sourceText, [KATAKANA, LATIN_TERM])) items.push(this.#item("term", value, segment, targetLanguage));
      if (RELATION.test(segment.sourceText)) items.push({ kind: "relation", coverage: "uncovered", instructionType: "warning-only", impact: "high",
        segmentIds: [segment.segmentId], dependencies: { sourceSegments: [{ segmentId: segment.segmentId, digest: segment.sourceDigest }], knowledge: [] },
        content: { sourceText: segment.sourceText, reason: "local semantic-risk marker" } });
    }
    const deduped = new Map();
    for (const item of items) {
      const key = `${item.kind}\0${item.content.value ?? item.content.sourceText}\0${item.segmentIds[0]}`;
      if (!deduped.has(key)) deduped.set(key, item);
    }
    return Object.freeze({ items: Object.freeze([...deduped.values()].slice(0, 256)), researchScope: Object.freeze({ suggestedItemIndexes: Object.freeze([...deduped.values()].map((item, index) => item.impact === "high" && item.coverage !== "covered" ? index : -1).filter((index) => index >= 0)), approvedItemIds: Object.freeze([]) }),
      qaProfile: Object.freeze({ invariant: true, heuristic: true, model: true, finalRevisionRequired: true }), workflowId });
  }

  #item(kind, value, segment, targetLanguage) {
    if (kind === "measurement") return { kind, coverage: "covered", instructionType: "hard-constraint", impact: "critical", segmentIds: [segment.segmentId],
      dependencies: { sourceSegments: [{ segmentId: segment.segmentId, digest: segment.sourceDigest }], knowledge: [] }, content: { value, rule: "preserve value and measurement category" } };
    let hits = [];
    if (this.retriever) {
      try { hits = this.retriever.search({ query: value, language: targetLanguage, kinds: ["term", "knowledge"], tags: [], documentIds: [], topK: 5 }); } catch { hits = []; }
    }
    const coverage = hits.length === 0 ? "uncovered" : "covered";
    return { kind, coverage, instructionType: coverage === "covered" ? "preferred" : "warning-only", impact: "high", segmentIds: [segment.segmentId],
      dependencies: { sourceSegments: [{ segmentId: segment.segmentId, digest: segment.sourceDigest }], knowledge: hits.map((hit) => ({ factId: hit.factId, revisionId: hit.revisionId, digest: hit.contentDigest })) },
      content: { value, hits: hits.map((hit) => ({ factId: hit.factId, revisionId: hit.revisionId, snippet: hit.snippet })) } };
  }
}
