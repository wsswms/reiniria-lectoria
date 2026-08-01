import { createHash } from "node:crypto";
import rehypeParse from "rehype-parse";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { stableJson } from "../domain/contracts.mjs";

export const PARSER_VERSION = "lectoria-parser-v2";
export const SANITIZER_VERSION = "rehype-sanitize-6.0.0/lectoria-v1";

export const DEFAULT_IMPORT_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxNodes: 100_000,
  maxDepth: 128,
  maxSegments: 20_000,
  maxSegmentLength: 100_000,
});

const FORMATS = new Set(["markdown", "html", "text"]);
const RESERVED_TOKEN_PREFIX = "⟦LCT-P-";
const ACTIVE_TAGS = new Set(["script", "iframe", "object", "embed", "form", "style", "link", "meta"]);
const URL_PROPERTIES = new Set(["href", "src", "xLinkHref", "action", "formAction", "poster"]);
const MARKDOWN_SEGMENTS = new Set(["heading", "paragraph", "tableCell", "code", "yaml", "toml"]);
const HTML_SEGMENTS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "td", "th", "caption", "figcaption", "blockquote", "pre"]);

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ["yaml", "toml"])
  .use(remarkStringify, { bullet: "-", fence: "`", fences: true, listItemIndent: "one" });
const htmlParser = unified().use(rehypeParse, { fragment: true });
const htmlStringifier = unified().use(rehypeStringify, { allowDangerousHtml: false });
const htmlSanitizer = unified().use(rehypeSanitize, {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((name) => !ACTIVE_TAGS.has(name)),
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
    src: ["http", "https"],
  },
});

export class DocumentParseError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "DocumentParseError";
    this.code = code;
  }
}

const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function bytesAndText(input, limits) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length > limits.maxBytes) throw new DocumentParseError("IMPORT_SIZE_LIMIT", "input exceeds byte limit");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new DocumentParseError("INVALID_UTF8", "input is not valid UTF-8"); }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n?/g, "\n");
  if (text.includes(RESERVED_TOKEN_PREFIX)) throw new DocumentParseError("FORGED_PROTECTION_TOKEN", "input contains a reserved protection token");
  return { bytes, text };
}

function inspectTree(tree, limits) {
  let nodes = 0;
  let deepest = 0;
  function visit(node, depth) {
    nodes += 1;
    deepest = Math.max(deepest, depth);
    if (nodes > limits.maxNodes) throw new DocumentParseError("AST_NODE_LIMIT", "AST node limit exceeded");
    if (depth > limits.maxDepth) throw new DocumentParseError("AST_DEPTH_LIMIT", "AST depth limit exceeded");
    for (const child of node.children ?? []) visit(child, depth + 1);
  }
  visit(tree, 0);
  return { nodes, deepest };
}

function structuralProjection(node) {
  if (Array.isArray(node)) return node.map(structuralProjection);
  if (!node || typeof node !== "object") return node;
  const output = {};
  for (const key of ["type", "depth", "ordered", "start", "spread", "checked", "url", "title", "alt", "lang", "meta", "value", "tagName", "properties", "align"]) {
    if (node[key] !== undefined) output[key] = node[key];
  }
  if (node.children) output.children = node.children.map(structuralProjection);
  return output;
}

function dangerousUrl(value) {
  const normalized = String(value ?? "").replace(/[\u0000-\u0020]+/g, "").toLowerCase();
  return normalized.startsWith("javascript:") || normalized.startsWith("vbscript:") || normalized.startsWith("data:");
}

function htmlFindings(tree, prefix = []) {
  const findings = [];
  function visit(node, path) {
    if (node.type === "element") {
      if (ACTIVE_TAGS.has(node.tagName)) findings.push({ code: "HTML_ACTIVE_TAG_REMOVED", path, detail: node.tagName });
      for (const [name, value] of Object.entries(node.properties ?? {})) {
        if (name.toLowerCase().startsWith("on")) findings.push({ code: "HTML_EVENT_HANDLER_REMOVED", path, detail: name });
        if (URL_PROPERTIES.has(name) && dangerousUrl(value)) findings.push({ code: "HTML_EXECUTABLE_URL_REMOVED", path, detail: name });
      }
    }
    node.children?.forEach((child, index) => visit(child, [...path, index]));
  }
  visit(tree, prefix);
  return findings;
}

function sanitizeHtmlTree(tree) {
  const findings = htmlFindings(tree);
  return { tree: htmlSanitizer.runSync(tree), findings };
}

