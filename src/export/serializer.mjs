import rehypeParse from "rehype-parse";
import rehypeStringify from "rehype-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { stableJson } from "../domain/contracts.mjs";
import { normalizeDocument, validateProtectedText } from "../document/parser.mjs";

export class SerializationError extends Error {
  constructor(message = "document serialization failed") {
    super(message);
    this.name = "SerializationError";
    this.code = "SERIALIZATION_ERROR";
  }
}

const MARKER_PATTERN = /⟦LCT-P-\d{4}-[0-9a-f]{16}⟧/g;
const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ["yaml", "toml"])
  .use(remarkStringify, { bullet: "-", fence: "`", fences: true, listItemIndent: "one" });
const htmlProcessor = unified().use(rehypeParse, { fragment: true }).use(rehypeStringify, { allowDangerousHtml: false });

function locate(tree, structuralPath) {
  if (structuralPath === "/") return tree;
  const indexes = structuralPath.split("/").filter(Boolean).map((value) => Number.parseInt(value, 10));
  let node = tree;
  for (const index of indexes) {
    if (!Number.isSafeInteger(index) || !node?.children?.[index]) throw new SerializationError("source structural path is invalid");
    node = node.children[index];
  }
  return node;
}

function consumeProtected(items, state, kind, value) {
  const item = items[state.index];
  if (!item || item.kind !== kind || item.value !== value) throw new SerializationError("source protection skeleton changed");
  state.index += 1;
  return { type: "protected", item };
}

function mutable(value, assign) {
  return { type: "mutable", original: value, assign };
}

function markdownTextUnits(node, items, state, units, finalizers) {
  if (!node) return;
  if (node.type === "text") {
    const pieces = [];
    let cursor = 0;
    while (cursor < node.value.length) {
      const start = node.value.indexOf("{{", cursor);
      if (start < 0 || !["<", "%"].includes(node.value[start + 2])) {
        const end = start < 0 ? node.value.length : start + 2;
        const piece = { value: node.value.slice(cursor, end) };
        pieces.push(piece);
        units.push(mutable(piece.value, (value) => { piece.value = value; }));
        cursor = end;
        continue;
      }
      const closing = node.value[start + 2] === "<" ? ">}}" : "%}}";
      const end = node.value.indexOf(closing, start + 3);
      if (end < 0) {
        const piece = { value: node.value.slice(cursor) };
        pieces.push(piece);
        units.push(mutable(piece.value, (value) => { piece.value = value; }));
        cursor = node.value.length;
        continue;
      }
      if (start > cursor) {
        const piece = { value: node.value.slice(cursor, start) };
        pieces.push(piece);
        units.push(mutable(piece.value, (value) => { piece.value = value; }));
      }
      const shortcode = node.value.slice(start, end + closing.length);
      pieces.push({ value: shortcode });
      units.push(consumeProtected(items, state, "shortcode", shortcode));
      cursor = end + closing.length;
    }
    if (node.value.length === 0) {
      const piece = { value: "" };
      pieces.push(piece);
      units.push(mutable("", (value) => { piece.value = value; }));
    }
    finalizers.push(() => { node.value = pieces.map((piece) => piece.value).join(""); });
    return;
  }
  if (["inlineCode", "code", "yaml", "toml", "html"].includes(node.type)) {
    units.push(consumeProtected(items, state, node.type, node.value ?? ""));
    return;
  }
  if (node.type === "break") {
    units.push({ type: "fixed", value: "\n" });
    return;
  }
  if (node.type === "image") {
    units.push(mutable(node.alt ?? "", (value) => { node.alt = value; }));
    units.push(consumeProtected(items, state, "image-url", node.url ?? ""));
    return;
  }
  if (node.type === "link") {
    for (const child of node.children ?? []) markdownTextUnits(child, items, state, units, finalizers);
    units.push(consumeProtected(items, state, "link-url", node.url ?? ""));
    return;
  }
  if (["footnoteReference", "definition", "linkReference", "imageReference"].includes(node.type)) {
    units.push(consumeProtected(items, state, node.type, node.identifier ?? node.label ?? ""));
    return;
  }
  for (const child of node.children ?? []) markdownTextUnits(child, items, state, units, finalizers);
}

function htmlTextUnits(node, items, state, units) {
  if (!node) return;
  if (node.type === "text") {
    units.push(mutable(node.value, (value) => { node.value = value; }));
    return;
  }
  if (node.type === "comment") {
    units.push(consumeProtected(items, state, "html-comment", node.value ?? ""));
    return;
  }
  if (node.type !== "element") {
    for (const child of node.children ?? []) htmlTextUnits(child, items, state, units);
    return;
  }
  if (["code", "pre"].includes(node.tagName)) {
    units.push(consumeProtected(items, state, `html-${node.tagName}`, htmlProcessor.stringify(node)));
    return;
  }
  for (const child of node.children ?? []) htmlTextUnits(child, items, state, units);
  for (const property of ["href", "src", "poster"]) {
    if (node.properties?.[property] !== undefined) {
      units.push(consumeProtected(items, state, `html-${property}`, String(node.properties[property])));
    }
  }
}

function assignMutable(slots, value) {
  if (slots.length === 0) {
    if (value.length > 0) throw new SerializationError("target text cannot fit the source structure");
    return;
  }
  const active = slots.filter((slot) => Array.from(slot.original).length > 0);
  if (active.length === 0) {
    slots[0].assign(value);
    for (const slot of slots.slice(1)) slot.assign("");
    return;
  }
  const characters = Array.from(value);
  if (characters.length < active.length) throw new SerializationError("target text would remove required inline structure");
  let cursor = 0;
  let remainingWeight = active.reduce((total, slot) => total + Array.from(slot.original).length, 0);
  active.forEach((slot, index) => {
    const remainingSlots = active.length - index - 1;
    const weight = Array.from(slot.original).length;
    const available = characters.length - cursor;
    const count = index === active.length - 1
      ? available
      : Math.max(1, Math.min(available - remainingSlots, Math.round((available * weight) / remainingWeight)));
    slot.assign(characters.slice(cursor, cursor + count).join(""));
    cursor += count;
    remainingWeight -= weight;
  });
  for (const slot of slots.filter((candidate) => !active.includes(candidate))) slot.assign("");
}

