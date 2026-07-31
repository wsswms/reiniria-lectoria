import { normalizeDocument, validateProtectedText } from "../document/parser.mjs";

export class SerializationError extends Error {
  constructor(message = "document serialization failed") {
    super(message);
    this.name = "SerializationError";
    this.code = "SERIALIZATION_ERROR";
  }
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escapeMarkdown(value) {
  return value.replaceAll("\\", "\\\\").replace(/([`*_[\]<>#+.!|{}()-])/g, "\\$1");
}

function markdownProtected(item) {
  const value = item.value;
  if (["inlineCode", "code"].includes(item.kind)) return `\`${value.replaceAll("`", "\\`")}\``;
  if (item.kind === "link-url") return `[link](${value})`;
  if (item.kind === "image-url") return `![image](${value})`;
  return value;
}

function htmlProtected(item) {
  const value = escapeHtml(item.value);
  if (item.kind === "html-comment") return `<!--${value}-->`;
  if (item.kind === "html-href") return `<a href="${value}"></a>`;
  if (item.kind === "html-src") return `<img src="${value}">`;
  if (["html-code", "html-pre"].includes(item.kind)) return value;
  return value;
}

function restore(text, protectedItems, format) {
  try { validateProtectedText(text, protectedItems); }
  catch { throw new SerializationError("protected values do not match the source segment"); }
  const items = new Map(protectedItems.map((item) => [item.marker, item]));
  const chunks = text.split(/(⟦LCT-P-\d{4}-[0-9a-f]{16}⟧)/g);
  return chunks.map((chunk) => {
    const item = items.get(chunk);
    if (item) return format === "html" ? htmlProtected(item) : format === "markdown" ? markdownProtected(item) : item.value;
    if (format === "html") return escapeHtml(chunk);
    if (format === "markdown") return escapeMarkdown(chunk);
    return chunk;
  }).join("");
}

function markdownBlock(segment) {
  const text = restore(segment.text, segment.protected, "markdown");
  if (segment.kind === "heading") return `# ${text}`;
  if (segment.kind === "code") return `\`\`\`\n${text}\n\`\`\``;
  if (["yaml", "toml"].includes(segment.kind)) return `---\n${text}\n---`;
  if (segment.kind === "tableCell") return `| ${text} |`;
  return text;
}

function htmlBlock(segment) {
  const tag = /^(?:p|h[1-6]|li|td|th|caption|figcaption|blockquote|pre)$/.test(segment.kind) ? segment.kind : "p";
  return `<${tag}>${restore(segment.text, segment.protected, "html")}</${tag}>`;
}

function protectedSignature(segments) {
  return segments.flatMap((segment) => segment.protected.map((item) => `${item.kind}\u0000${item.value}`)).sort();
}

export function serializeOrdinaryDocument(format, normalizedSource, segments) {
  if (!new Set(["markdown", "html", "text"]).has(format)) throw new SerializationError("unsupported ordinary export format");
  if (segments.every((segment) => segment.text === segment.sourceText)) return Buffer.from(normalizedSource);
  let output;
  if (format === "text") output = segments.map((segment) => restore(segment.text, segment.protected, "text")).join("\n\n");
  else if (format === "markdown") output = `${segments.map(markdownBlock).join("\n\n")}\n`;
  else output = segments.map(htmlBlock).join("\n");
  return Buffer.from(output);
}

export function verifyOrdinaryDocument(format, bytes, sourceSegments) {
  let parsed;
  try { parsed = normalizeDocument(format, bytes); }
  catch { throw new SerializationError("exported document cannot be parsed safely"); }
  if (parsed.segments.length !== sourceSegments.length) throw new SerializationError("exported segment set changed");
  for (let index = 0; index < parsed.segments.length; index += 1) {
    if (parsed.segments[index].kind !== sourceSegments[index].kind) throw new SerializationError("exported structure changed");
  }
  const expected = protectedSignature(sourceSegments);
  const actual = protectedSignature(parsed.segments);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new SerializationError("exported protected values changed");
  return parsed;
}
