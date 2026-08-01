const directions = Object.freeze([
  ["en", "zh-CN", "Use workspace backup safely."], ["zh-CN", "en", "请安全使用工作区备份。"],
  ["en", "ja", "Use workspace backup safely."], ["ja", "en", "ワークスペースのバックアップを安全に使用してください。"],
  ["zh-CN", "ja", "请安全使用工作区备份。"], ["ja", "zh-CN", "ワークスペースのバックアップを安全に使用してください。"],
]);
const formats = Object.freeze(["markdown", "html", "text"]);
function content(format, text) {
  if (format === "markdown") return `# Public guide\n\n${text}`;
  if (format === "html") return `<article><h1>Public guide</h1><p>${text}</p></article>`;
  return `Public guide\n\n${text}`;
}
export const m5r5Corpus = Object.freeze(directions.flatMap(([sourceLanguage, targetLanguage, text]) => formats.map((format) => Object.freeze({
  id: `${sourceLanguage.toLowerCase()}-${targetLanguage.toLowerCase()}-${format}`.replaceAll("-cn", "cn"), sourceLanguage, targetLanguage,
  format, title: `${sourceLanguage} to ${targetLanguage} ${format}`, content: content(format, text), dataClass: "public-synthetic",
}))));
export const m5r5CorpusManifest = Object.freeze({ schemaVersion: "m5r-5-corpus-v1", documents: m5r5Corpus.length,
  directions: directions.map(([sourceLanguage, targetLanguage]) => `${sourceLanguage}->${targetLanguage}`), formats });
