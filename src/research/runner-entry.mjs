import { researchRunnerTaskContract, RESEARCH_RUNNER_OUTPUT_VERSION } from "./runner-protocol.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const task = researchRunnerTaskContract(JSON.parse(Buffer.concat(chunks).toString("utf8")));

function provider(capability) { return task.allowedProviders.find((item) => item.capability === capability)?.providerId; }
const actions = [];
let stopReason = null;
if (task.phase === "discover") {
  const providerId = provider("search");
  for (const question of task.questions.slice(0, task.limits.toolCalls)) if (providerId) actions.push({ tool: "search", providerId, query: question, url: null, observationIds: [] });
  if (!providerId) stopReason = "search-unavailable";
} else if (task.phase === "collect") {
  const providerId = provider("extract");
  for (const item of task.observations.filter((entry) => entry.type === "search-result" && entry.url).slice(0, task.limits.toolCalls))
    if (providerId) actions.push({ tool: "extract", providerId, query: null, url: item.url, observationIds: [item.id] });
  if (!providerId || actions.length === 0) stopReason = "content-unavailable";
} else {
  const providerId = provider("research-model");
  const ids = task.observations.filter((item) => item.type === "content").map((item) => item.id).slice(0, 64);
  if (providerId && ids.length > 0) actions.push({ tool: "synthesize", providerId, query: "Answer only the approved research questions from cited observations.", url: null, observationIds: ids });
  else stopReason = "evidence-insufficient";
}
process.stdout.write(JSON.stringify({ schemaVersion: RESEARCH_RUNNER_OUTPUT_VERSION, grantId: task.grantId, runId: task.runId,
  round: task.round, phase: task.phase, actions, stopReason }));
