function normalized(value) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function grams(value) {
  const text = normalized(value);
  if (text.length < 2) return new Set([text]);
  return new Set(Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2)));
}

function similarity(left, right) {
  const a = grams(left);
  const b = grams(right);
  let overlap = 0;
  for (const value of a) if (b.has(value)) overlap += 1;
  return (2 * overlap) / Math.max(1, a.size + b.size);
}

function counts(segments) {
  const output = new Map();
  for (const segment of segments) {
    const key = normalized(segment.sourceText);
    output.set(key, (output.get(key) ?? 0) + 1);
  }
  return output;
}

function splitMergeMembers(previous, incoming) {
  const ambiguousNew = new Set();
  for (let oldIndex = 0; oldIndex < previous.length; oldIndex += 1) {
    const oldText = normalized(previous[oldIndex].sourceText);
    for (let left = 0; left < incoming.length; left += 1) {
      let combined = "";
      for (let right = left; right < incoming.length; right += 1) {
        combined = normalized(`${combined} ${incoming[right].sourceText}`);
        if (right > left && combined === oldText) for (let index = left; index <= right; index += 1) ambiguousNew.add(index);
      }
    }
  }
  for (let newIndex = 0; newIndex < incoming.length; newIndex += 1) {
    const newText = normalized(incoming[newIndex].sourceText);
    for (let left = 0; left < previous.length; left += 1) {
      let combined = "";
      for (let right = left; right < previous.length; right += 1) {
        combined = normalized(`${combined} ${previous[right].sourceText}`);
        if (right > left && combined === newText) ambiguousNew.add(newIndex);
      }
    }
  }
  return ambiguousNew;
}

export function alignRevisionSegments(previous, incoming, { fuzzyThreshold = 0.72, minimumGap = 0.08 } = {}) {
  const oldCounts = counts(previous);
  const newCounts = counts(incoming);
  const splitMerge = splitMergeMembers(previous, incoming);
  const competing = new Set();
  const usedOld = new Set();
  const results = incoming.map((segment, index) => ({ index, segment, status: undefined, oldSegmentId: undefined, score: undefined, evidence: {} }));

  for (const result of results) {
    const key = normalized(result.segment.sourceText);
    if (oldCounts.get(key) !== 1 || newCounts.get(key) !== 1) continue;
    const oldIndex = previous.findIndex((segment) => normalized(segment.sourceText) === key);
    const old = previous[oldIndex];
    result.status = old.structuralPath === result.segment.structuralPath ? "unchanged" : "moved";
    result.oldSegmentId = old.segmentId;
    result.score = 1;
    result.evidence = { method: "unique-normalized-exact", oldStructuralPath: old.structuralPath };
    usedOld.add(oldIndex);
  }

  for (const result of results) {
    if (result.status || splitMerge.has(result.index)) continue;
    const normalizedText = normalized(result.segment.sourceText);
    if ((oldCounts.get(normalizedText) ?? 0) > 1 || (newCounts.get(normalizedText) ?? 0) > 1) continue;
    const candidates = previous
      .map((old, oldIndex) => ({ old, oldIndex }))
      .filter(({ old, oldIndex }) => !usedOld.has(oldIndex) && old.kind === result.segment.kind && old.structuralPath === result.segment.structuralPath);
    if (candidates.length !== 1) continue;
    const candidate = candidates[0];
    const score = similarity(candidate.old.sourceText, result.segment.sourceText);
    if (score < fuzzyThreshold) continue;
    result.status = "changed";
    result.oldSegmentId = candidate.old.segmentId;
    result.score = score;
    result.evidence = { method: "unique-structural-anchor", oldStructuralPath: candidate.old.structuralPath };
    usedOld.add(candidate.oldIndex);
  }

  for (const result of results) {
    if (result.status || splitMerge.has(result.index)) continue;
    const candidates = previous
      .map((old, oldIndex) => ({ old, oldIndex, score: usedOld.has(oldIndex) ? -1 : similarity(old.sourceText, result.segment.sourceText) }))
      .filter((candidate) => candidate.score >= fuzzyThreshold)
      .sort((left, right) => right.score - left.score || left.oldIndex - right.oldIndex);
    if (candidates.length === 0) continue;
    if (candidates.length > 1 && candidates[0].score - candidates[1].score < minimumGap) {
      competing.add(result.index);
      continue;
    }
    const candidate = candidates[0];
    result.status = "changed";
    result.oldSegmentId = candidate.old.segmentId;
    result.score = candidate.score;
    result.evidence = { method: "unique-high-confidence", oldStructuralPath: candidate.old.structuralPath };
    usedOld.add(candidate.oldIndex);
  }

  for (const result of results) {
    if (result.status) continue;
    const key = normalized(result.segment.sourceText);
    const duplicated = (oldCounts.get(key) ?? 0) > 1 || (newCounts.get(key) ?? 0) > 1;
    if (splitMerge.has(result.index) || duplicated || competing.has(result.index)) {
      result.status = "ambiguous";
      result.evidence = { method: splitMerge.has(result.index) ? "split-or-merge" : duplicated ? "duplicate-text" : "competing-candidates" };
    } else {
      result.status = "inserted";
      result.evidence = { method: "no-unique-match" };
    }
  }

  const deleted = previous
    .filter((_, oldIndex) => !usedOld.has(oldIndex))
    .map((segment) => Object.freeze({ segmentId: segment.segmentId, status: "deleted", structuralPath: segment.structuralPath }));
  return Object.freeze({
    aligned: Object.freeze(results.map((result) => Object.freeze({ ...result, segment: undefined }))),
    deleted: Object.freeze(deleted),
    requiresConfirmation: results.some((result) => result.status === "ambiguous"),
  });
}
