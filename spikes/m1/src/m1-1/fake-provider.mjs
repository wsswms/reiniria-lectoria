import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export const FAKE_PROVIDER_ID = "reiniria-fake";
export const FAKE_MODEL_ID = "deterministic-v1";

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistantMessage(model) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function lastUserText(context) {
  const message = [...context.messages].reverse().find((item) => item.role === "user");
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function abortError(output, stream) {
  output.stopReason = "aborted";
  output.errorMessage = "fake provider aborted";
  stream.push({ type: "error", reason: "aborted", error: output });
}

function toolCall(output, stream, name) {
  const call = { type: "toolCall", id: `fake-${Date.now()}`, name, arguments: {} };
  output.content.push(call);
  output.stopReason = "toolUse";
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
  stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: output });
  stream.push({ type: "done", reason: "toolUse", message: output });
}

export function createFakeProvider({ expectedApiKey, observations }) {
  return (model, context, options = {}) => {
    const stream = createAssistantMessageEventStream();
    const output = assistantMessage(model);
    observations.push({
      apiKeyMatched: options.apiKey === expectedApiKey,
      prompt: lastUserText(context),
    });

    queueMicrotask(async () => {
      stream.push({ type: "start", partial: output });
      const prompt = lastUserText(context);

      if (prompt.includes("invalid-response")) {
        output.stopReason = "error";
        output.errorMessage = "scripted invalid response";
        stream.push({ type: "error", reason: "error", error: output });
        return;
      }

      if (prompt.includes("hang-provider")) {
        if (options.signal?.aborted) {
          abortError(output, stream);
          return;
        }
        options.signal?.addEventListener("abort", () => abortError(output, stream), { once: true });
        return;
      }

      if (prompt.includes("hang-tool") && !context.messages.some((message) => message.role === "toolResult")) {
        toolCall(output, stream, "hang_tool");
        return;
      }

      const text = "fake-ok";
      output.content.push({ type: "text", text });
      output.stopReason = "stop";
      stream.push({ type: "text_start", contentIndex: 0, partial: output });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
      stream.push({ type: "done", reason: "stop", message: output });
    });

    return stream;
  };
}

export function fakeProviderConfig(streamSimple) {
  return {
    name: "Reiniria deterministic fake provider",
    baseUrl: "http://fake.invalid",
    apiKey: "$REINIRIA_FAKE_PROVIDER_KEY",
    api: "openai-completions",
    streamSimple,
    models: [
      {
        id: FAKE_MODEL_ID,
        name: "Deterministic fake model",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 1024,
      },
    ],
  };
}