function sanitizeEmbeddedMarkdownHtml(tree) {
  const findings = [];
  function visit(node, path) {
    if (["link", "image"].includes(node.type) && dangerousUrl(node.url)) {
      findings.push({ code: "MARKDOWN_EXECUTABLE_URL_REMOVED", path, detail: node.type });
      node.url = "";
    }
    if (node.type === "html") {
      const parsed = htmlParser.parse(node.value);
      const result = sanitizeHtmlTree(parsed);
      findings.push(...result.findings.map((finding) => ({ ...finding, path: [...path, ...finding.path] })));
      node.value = htmlStringifier.stringify(result.tree);
    }
    node.children?.forEach((child, index) => visit(child, [...path, index]));
  }
  visit(tree, []);
  return findings;
}

function protect(items, kind, value) {
  const index = items.length;
  const valueDigest = digest(Buffer.from(value));
  const marker = `${RESERVED_TOKEN_PREFIX}${String(index).padStart(4, "0")}-${valueDigest.slice(7, 23)}⟧`;
  items.push(Object.freeze({ index, kind, marker, value, digest: valueDigest }));
  return marker;
}

function protectMarkdownText(value, items) {
  let output = "";
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf("{{", cursor);
    if (start < 0 || !["<", "%"].includes(value[start + 2])) {
      output += value.slice(cursor, start < 0 ? value.length : start + 2);
      cursor = start < 0 ? value.length : start + 2;
      continue;
    }
    const closing = value[start + 2] === "<" ? ">}}" : "%}}";
    const end = value.indexOf(closing, start + 3);
    if (end < 0) {
      output += value.slice(cursor);
      break;
    }
    output += value.slice(cursor, start);
    const shortcode = value.slice(start, end + closing.length);
    output += protect(items, "shortcode", shortcode);
    cursor = end + closing.length;
  }
  return output;
}

function markdownText(node, items) {
  if (!node) return "";
  if (node.type === "text") return protectMarkdownText(node.value, items);
  if (["inlineCode", "code", "yaml", "toml", "html"].includes(node.type)) return protect(items, node.type, node.value ?? "");
  if (node.type === "break") return "\n";
  if (node.type === "image") return `${node.alt ?? ""}${protect(items, "image-url", node.url ?? "")}`;
  if (node.type === "link") return `${(node.children ?? []).map((child) => markdownText(child, items)).join("")}${protect(items, "link-url", node.url ?? "")}`;
  if (["footnoteReference", "definition", "linkReference", "imageReference"].includes(node.type)) return protect(items, node.type, node.identifier ?? node.label ?? "");
  return (node.children ?? []).map((child) => markdownText(child, items)).join("");
}

function htmlText(node, items) {
  if (!node) return "";
  if (node.type === "text") return node.value;
  if (node.type === "comment") return protect(items, "html-comment", node.value ?? "");
  if (node.type !== "element") return (node.children ?? []).map((child) => htmlText(child, items)).join("");
  if (["code", "pre"].includes(node.tagName)) return protect(items, `html-${node.tagName}`, htmlStringifier.stringify(node));
  let text = (node.children ?? []).map((child) => htmlText(child, items)).join("");
  for (const property of ["href", "src", "poster"]) {
    if (node.properties?.[property] !== undefined) text += protect(items, `html-${property}`, String(node.properties[property]));
  }
  return text;
}

function collectAstSegments(tree, format, limits) {
  const segments = [];
  function visit(node, path, blockedBySegment = false) {
    const selected = format === "markdown"
      ? MARKDOWN_SEGMENTS.has(node.type)
      : node.type === "element" && HTML_SEGMENTS.has(node.tagName);
    if (selected && !blockedBySegment) {
      const protectedItems = [];
      const sourceText = (format === "markdown" ? markdownText(node, protectedItems) : htmlText(node, protectedItems)).trim();
      if (sourceText.length > limits.maxSegmentLength) throw new DocumentParseError("SEGMENT_LENGTH_LIMIT", "segment length limit exceeded");
      segments.push({
        ordinal: segments.length,
        kind: format === "markdown" ? node.type : node.tagName,
        structuralPath: `/${path.join("/")}`,
        sourceText,
        sourceDigest: digest(Buffer.from(sourceText)),
        translatable: sourceText.replace(/⟦LCT-P-[^⟧]+⟧/g, "").trim().length > 0,
        protected: protectedItems,
      });
      if (segments.length > limits.maxSegments) throw new DocumentParseError("SEGMENT_COUNT_LIMIT", "segment count limit exceeded");
    }
    node.children?.forEach((child, index) => visit(child, [...path, index], blockedBySegment || selected));
  }
  visit(tree, []);
  if (segments.length === 0) {
    const protectedItems = [];
    const sourceText = htmlText(tree, protectedItems).trim();
    if (sourceText.length > limits.maxSegmentLength) throw new DocumentParseError("SEGMENT_LENGTH_LIMIT", "segment length limit exceeded");
    if (sourceText.length > 0) segments.push({
      ordinal: 0,
      kind: "root",
      structuralPath: "/",
      sourceText,
      sourceDigest: digest(Buffer.from(sourceText)),
      translatable: sourceText.replace(/⟦LCT-P-[^⟧]+⟧/g, "").trim().length > 0,
      protected: protectedItems,
    });
  }
  return segments;
}

