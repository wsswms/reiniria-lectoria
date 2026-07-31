import { Type } from "typebox";
import {
  createAgentSession,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createControlledResourceLoader } from "./resource-loader.mjs";
import {
  createFakeProvider,
  fakeProviderConfig,
  FAKE_MODEL_ID,
  FAKE_PROVIDER_ID,
} from "./fake-provider.mjs";

export async function createIsolatedSession({ apiKey, observations = [] }) {
  const modelRuntime = await ModelRuntime.create({
    authPath: "/tmp/runner-home/auth.json",
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider(
    FAKE_PROVIDER_ID,
    fakeProviderConfig(createFakeProvider({ expectedApiKey: apiKey, observations })),
  );
  modelRuntime.setRuntimeApiKey(FAKE_PROVIDER_ID, apiKey);
  await modelRuntime.refresh({ allowNetwork: false });
  const model = modelRuntime.getModel(FAKE_PROVIDER_ID, FAKE_MODEL_ID);
  if (!model) throw new Error("fake model registration failed");

  const getTaskContext = defineTool({
    name: "get_task_context",
    label: "Get task context",
    description: "Return fixed test task metadata.",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: JSON.stringify({ taskId: "task-a", segmentIds: ["seg-a"] }) }],
      details: {},
    }),
  });

  const hangTool = defineTool({
    name: "hang_tool",
    label: "Hang until cancellation",
    description: "Test cancellation propagation into a tool.",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, signal) => {
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", resolve, { once: true });
      });
      const error = new Error("hang tool aborted");
      error.name = "AbortError";
      throw error;
    },
  });

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const cwd = "/tmp/runner-work";
  const { session } = await createAgentSession({
    cwd,
    agentDir: "/tmp/runner-home",
    model,
    modelRuntime,
    resourceLoader: createControlledResourceLoader(),
    customTools: [getTaskContext, hangTool],
    noTools: "builtin",
    tools: ["get_task_context", "hang_tool"],
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    thinkingLevel: "off",
  });

  return { session, observations };
}

export async function promptWithTimeout(session, prompt, timeoutMs) {
  const timer = setTimeout(() => void session.abort(), timeoutMs);
  try {
    await session.prompt(prompt);
  } finally {
    clearTimeout(timer);
  }
}
