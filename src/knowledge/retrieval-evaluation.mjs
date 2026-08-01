export function evaluateRetrieval(retriever, queries) {
  const results = queries.map((query) => {
    const hits = retriever.search({
      query: query.query, language: query.language, kinds: query.kinds,
      tags: query.tags, documentIds: query.documentIds, topK: query.topK,
    });
    const ids = hits.map((hit) => hit.factId);
    const relevant = query.relevant.filter((factId) => ids.slice(0, 5).includes(factId));
    const firstRank = ids.findIndex((factId) => query.relevant.includes(factId)) + 1;
    const dcg = ids.slice(0, 10).reduce((sum, factId, index) => sum + (query.relevant.includes(factId) ? 1 / Math.log2(index + 2) : 0), 0);
    const ideal = query.relevant.slice(0, 10).reduce((sum, _, index) => sum + 1 / Math.log2(index + 2), 0);
    return Object.freeze({
      id: query.id, language: query.language, category: query.category, hits: Object.freeze(ids),
      recallAt5: query.relevant.length === 0 ? (ids.length === 0 ? 1 : 0) : relevant.length / query.relevant.length,
      reciprocalRank: firstRank > 0 ? 1 / firstRank : query.relevant.length === 0 && ids.length === 0 ? 1 : 0,
      ndcgAt10: ideal === 0 ? (ids.length === 0 ? 1 : 0) : dcg / ideal,
      hardNegativesAt5: query.forbidden.filter((factId) => ids.slice(0, 5).includes(factId)).length,
    });
  });
  const relevantResults = results.filter((result) => result.category !== "no-result");
  const average = (items, field) => items.reduce((sum, item) => sum + item[field], 0) / items.length;
  const hardNegativeDenominator = relevantResults.length * 5;
  return Object.freeze({
    results: Object.freeze(results),
    macroRecallAt5: average(relevantResults, "recallAt5"),
    mrrAt10: average(relevantResults, "reciprocalRank"),
    ndcgAt10: average(relevantResults, "ndcgAt10"),
    byLanguageRecallAt5: Object.freeze(Object.fromEntries([...new Set(relevantResults.map((item) => item.language))].sort()
      .map((language) => [language, average(relevantResults.filter((item) => item.language === language), "recallAt5")]))),
    exactRecallAt1: average(relevantResults.filter((item) => ["exact", "proper"].includes(item.category)), "reciprocalRank"),
    shortRecallAt5: average(relevantResults.filter((item) => item.category === "short"), "recallAt5"),
    hardNegativeTop5Rate: hardNegativeDenominator === 0 ? 0 : results.reduce((sum, item) => sum + item.hardNegativesAt5, 0) / hardNegativeDenominator,
    noResultFailures: results.filter((item) => item.category === "no-result" && item.hits.length > 0).length,
  });
}
