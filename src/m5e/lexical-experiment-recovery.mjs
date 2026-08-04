export function classifyLexicalAuditEvents(events) {
  if (!Array.isArray(events)) throw new TypeError("lexical audit events are invalid");
  if (events.length === 0) return Object.freeze({ consumed: false, status: "not-started" });
  const requests = events.filter((event) => event?.event === "request"); const responses = events.filter((event) => event?.event === "response");
  if (requests.length !== 1 || responses.length > 1 || events[0]?.event !== "request"
    || (responses.length === 1 && events.at(-1)?.event !== "response") || events.some((event) => !["request", "response"].includes(event?.event))) {
    throw new TypeError("lexical audit sequence is invalid");
  }
  return Object.freeze({ consumed: true, status: responses.length === 0 || responses[0].outcome?.error?.category === "unknown-outcome"
    ? "unknown" : responses[0].outcome?.normalized === true ? "completed" : "failed" });
}

export function lexicalAuditUsage(events) {
  if (!Array.isArray(events)) throw new TypeError("lexical audit events are invalid");
  const responses = events.filter((event) => event?.event === "response");
  if (responses.length > 1) throw new TypeError("lexical audit has multiple responses");
  const item = responses[0]?.response?.usage; if (!item) return null;
  const inputTokens = item.prompt_tokens, outputTokens = item.completion_tokens, totalTokens = item.total_tokens;
  if (![inputTokens, outputTokens, totalTokens].every((value) => Number.isSafeInteger(value) && value >= 0)
    || inputTokens + outputTokens !== totalTokens) return null;
  const reasoning = item.completion_tokens_details?.reasoning_tokens;
  const reasoningTokens = reasoning === undefined ? 0 : reasoning;
  if (!Number.isSafeInteger(reasoningTokens) || reasoningTokens < 0 || reasoningTokens > outputTokens) return null;
  return Object.freeze({ calls: 1, inputTokens, outputTokens, reasoningTokens, totalTokens,
    costMicrosCny: Math.ceil((inputTokens * 28 + outputTokens * 56) / 10), durationMs: responses[0].elapsedMs ?? 0 });
}

export function lexicalRunnableTasks(tasks, states, excludedTaskIds = new Set()) {
  if (!Array.isArray(tasks) || !(states instanceof Map) || !(excludedTaskIds instanceof Set)) {
    throw new TypeError("lexical recovery state is invalid");
  }
  return Object.freeze(tasks.filter((task) => !states.has(task.taskId) && !excludedTaskIds.has(task.taskId)
    && task.dependencyTaskIds.every((taskId) => states.get(taskId) === "completed")).sort((left, right) => left.sequence - right.sequence));
}
