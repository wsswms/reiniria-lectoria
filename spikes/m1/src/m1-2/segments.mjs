import { createHash } from "node:crypto";

function normalize(text) {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function grams(text) {
  const value = normalize(text);
  if (value.length < 2) return new Set([value]);
  const result = new Set();
  for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2));
  return result;
}

function similarity(left, right) {
  const a = grams(left);
  const b = grams(right);
  let overlap = 0;
  for (const value of a) if (b.has(value)) overlap += 1;
  return (2 * overlap) / Math.max(1, a.size + b.size);
}

function idFor(text, index) {
  return `seg-${createHash("sha256").update(`${normalize(text)}\0${index}`).digest("hex").slice(0, 16)}`;
}

export function seedSegments(texts) {
  return texts.map((text, index) => ({ id: idFor(text, index), text }));
}

function uniqueIndex(segments) {
  const counts = new Map();
  for (const segment of segments) {
    const key = normalize(segment.text);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function splitOrMergeAmbiguity(oldSegments, newSegments, newIndex, usedOld) {
  const target = normalize(newSegments[newIndex].text);
  for (let left = 0; left < oldSegments.length; left += 1) {
    if (usedOld.has(left)) continue;
    for (let right = left + 1; right < oldSegments.length; right += 1) {
      if (usedOld.has(right)) continue;
      const merged = normalize(`${oldSegments[left].text} ${oldSegments[right].text}`);
      if (merged === target) return true;
    }
  }
  return oldSegments.some((old, oldIndex) => {
    if (usedOld.has(oldIndex)) return false;
    const source = normalize(old.text);
    return source.length > target.length && source.includes(target);
  });
}

export function alignSegments(oldSegments, newTexts) {
  const newSegments = newTexts.map((text) => ({ text, id: undefined, status: "new" }));
  const oldCounts = uniqueIndex(oldSegments);
  const newCounts = uniqueIndex(newSegments);
  const usedOld = new Set();

  newSegments.forEach((segment) => {
    const key = normalize(segment.text);
    if (oldCounts.get(key) !== 1 || newCounts.get(key) !== 1) return;
    const oldIndex = oldSegments.findIndex((old) => normalize(old.text) === key);
    segment.id = oldSegments[oldIndex].id;
    segment.status = "exact";
    usedOld.add(oldIndex);
  });

  newSegments.forEach((segment, newIndex) => {
    if (segment.id) return;
    if (splitOrMergeAmbiguity(oldSegments, newSegments, newIndex, usedOld)) {
      segment.status = "ambiguous";
      return;
    }
    const candidates = oldSegments
      .map((old, oldIndex) => ({ old, oldIndex, score: usedOld.has(oldIndex) ? -1 : similarity(old.text, segment.text) }))
      .filter((candidate) => candidate.score >= 0.72)
      .sort((left, right) => right.score - left.score);
    if (candidates.length === 0) return;
    if (candidates.length > 1 && candidates[0].score - candidates[1].score < 0.08) {
      segment.status = "ambiguous";
      return;
    }
    segment.id = candidates[0].old.id;
    segment.status = "fuzzy";
    segment.score = candidates[0].score;
    usedOld.add(candidates[0].oldIndex);
  });

  return newSegments;
}
