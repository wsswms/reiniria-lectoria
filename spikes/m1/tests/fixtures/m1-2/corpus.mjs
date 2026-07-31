export const markdownFixtures = [
  { id: "md-frontmatter", content: "---\ntitle: Camera Notes\ndraft: true\n---\n\n# Camera Notes\n\nA stable introductory paragraph." },
  { id: "md-toml", content: "+++\ntitle = 'Lens Notes'\n+++\n\n## Lens Notes\n\nA paragraph about a classic lens." },
  { id: "md-headings", content: "# One\n\nFirst section text.\n\n## Two\n\nSecond section text." },
  { id: "md-lists", content: "- Aperture priority\n- Manual exposure\n  - Spot metering\n  - Center weighted" },
  { id: "md-ordered", content: "1. Load the film\n2. Set the ISO\n3. Advance the lever" },
  { id: "md-task-list", content: "- [x] Develop film\n- [ ] Scan negatives\n- [ ] Add metadata" },
  { id: "md-table", content: "| Lens | Aperture |\n| --- | ---: |\n| Planar | 1.4 |\n| Sonnar | 2.8 |" },
  { id: "md-footnote", content: "A historical claim needs a note.[^1]\n\n[^1]: A fixed citation with a year, 1972." },
  { id: "md-code", content: "Use `exposure = aperture + shutter` in prose.\n\n```js\nconst iso = 400;\n```" },
  { id: "md-links", content: "Read [the manual](https://example.com/manual?q=f3) and inspect ![camera](/images/f3.jpg)." },
  { id: "md-html", content: "Paragraph before HTML.\n\n<figure><img src=\"/x.jpg\" alt=\"X\"><figcaption>Caption</figcaption></figure>" },
  { id: "md-shortcode", content: "Before {{< figure src=\"camera.jpg\" caption=\"Camera\" >}} after the shortcode." },
  { id: "md-blockquote", content: "> Meter for the shadows.\n>\n> Preserve the highlights when possible." },
  { id: "md-emphasis", content: "A **bold statement**, an *emphasized phrase*, and ~~obsolete advice~~ remain structured." },
  { id: "md-breaks", content: "First line with a hard break.  \nSecond line in the same paragraph." },
  { id: "md-escaping", content: "Literal punctuation: \\*not emphasis\\* and brackets \\[like this\\]." },
  { id: "md-autolink", content: "Contact <editor@example.com> or visit <https://example.com/archive>." },
  { id: "md-nested", content: "# Review\n\n- Body\n  - Controls with `Fn` button\n  - [Reference](https://example.com/ref)\n\nFinal paragraph with 50 mm and f/1.4." },
];

export const htmlFixtures = [
  { id: "html-sections", content: "<article><h1>Camera</h1><section><p>Body text.</p></section></article>" },
  { id: "html-list", content: "<ul><li>One</li><li>Two <strong>important</strong></li></ul>" },
  { id: "html-table", content: "<table><thead><tr><th>Lens</th></tr></thead><tbody><tr><td>Planar</td></tr></tbody></table>" },
  { id: "html-media", content: "<figure><img src=\"/camera.jpg\" alt=\"Camera\"><figcaption>A camera</figcaption></figure>" },
  { id: "html-entities", content: "<p>AT&amp;T&nbsp;and &#169; remain valid entities.</p><!-- fixed comment -->" },
  { id: "html-active", content: "<p onclick=\"alert(1)\">Visible text</p><script>window.bad = true</script><iframe src=\"https://example.com\"></iframe>" },
];

export const allFixtures = [
  ...markdownFixtures.map((fixture) => ({ ...fixture, kind: "markdown" })),
  ...htmlFixtures.map((fixture) => ({ ...fixture, kind: "html" })),
];