function assignGroup(units, target) {
  let start = 0;
  let slots = [];
  for (const unit of units) {
    if (unit.type === "mutable") {
      slots.push(unit);
      continue;
    }
    if (unit.type !== "fixed") throw new SerializationError("invalid serialization skeleton");
    const index = target.indexOf(unit.value, start);
    if (index < 0) throw new SerializationError("target text changed a required structural break");
    assignMutable(slots, target.slice(start, index));
    slots = [];
    start = index + unit.value.length;
  }
  assignMutable(slots, target.slice(start));
}

function applyTarget(units, target, protectedItems) {
  try { validateProtectedText(target, protectedItems); }
  catch { throw new SerializationError("protected values do not match the source segment"); }
  const targetMarkers = [...target.matchAll(MARKER_PATTERN)].map((match) => match[0]);
  const expectedMarkers = protectedItems.map((item) => item.marker);
  if (stableJson(targetMarkers) !== stableJson(expectedMarkers)) throw new SerializationError("protected values changed order");

  const groups = [[]];
  let markerIndex = 0;
  for (const unit of units) {
    if (unit.type !== "protected") {
      groups.at(-1).push(unit);
      continue;
    }
    if (unit.item.marker !== expectedMarkers[markerIndex]) throw new SerializationError("source protection order changed");
    markerIndex += 1;
    groups.push([]);
  }
  if (markerIndex !== expectedMarkers.length) throw new SerializationError("source protection skeleton is incomplete");

  const chunks = [];
  let cursor = 0;
  for (const marker of expectedMarkers) {
    const index = target.indexOf(marker, cursor);
    chunks.push(target.slice(cursor, index));
    cursor = index + marker.length;
  }
  chunks.push(target.slice(cursor));
  groups.forEach((group, index) => assignGroup(group, chunks[index]));
}

function rewriteAst(format, normalizedSource, segments) {
  const processor = format === "markdown" ? markdownProcessor : htmlProcessor;
  const tree = processor.parse(normalizedSource);
  for (const segment of segments) {
    if (segment.text === segment.sourceText) continue;
    const node = locate(tree, segment.structuralPath);
    const actualKind = format === "markdown" ? node.type : node.tagName ?? "root";
    if (actualKind !== segment.kind) throw new SerializationError("source segment kind changed");
    const units = [];
    const state = { index: 0 };
    const finalizers = [];
    if (format === "markdown") markdownTextUnits(node, segment.protected, state, units, finalizers);
    else htmlTextUnits(node, segment.protected, state, units);
    if (state.index !== segment.protected.length) throw new SerializationError("source protection skeleton is incomplete");
    applyTarget(units, segment.text, segment.protected);
    finalizers.forEach((finalize) => finalize());
  }
  const output = processor.stringify(tree);
  return format === "markdown" ? output.replaceAll("\\<", "&lt;") : output;
}

function structureShape(value) {
  if (Array.isArray(value)) return value.map(structureShape).filter((item) => item !== null);
  if (!value || typeof value !== "object") return value;
  if (value.type === "text") return null;
  const output = {};
  for (const key of ["type", "depth", "ordered", "start", "spread", "checked", "url", "title", "lang", "meta", "tagName", "properties", "align"]) {
    if (value[key] !== undefined) output[key] = value[key];
  }
  if (value.children) output.children = value.children.map(structureShape).filter((item) => item !== null);
  return output;
}

function protectedSignature(segments) {
  return segments.flatMap((segment) => segment.protected.map((item) => `${item.kind}\u0000${item.value}`)).sort();
}

export function serializeOrdinaryDocument(format, normalizedSource, segments) {
  if (!new Set(["markdown", "html", "text"]).has(format)) throw new SerializationError("unsupported ordinary export format");
  if (segments.every((segment) => segment.text === segment.sourceText)) return Buffer.from(normalizedSource);
  if (format === "text") return Buffer.from(segments.map((segment) => segment.text).join("\n\n"));
  return Buffer.from(rewriteAst(format, normalizedSource, segments));
}

export function verifyOrdinaryDocument(format, bytes, sourceSegments, normalizedSource) {
  let parsed;
  let original;
  try {
    parsed = normalizeDocument(format, bytes);
    original = normalizeDocument(format, normalizedSource);
  } catch {
    throw new SerializationError("exported document cannot be parsed safely");
  }
  if (parsed.segments.length !== sourceSegments.length) throw new SerializationError("exported segment set changed");
  for (let index = 0; index < parsed.segments.length; index += 1) {
    const actual = parsed.segments[index];
    const expected = sourceSegments[index];
    if (actual.kind !== expected.kind || actual.structuralPath !== expected.structuralPath) throw new SerializationError("exported structure changed");
    if (actual.sourceText !== expected.text) throw new SerializationError("exported target text changed");
  }
  if (stableJson(structureShape(parsed.projection)) !== stableJson(structureShape(original.projection))) {
    throw new SerializationError("exported structural projection changed");
  }
  const expected = protectedSignature(sourceSegments);
  const actual = protectedSignature(parsed.segments);
  if (stableJson(actual) !== stableJson(expected)) throw new SerializationError("exported protected values changed");
  return parsed;
}
