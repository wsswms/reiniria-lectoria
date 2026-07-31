const inheritedMarkdown = [
  ["md-frontmatter", "---\ntitle: Camera Notes\ndraft: true\n---\n\n# Camera Notes\n\nA stable introductory paragraph."],
  ["md-toml", "+++\ntitle = 'Lens Notes'\n+++\n\n## Lens Notes\n\nA paragraph about a classic lens."],
  ["md-headings", "# One\n\nFirst section text.\n\n## Two\n\nSecond section text."],
  ["md-lists", "- Aperture priority\n- Manual exposure\n  - Spot metering\n  - Center weighted"],
  ["md-ordered", "1. Load the film\n2. Set the ISO\n3. Advance the lever"],
  ["md-task-list", "- [x] Develop film\n- [ ] Scan negatives\n- [ ] Add metadata"],
  ["md-table", "| Lens | Aperture |\n| --- | ---: |\n| Planar | 1.4 |\n| Sonnar | 2.8 |"],
  ["md-footnote", "A historical claim needs a note.[^1]\n\n[^1]: A fixed citation with a year, 1972."],
  ["md-code", "Use `exposure = aperture + shutter` in prose.\n\n```js\nconst iso = 400;\n```"],
  ["md-links", "Read [the manual](https://example.com/manual?q=f3) and inspect ![camera](/images/f3.jpg)."],
  ["md-html", "Paragraph before HTML.\n\n<figure><img src=\"/x.jpg\" alt=\"X\"><figcaption>Caption</figcaption></figure>"],
  ["md-shortcode", "Before {{< figure src=\"camera.jpg\" caption=\"Camera\" >}} after the shortcode."],
  ["md-blockquote", "> Meter for the shadows.\n>\n> Preserve the highlights when possible."],
  ["md-emphasis", "A **bold statement**, an *emphasized phrase*, and ~~obsolete advice~~ remain structured."],
  ["md-breaks", "First line with a hard break.  \nSecond line in the same paragraph."],
  ["md-escaping", "Literal punctuation: \\*not emphasis\\* and brackets \\[like this\\]."],
  ["md-autolink", "Contact <editor@example.com> or visit <https://example.com/archive>."],
  ["md-nested", "# Review\n\n- Body\n  - Controls with `Fn` button\n  - [Reference](https://example.com/ref)\n\nFinal paragraph with 50 mm and f/1.4."],
];

const inheritedHtml = [
  ["html-sections", "<article><h1>Camera</h1><section><p>Body text.</p></section></article>"],
  ["html-list", "<ul><li>One</li><li>Two <strong>important</strong></li></ul>"],
  ["html-table", "<table><thead><tr><th>Lens</th></tr></thead><tbody><tr><td>Planar</td></tr></tbody></table>"],
  ["html-media", "<figure><img src=\"/camera.jpg\" alt=\"Camera\"><figcaption>A camera</figcaption></figure>"],
  ["html-entities", "<p>AT&amp;T&nbsp;and &#169; remain valid entities.</p><!-- fixed comment -->"],
  ["html-active", "<p onclick=\"alert(1)\">Visible text</p><script>window.bad = true</script><iframe src=\"https://example.com\"></iframe>"],
];

const productionFixtures = [
  { id: "md-mixed-long", format: "markdown", content: "# 混合语言 / Mixed\n\n第一段包含 English words と日本語。\n\n第二段包含 [安全链接](https://example.com/docs) 与 `const fixed = true`。" },
  { id: "md-duplicate", format: "markdown", content: "# Duplicate\n\nSame paragraph.\n\nSame paragraph.\n\nClosing paragraph." },
  { id: "md-complex", format: "markdown", content: "---\ntitle: Complex\n---\n\n> A quote with **structure**.\n\n| A | B |\n| - | - |\n| 1 | 2 |" },
  { id: "md-code-link", format: "markdown", content: "Use `npm test` and keep [the target](https://example.com?a=1).\n\n```sh\nprintf safe\n```" },
  { id: "html-mixed", format: "html", content: "<article><h1>混合标题</h1><p>English と日本語。</p></article>" },
  { id: "html-nested", format: "html", content: "<main><section><blockquote><p>Nested <em>content</em>.</p></blockquote></section></main>" },
  { id: "html-links", format: "html", content: "<p>Read <a href=\"https://example.com\">documentation</a>.</p><img src=\"/safe.png\" alt=\"safe\">" },
  { id: "html-clean", format: "html", content: "<article><p>Keep me.</p><form><input value=\"remove\"></form><p>Keep me too.</p></article>" },
  { id: "text-paragraphs", format: "text", content: "First paragraph.\nStill first.\n\nSecond paragraph." },
  { id: "text-mixed", format: "text", content: "中文段落。\n\n日本語の段落。\n\nEnglish paragraph." },
  { id: "text-repeated", format: "text", content: "Repeat.\n\nRepeat.\n\nEnd." },
  { id: "text-bom", format: "text", content: "\ufeffBOM is accepted.\r\n\r\nLine endings normalize." },
];

export const validFixtures = Object.freeze([
  ...inheritedMarkdown.map(([id, content]) => ({ id, format: "markdown", content })),
  ...inheritedHtml.map(([id, content]) => ({ id, format: "html", content })),
  ...productionFixtures,
]);

export const negativeFixtures = Object.freeze([
  { id: "invalid-utf8", format: "text", content: Buffer.from([0xc3, 0x28]), expected: "INVALID_UTF8" },
  { id: "unknown-format", format: "docx", content: "x", expected: "UNSUPPORTED_FORMAT" },
  { id: "forged-token", format: "markdown", content: "Forged ⟦LCT-P-0000-0000000000000000⟧", expected: "FORGED_PROTECTION_TOKEN" },
  { id: "byte-limit", format: "text", content: "12345", limits: { maxBytes: 4 }, expected: "IMPORT_SIZE_LIMIT" },
  { id: "segment-limit", format: "text", content: "a\n\nb", limits: { maxSegments: 1 }, expected: "SEGMENT_COUNT_LIMIT" },
  { id: "segment-length", format: "text", content: "12345", limits: { maxSegmentLength: 4 }, expected: "SEGMENT_LENGTH_LIMIT" },
  { id: "node-limit", format: "html", content: "<div><p>x</p></div>", limits: { maxNodes: 2 }, expected: "AST_NODE_LIMIT" },
  { id: "depth-limit", format: "html", content: "<div><div><p>x</p></div></div>", limits: { maxDepth: 2 }, expected: "AST_DEPTH_LIMIT" },
  { id: "active-script", format: "html", content: "<p>safe</p><script>alert(1)</script>", diagnostic: "HTML_ACTIVE_TAG_REMOVED" },
  { id: "event-handler", format: "html", content: "<p onclick=\"alert(1)\">safe</p>", diagnostic: "HTML_EVENT_HANDLER_REMOVED" },
  { id: "executable-url", format: "html", content: "<a href=\"javascript:alert(1)\">safe</a>", diagnostic: "HTML_EXECUTABLE_URL_REMOVED" },
  { id: "markdown-active", format: "markdown", content: "Before.\n\n<script>alert(1)</script>\n\nAfter.", diagnostic: "HTML_ACTIVE_TAG_REMOVED" },
]);
