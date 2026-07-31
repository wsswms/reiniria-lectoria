import { createHash } from "node:crypto";

const protectedPatterns = [
  /```[\s\S]*?```/g,
  /~~~[\s\S]*?~~~/g,
  /`[^`\n]+`/g,
  /\{\{[%<][\s\S]*?[>%]\}\}/g,
  /(?<=!\[[^\]]*\]\()[^)]+(?=\))/g,
  /(?<=\[[^\]]+\]\()[^)]+(?=\))/g,
];

function token(index, value) {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `⟦P${index}:${digest}⟧`;
}

export function tokenizeProtected(source) {
  const matches = [];
  for (const pattern of protectedPatterns) {
    for (const match of source.matchAll(pattern)) {
      matches.push({ start: match.index, end: match.index + match[0].length, value: match[0] });
    }
  }
  matches.sort((left, right) => left.start - right.start || right.end - left.end);
  const selected = [];
  let lastEnd = -1;
  for (const match of matches) {
    if (match.start < lastEnd) continue;
    selected.push(match);
    lastEnd = match.end;
  }

  let cursor = 0;
  let text = "";
  const protectedItems = [];
  selected.forEach((match, index) => {
    const marker = token(index, match.value);
    text += source.slice(cursor, match.start) + marker;
    protectedItems.push({ marker, value: match.value });
    cursor = match.end;
  });
  text += source.slice(cursor);
  return { text, protectedItems };
}

export function restoreProtected(text, protectedItems) {
  const seenMarkers = [...text.matchAll(/⟦P\d+:[0-9a-f]{12}⟧/g)].map((match) => match[0]);
  const expected = protectedItems.map((item) => item.marker);
  if (seenMarkers.length !== expected.length) throw new Error("protected token count mismatch");
  for (const marker of seenMarkers) {
    if (!expected.includes(marker)) throw new Error("unknown or forged protected token");
  }
  for (const marker of expected) {
    if (seenMarkers.filter((value) => value === marker).length !== 1) {
      throw new Error("missing or duplicated protected token");
    }
  }
  let restored = text;
  for (const item of protectedItems) restored = restored.replace(item.marker, item.value);
  return restored;
}