function collectTextSegments(text, limits) {
  const segments = [];
  const paragraphs = text.split(/\n{2,}/);
  let offset = 0;
  for (const paragraph of paragraphs) {
    if (paragraph.length > limits.maxSegmentLength) throw new DocumentParseError("SEGMENT_LENGTH_LIMIT", "segment length limit exceeded");
    if (paragraph.length > 0) {
      segments.push({
        ordinal: segments.length,
        kind: "paragraph",
        structuralPath: `/paragraph/${segments.length}`,
        sourceText: paragraph,
        sourceDigest: digest(Buffer.from(paragraph)),
        translatable: paragraph.trim().length > 0,
        protected: [],
        sourceOffset: offset,
      });
    }
    offset += paragraph.length + 2;
    if (segments.length > limits.maxSegments) throw new DocumentParseError("SEGMENT_COUNT_LIMIT", "segment count limit exceeded");
  }
  return segments;
}

export function normalizeDocument(format, input, { limits: overrides = {} } = {}) {
  if (!FORMATS.has(format)) throw new DocumentParseError("UNSUPPORTED_FORMAT", "unsupported document format");
  const limits = Object.freeze({ ...DEFAULT_IMPORT_LIMITS, ...overrides });
  const { bytes, text } = bytesAndText(input, limits);
  let normalized;
  let projection;
  let segments;
  let diagnostics = [];
  let treeMetrics = { nodes: 0, deepest: 0 };

  if (format === "text") {
    normalized = text;
    projection = { type: "text-document", paragraphs: text.split(/\n{2,}/).length };
    segments = collectTextSegments(text, limits);
  } else if (format === "markdown") {
    const initialTree = markdownProcessor.parse(text);
    diagnostics = sanitizeEmbeddedMarkdownHtml(initialTree);
    normalized = markdownProcessor.stringify(initialTree);
    const stableTree = markdownProcessor.parse(normalized);
    treeMetrics = inspectTree(stableTree, limits);
    projection = structuralProjection(stableTree);
    segments = collectAstSegments(stableTree, format, limits);
  } else {
    const parsed = htmlParser.parse(text);
    const sanitized = sanitizeHtmlTree(parsed);
    diagnostics = sanitized.findings;
    treeMetrics = inspectTree(sanitized.tree, limits);
    normalized = htmlStringifier.stringify(sanitized.tree);
    projection = structuralProjection(sanitized.tree);
    segments = collectAstSegments(sanitized.tree, format, limits);
  }

  return Object.freeze({
    format,
    originalBytes: Buffer.from(bytes),
    originalDigest: digest(bytes),
    normalized,
    normalizedDigest: digest(Buffer.from(normalized)),
    projection,
    projectionDigest: digest(Buffer.from(stableJson(projection))),
    segments: Object.freeze(segments.map((segment) => Object.freeze(segment))),
    diagnostics: Object.freeze(diagnostics.map((finding) => Object.freeze(finding))),
    requiresConfirmation: diagnostics.length > 0,
    parserVersion: PARSER_VERSION,
    sanitizerVersion: SANITIZER_VERSION,
    metrics: Object.freeze({ bytes: bytes.length, nodes: treeMetrics.nodes, depth: treeMetrics.deepest, segments: segments.length }),
  });
}

export function validateProtectedText(text, protectedItems) {
  const markers = [...text.matchAll(/⟦LCT-P-\d{4}-[0-9a-f]{16}⟧/g)].map((match) => match[0]);
  const expected = protectedItems.map((item) => item.marker);
  if (markers.length !== expected.length) throw new DocumentParseError("PROTECTION_TOKEN_COUNT", "protected token count mismatch");
  for (const marker of expected) {
    if (markers.filter((candidate) => candidate === marker).length !== 1) throw new DocumentParseError("PROTECTION_TOKEN_DUPLICATE", "protected token missing or duplicated");
  }
  if (markers.some((marker) => !expected.includes(marker))) throw new DocumentParseError("FORGED_PROTECTION_TOKEN", "unknown protected token");
  if (markers.some((marker, index) => marker !== expected[index])) throw new DocumentParseError("PROTECTION_TOKEN_ORDER", "protected token order changed");
  return true;
}
