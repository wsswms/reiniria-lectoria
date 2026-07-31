import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkStringify from "remark-stringify";
import rehypeParse from "rehype-parse";
import rehypeStringify from "rehype-stringify";

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ["yaml", "toml"])
  .use(remarkStringify, {
    bullet: "-",
    fence: "`",
    fences: true,
    listItemIndent: "one",
  });

const htmlProcessor = unified().use(rehypeParse, { fragment: true }).use(rehypeStringify);

export function parseDocument(kind, source) {
  if (kind === "markdown") return markdownProcessor.parse(source);
  if (kind === "html") return htmlProcessor.parse(source);
  throw new Error(`unsupported document kind: ${kind}`);
}

export function stringifyDocument(kind, tree) {
  if (kind === "markdown") return markdownProcessor.stringify(tree);
  if (kind === "html") return htmlProcessor.stringify(tree);
  throw new Error(`unsupported document kind: ${kind}`);
}

const omittedKeys = new Set(["position"]);
const criticalProperties = new Set([
  "type",
  "depth",
  "ordered",
  "start",
  "spread",
  "checked",
  "url",
  "title",
  "alt",
  "lang",
  "meta",
  "value",
  "tagName",
  "properties",
  "align",
]);

function normalizeValue(node, key, value) {
  if (key !== "value" || typeof value !== "string") return value;
  if (["text", "html"].includes(node.type)) return value.replace(/\s+/g, " ").trim();
  return value.replace(/\r\n/g, "\n").replace(/\n$/, "");
}

export function structuralProjection(node) {
  if (Array.isArray(node)) return node.map(structuralProjection);
  if (!node || typeof node !== "object") return node;
  const projected = {};
  for (const [key, value] of Object.entries(node)) {
    if (omittedKeys.has(key)) continue;
    if (key === "children") {
      projected.children = value.map(structuralProjection);
    } else if (criticalProperties.has(key)) {
      projected[key] = normalizeValue(node, key, value);
    }
  }
  return projected;
}

export function roundTrip(kind, source) {
  const beforeTree = parseDocument(kind, source);
  const serialized = stringifyDocument(kind, beforeTree);
  const afterTree = parseDocument(kind, serialized);
  return {
    before: structuralProjection(beforeTree),
    after: structuralProjection(afterTree),
    serialized,
  };
}

const activeTags = new Set(["script", "iframe", "object", "embed", "form"]);

export function detectActiveHtml(tree) {
  const findings = [];
  function visit(node, path = []) {
    if (node.type === "element") {
      if (activeTags.has(node.tagName)) findings.push({ path, reason: `active-tag:${node.tagName}` });
      for (const name of Object.keys(node.properties ?? {})) {
        if (name.toLowerCase().startsWith("on")) findings.push({ path, reason: `event-handler:${name}` });
      }
    }
    node.children?.forEach((child, index) => visit(child, [...path, index]));
  }
  visit(tree);
  return findings;
}
