import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildDeepSeekAgentRequest, normalizeDeepSeekAgentResponse } from "../../src/agent/deepseek-agent-provider.mjs";
import { providerResponseContract } from "../../src/provider/contracts.mjs";

const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const manifest = JSON.parse(await readFile(new URL("../fixtures/m5p-5/translation-matrix.json", import.meta.url), "utf8"));

test("fixed four-direction matrix is deterministic and keeps tool/no-tool boundaries", () => {
  assert.equal(manifest.schemaVersion, "m5p-translation-matrix-v1");
  assert.equal(digest(JSON.stringify(manifest)), "sha256:7ed2e3b003c4ff899f859e45124b2db5592272967faf9e8b742562f91d7e41ca");
  for (const direction of manifest.directions) for (const mode of manifest.modes) {
    const segmentId = randomUUID(); const toolNames = mode === "tools-enabled" ? ["lookup_dictionary", "lookup_entity", "calculate_number"] : [];
    const request = { modelId: "deepseek-v4-flash", mode: "normal", maxOutputTokens: 256, toolNames,
      context: { systemPrompt: "Return one JSON object with translation only.", messages: [{ role: "user", content: [{ type: "text", text: JSON.stringify({ segmentId, sourceLanguage: direction.sourceLanguage, targetLanguage: direction.targetLanguage, source: direction.source }) }] }] } };
    const outbound = buildDeepSeekAgentRequest(request); assert.equal(new URL(outbound.url).origin, "https://api.deepseek.com");
    assert.equal(outbound.body.messages.at(-1).content.includes(direction.source), true);
    assert.equal(outbound.body.tools?.length ?? 0, toolNames.length);
    const normalized = normalizeDeepSeekAgentResponse({ id: `fixture-${direction.id}-${mode}`, choices: [{ index: 0, finish_reason: "stop", message: { content: JSON.stringify({ translation: direction.expected }) } }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_cache_hit_tokens: 0 } }, request);
    const response = providerResponseContract({ responseId: normalized.responseId, providerId: "deepseek", modelId: "deepseek-v4-flash",
      candidates: [{ segmentId, text: JSON.parse(normalized.assistantMessage.content[0].text).translation, knowledgeNeeds: [] }], usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 0, totalTokens: 14 } },
      { workspaceId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), workflowId: randomUUID(), sourceRevisionId: randomUUID(), targetLanguage: direction.targetLanguage,
        providerId: "deepseek", modelId: "deepseek-v4-flash", promptVersion: "m5p5-matrix-v1", contextDigest: digest("context"), segments: [{ segmentId, sourceDigest: digest(direction.source), sourceText: direction.source, protected: [] }] });
    assert.equal(response.candidates[0].text, direction.expected);
  }
});
