const filler = "This public synthetic paragraph describes a stable workflow without changing any quantities or logical relations. ";

export const m5cQaEvaluationCorpus = Object.freeze([
  { id: "camera-ja-zh-short-ok", direction: "ja->zh-CN", domain: "camera", length: "short", source: "レンズは3枚です。", target: "镜片为3片。", labels: [] },
  { id: "camera-ja-zh-short-counter", direction: "ja->zh-CN", domain: "camera", length: "short", source: "レンズは3枚です。", target: "镜片为3组。", labels: ["measurement-category-changed"] },
  { id: "camera-ja-zh-medium-group", direction: "ja->zh-CN", domain: "camera", length: "medium", source: "構成は2組で、各組は3枚です。", target: "结构为2组，每组3片。", labels: [] },
  { id: "camera-ja-zh-long-number", direction: "ja->zh-CN", domain: "camera", length: "long", source: `${filler.repeat(20)}焦点距離は50 mmです。`, target: `${filler.repeat(20)}焦距为40 mm。`, labels: ["number-missing"] },
  { id: "software-en-zh-short-negation", direction: "en->zh-CN", domain: "software", length: "short", source: "The backup does not delete snapshots.", target: "备份会删除快照。", labels: ["negation-mismatch"] },
  { id: "software-en-zh-short-negation-ok", direction: "en->zh-CN", domain: "software", length: "short", source: "The backup does not delete snapshots.", target: "备份不会删除快照。", labels: [] },
  { id: "software-en-zh-medium-cause", direction: "en->zh-CN", domain: "software", length: "medium", source: "The task pauses because the budget is exhausted.", target: "任务暂停，预算已经耗尽。", labels: ["causal-marker-mismatch"] },
  { id: "software-en-zh-long-cause-ok", direction: "en->zh-CN", domain: "software", length: "long", source: `${filler.repeat(20)}The task pauses because the budget is exhausted.`, target: `${filler.repeat(20)}任务由于预算耗尽而暂停。`, labels: [] },
  { id: "science-zh-en-short-unit-ok", direction: "zh-CN->en", domain: "science", length: "short", source: "样品质量为5 kg。", target: "The sample mass is 5 kg.", labels: [] },
  { id: "science-zh-en-short-number", direction: "zh-CN->en", domain: "science", length: "short", source: "样品质量为5 kg。", target: "The sample mass is 4 kg.", labels: ["number-missing"] },
  { id: "science-zh-en-medium-causal", direction: "zh-CN->en", domain: "science", length: "medium", source: "由于温度达到20 °C，系统停止。", target: "The system stops at 20 °C.", labels: ["causal-marker-mismatch"] },
  { id: "science-zh-en-long-ok", direction: "zh-CN->en", domain: "science", length: "long", source: `${filler.repeat(20)}样品不是2组，而是3组。`, target: `${filler.repeat(20)}The samples are not 2 groups but 3 groups.`, labels: [] },
].map((item) => Object.freeze({ ...item, labels: Object.freeze(item.labels) })));

const THINKING_COMPARISON_IDS = new Set([
  "camera-ja-zh-short-ok",
  "camera-ja-zh-short-counter",
  "camera-ja-zh-medium-group",
  "camera-ja-zh-long-number",
  "software-en-zh-short-negation",
  "software-en-zh-short-negation-ok",
  "software-en-zh-medium-cause",
  "software-en-zh-long-cause-ok",
  "science-zh-en-short-number",
  "science-zh-en-medium-causal",
]);

export const m5cQaThinkingComparisonCorpus = Object.freeze(m5cQaEvaluationCorpus.filter((item) => THINKING_COMPARISON_IDS.has(item.id)));
