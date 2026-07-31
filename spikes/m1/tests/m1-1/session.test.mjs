import assert from "node:assert/strict";
import test from "node:test";
import { createIsolatedSession, promptWithTimeout } from "../../src/m1-1/session.mjs";

const CANARY = "M1_SECRET_CANARY_7b1f0c";

test("20 deterministic fake-provider sessions complete without built-in tools", async () => {
  for (let index = 0; index < 20; index += 1) {
    const events = [];
    const { session, observations } = await createIsolatedSession({ apiKey: CANARY });
    const unsubscribe = session.subscribe((event) => events.push(event));
    try {
      assert.deepEqual(session.getActiveToolNames(), ["get_task_context", "hang_tool"]);
      assert.deepEqual(session.getAllTools().map((tool) => tool.name).sort(), ["get_task_context", "hang_tool"]);
      await session.prompt(`normal-${index}`);
      assert.equal(observations.length, 1);
      assert.equal(observations[0].apiKeyMatched, true);
      assert.equal(JSON.stringify(events).includes(CANARY), false);
    } finally {
      unsubscribe();
      session.dispose();
    }
  }
});

test("scripted invalid provider response is an explicit failure", async () => {
  const { session } = await createIsolatedSession({ apiKey: CANARY });
  try {
    await session.prompt("invalid-response");
    const assistant = session.messages.at(-1);
    assert.equal(assistant.role, "assistant");
    assert.equal(assistant.stopReason, "error");
    assert.match(assistant.errorMessage, /scripted invalid response/);
  } finally {
    session.dispose();
  }
});

test("normal, provider timeout, hanging tool and user cancellation terminate within five seconds", async () => {
  const modes = ["normal", "hang-provider-timeout", "hang-tool", "hang-provider-user-cancel"];
  for (const mode of modes) {
    for (let index = 0; index < 10; index += 1) {
      const { session } = await createIsolatedSession({ apiKey: CANARY });
      try {
        const started = Date.now();
        if (mode === "normal") {
          await session.prompt(`normal-termination-${index}`);
        } else if (mode === "hang-provider-timeout") {
          await promptWithTimeout(session, `hang-provider-timeout-${index}`, 10);
        } else {
          const prompt = session.prompt(`${mode}-${index}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
          await session.abort();
          await prompt;
        }
        assert.ok(Date.now() - started < 5000, mode);
        assert.equal(session.isIdle, true, mode);
        const assistant = [...session.messages].reverse().find((message) => message.role === "assistant");
        if (mode !== "normal" && mode !== "hang-tool") assert.equal(assistant.stopReason, "aborted", mode);
        if (mode === "hang-tool") {
          const toolResult = [...session.messages].reverse().find((message) => message.role === "toolResult");
          assert.equal(toolResult?.isError, true, mode);
        }
      } finally {
        session.dispose();
      }
    }
  }
});
