import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runRealArticlePilotCore } from "../../src/pilot/real-article-pilot.mjs";

test("offline article pilot emits a private draft and never approves or applies proposals", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-pilot-core-"));
  try {
    const output = join(root, "output"); await mkdir(output, { mode: 0o700 }); await chmod(output, 0o700);
    const config = { article: { digest: `sha256:${"a".repeat(64)}`, sourceLanguage: "ja", targetLanguage: "zh-CN" },
      research: { questions: ["What is P mount?"], allowedDomains: [] }, output: { directory: output } };
    let investigateInput;
    const summary = await runRealArticlePilotCore({ config, articleText: "一段。\n\n二段。",
      translate: async ({ sourceParagraphs }) => ({ segments: sourceParagraphs.map((sourceText) => ({ segmentId: randomUUID(), sourceText, targetText: `中:${sourceText}` })),
        usage: { calls: 2, inputTokens: 20, outputTokens: 10, costMicrosUsd: 1 }, validation: { errors: 0, warnings: 0 } }),
      investigate: async (input) => { investigateInput = input; return { questions: [{ question: input.questions[0], answer: "supported", status: "supported" }],
        claims: [{ text: "claim", citations: [{ url: "https://example.com", quote: "quote" }] }],
        proposals: [{ proposalId: randomUUID(), state: "draft", decision: null, appliedAt: null }],
        usage: { modelCalls: 1, searchCalls: 1, contentUrls: 1, modelTokens: 20, costMicrosUsd: 2 } }; }, now: () => new Date(0) });
    assert.equal(summary.status, "completed-draft"); assert.equal(summary.proposalsApplied, 0); assert.equal(investigateInput.translation.length, 2);
    const artifact = JSON.parse(await readFile(summary.artifactPath, "utf8"));
    assert.equal(artifact.translation.humanReviewed, false); assert.equal(artifact.translation.approved, false); assert.equal(artifact.research.report.proposals[0].state, "draft");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pilot fails closed on incomplete translation and non-draft proposals", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-pilot-fail-"));
  try {
    const output = join(root, "output"); await mkdir(output, { mode: 0o700 });
    const config = { article: { digest: `sha256:${"b".repeat(64)}`, sourceLanguage: "ja", targetLanguage: "zh-CN" },
      research: { questions: ["q"], allowedDomains: [] }, output: { directory: output } };
    await assert.rejects(runRealArticlePilotCore({ config, articleText: "a\n\nb", translate: async () => ({ segments: [], usage: {}, validation: { errors: 0 } }), investigate: async () => ({}) }), /cover every segment/);
    await assert.rejects(runRealArticlePilotCore({ config, articleText: "a", translate: async () => ({ segments: [{ segmentId: "s", sourceText: "a", targetText: "中" }], usage: { calls: 1 }, validation: { errors: 0 } }),
      investigate: async () => ({ questions: [], claims: [], proposals: [{ state: "approved", decision: "approved", appliedAt: null }], usage: {} }) }), /draft-only/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
