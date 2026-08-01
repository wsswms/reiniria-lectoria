import assert from "node:assert/strict";
import test from "node:test";
import { runResearchProcess } from "../../src/research/process-runner.mjs";
import { stableJson } from "../../src/domain/contracts.mjs";
import { researchWorkspace, runnerTask } from "./helpers.mjs";

test("the low-privilege process runner drives a three-phase fake research loop into a supported report", async () => {
  const fixture = await researchWorkspace();
  try {
    const discoverTask = runnerTask(fixture, "discover");
    const discover = await runResearchProcess(discoverTask);
    assert.deepEqual(discover.actions.map((item) => item.tool), ["search"]);
    const search = await fixture.gateway.search(fixture.capability, fixture.run.runId, { ...discover.actions[0], round: 1,
      language: "en", country: "US", count: 2, idempotencyKey: "search-1" });
    assert.equal(search.results.length, 2);

    const searchObservations = search.results.map((item) => ({ type: "search-result", id: `search-${item.rank}`, url: item.url,
      title: item.title, contentDigest: search.responseDigest, untrusted: true }));
    const collect = await runResearchProcess(runnerTask(fixture, "collect", searchObservations));
    assert.deepEqual(collect.actions.map((item) => item.tool), ["extract", "extract"]);
    const extracted = [];
    for (const [index, action] of collect.actions.entries()) extracted.push(await fixture.gateway.extract(fixture.capability, fixture.run.runId, {
      ...action, round: 1, language: "en", country: "US", idempotencyKey: `extract-${index + 1}` }));
    assert.equal(fixture.content.calls.length, 2);

    const sources = extracted.map((item, index) => fixture.evidence.addSource(fixture.run.runId, item.queryId, {
      canonicalUrl: item.url, tier: index === 0 ? "S1" : "S2", lineage: "provider-processed",
      artifactType: "provider-content-snapshot", artifactId: item.snapshotId }));
    const citations = sources.map((source, index) => {
      const content = extracted[index].content;
      const quote = "Workspace is the product term.";
      const start = content.indexOf(quote);
      return fixture.evidence.cite(source.sourceId, { quote, locator: { start, end: start + quote.length } });
    });
    const claim = fixture.evidence.claim(fixture.run.runId, { text: "Workspace is the authoritative product term.",
      citationIds: citations.map((item) => item.citationId), inference: false, disputed: false, insufficient: false, narrowOfficial: false });
    assert.equal(claim.supportLevel, "C3");

    const contentObservations = extracted.map((item) => ({ type: "content", id: item.snapshotId, url: item.url,
      title: "Provider processed public fixture", contentDigest: item.contentDigest, untrusted: true }));
    const synthesize = await runResearchProcess(runnerTask(fixture, "synthesize", contentObservations));
    assert.deepEqual(synthesize.actions.map((item) => item.tool), ["synthesize"]);
    await fixture.gateway.reason(fixture.capability, fixture.run.runId, { providerId: synthesize.actions[0].providerId, round: 1,
      prompt: synthesize.actions[0].query, fixture: { questions: fixture.request.questions, conclusion: claim.text },
      language: "en", country: "US", idempotencyKey: "reason-1" });
    const report = fixture.evidence.report(fixture.run.runId, { questionAnswers: [{ question: fixture.request.questions[0],
      answer: claim.text, status: "supported" }], claimIds: [claim.claimId], usage: fixture.budgets.totals(fixture.grant.grantId) });
    assert.equal(report.outcome, "supported");
    for (let repeat = 0; repeat < 20; repeat += 1) assert.equal(stableJson(fixture.evidence.report(fixture.run.runId, {
      questionAnswers: [{ question: fixture.request.questions[0], answer: claim.text, status: "supported" }],
      claimIds: [claim.claimId], usage: fixture.budgets.totals(fixture.grant.grantId) })), stableJson(report));
    fixture.runs.transition(fixture.run.runId, "completed", { actor: { type: "system", id: "m5r-2-control-plane" } });
    assert.equal(fixture.runs.get(fixture.run.runId).state, "completed");
  } finally { await fixture.close(); }
});
