export const realProviderCorpus = Object.freeze([
  Object.freeze({
    id: "md-en-zh", format: "markdown", sourceLanguage: "en", targetLanguage: "zh-CN",
    content: "---\ntitle: Public Camera Guide\ndraft: false\n---\n\n# Camera Guide\n\nRead the [public manual](https://example.com/manual) before loading film.[^1]\n\n[^1]: Synthetic public test note, 2026.",
  }),
  Object.freeze({
    id: "md-zh-en", format: "markdown", sourceLanguage: "zh-CN", targetLanguage: "en",
    content: "# 公开测试表格\n\n| 镜头 | 光圈 |\n| --- | ---: |\n| 标准镜头 | 1.8 |\n\n保留 {{< badge text=\"公开样例\" >}} 短代码。",
  }),
  Object.freeze({
    id: "md-ja-zh", format: "markdown", sourceLanguage: "ja", targetLanguage: "zh-CN",
    content: "# 公開テスト\n\n`npm test` を実行し、[公開資料](https://example.com/ja)を確認します。\n\n```sh\nprintf safe\n```",
  }),
  Object.freeze({
    id: "md-en-ja", format: "markdown", sourceLanguage: "en", targetLanguage: "ja",
    content: "# Public Checklist\n\n- Preserve the image target ![sample](/images/public.jpg).\n- Keep 20 kg and 2026-08-01 unchanged.\n- Translate only visible prose.",
  }),
  Object.freeze({
    id: "html-en-ja", format: "html", sourceLanguage: "en", targetLanguage: "ja",
    content: "<article><h1>Public Exhibit</h1><p>See the <a href=\"https://example.com/exhibit\">public catalog</a>.</p><img src=\"/public.jpg\" alt=\"Public sample\"></article>",
  }),
  Object.freeze({
    id: "html-zh-en", format: "html", sourceLanguage: "zh-CN", targetLanguage: "en",
    content: "<article><h1>公开参数</h1><table><thead><tr><th>项目</th><th>数值</th></tr></thead><tbody><tr><td>重量</td><td>20 kg</td></tr></tbody></table></article>",
  }),
  Object.freeze({
    id: "html-ja-zh", format: "html", sourceLanguage: "ja", targetLanguage: "zh-CN",
    content: "<main><blockquote><p>これは公開された合成テスト文です。</p></blockquote><p><em>構造</em>を保持します。</p></main>",
  }),
  Object.freeze({
    id: "html-en-zh", format: "html", sourceLanguage: "en", targetLanguage: "zh-CN",
    content: "<section><h2>Release Notes</h2><p>Version 2.0 is a synthetic public fixture.</p><ol><li>Import</li><li>Review</li><li>Export</li></ol></section>",
  }),
  Object.freeze({
    id: "text-en-zh", format: "text", sourceLanguage: "en", targetLanguage: "zh-CN",
    content: "This is a synthetic public paragraph.\nIt contains no personal information.\n\nThe second paragraph records 50 mm and 2026-08-01.",
  }),
  Object.freeze({
    id: "text-zh-ja", format: "text", sourceLanguage: "zh-CN", targetLanguage: "ja",
    content: "这是公开的合成测试段落。\n其中不包含个人信息。\n\n第二段要求保留数字 400 和单位 20 kg。",
  }),
  Object.freeze({
    id: "text-ja-en", format: "text", sourceLanguage: "ja", targetLanguage: "en",
    content: "これは公開用に作成した合成テスト段落です。\n個人情報は含まれていません。\n\n二番目の段落には ISO 400 が含まれます。",
  }),
  Object.freeze({
    id: "text-mixed-en", format: "text", sourceLanguage: "mul", targetLanguage: "en",
    content: "公开测试 / 公開テスト / Public test.\n\nAll three labels above are synthetic and safe to send under an approved run.",
  }),
]);
