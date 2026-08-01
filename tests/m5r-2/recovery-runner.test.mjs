import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { researchRunnerOutputContract } from "../../src/research/runner-protocol.mjs";
import { runResearchProcess } from "../../src/research/process-runner.mjs";
import { ResearchRunService, RESEARCH_PAUSE_REASONS } from "../../src/research/run-service.mjs";
import { researchWorkspace, model, runnerTask, sha, system, user } from "./helpers.mjs";

test("queued running every paused reason completed failed and canceled recover thirty times each", async () => {
  const fixture = await researchWorkspace();
  try {
    const desired = ["queued", "running", ...RESEARCH_PAUSE_REASONS.map((reason) => `paused:${reason}`), "completed", "failed", "canceled"];
    for (const target of desired) for (let repeat = 0; repeat < 30; repeat += 1) {
      const request = { ...fixture.request, requestId: randomUUID(), revisionId: randomUUID(), questions: [`Recovery ${target} ${repeat}`],
        localEvidenceDigest: sha(`recovery-${target}-${repeat}`), createdAt: fixture.now().toISOString() };
      fixture.foundation.createRequest(request, model);
      fixture.foundation.submitRequest(request.requestId, 0, model);
      fixture.foundation.decideRequest(request.requestId, 1, "approved", user);
      const grant = fixture.foundation.issueGrant(request.requestId, { ...fixture.grant, grantId: randomUUID(), requestId: request.requestId,
        requestRevisionId: request.revisionId, providers: fixture.grant.providers.map((item) => ({ ...item })), limits: { ...fixture.grant.limits },
        allowedDomains: [...fixture.grant.allowedDomains], allowedLanguages: [...fixture.grant.allowedLanguages], approvedBy: user,
        approvedAt: fixture.now().toISOString(), expiresAt: new Date(1_800_000).toISOString() }, user).grant;
      const run = fixture.runs.create(grant.grantId, sha(`run-${target}-${repeat}`), system);
      if (target !== "queued") fixture.runs.transition(run.runId, "running", { actor: system });
      if (target.startsWith("paused:")) fixture.runs.transition(run.runId, "paused", { reason: target.slice(7), actor: system });
      else if (["completed", "failed", "canceled"].includes(target)) fixture.runs.transition(run.runId, target, { actor: system });
      const recovered = new ResearchRunService(fixture.setup.fixture.database, fixture.setup.fixture.workspaceId, { now: fixture.now }).get(run.runId);
      assert.equal(recovered.state, target.split(":")[0]);
      assert.equal(recovered.reason, target.startsWith("paused:") ? target.slice(7) : null);
    }
  } finally { await fixture.close(); }
});

test("runner output identity provider tool query URL observation budget and state forgeries fail two hundred times each", async () => {
  const fixture = await researchWorkspace();
  try {
    const task = runnerTask(fixture, "discover");
    const output = await runResearchProcess(task);
    const plain = JSON.parse(JSON.stringify(output));
    const mutations = [
      (value) => { value.grantId = randomUUID(); },
      (value) => { value.runId = randomUUID(); },
      (value) => { value.round = 10; },
      (value) => { value.phase = "collect"; },
      (value) => { value.actions[0].providerId = "ungranted"; },
      (value) => { value.actions[0].tool = "shell"; },
      (value) => { value.actions[0].query = "x".repeat(2_049); },
      (value) => { value.actions[0].observationIds = ["forged-observation"]; },
    ];
    for (const mutate of mutations) for (let repeat = 0; repeat < 200; repeat += 1) {
      const forged = structuredClone(plain); mutate(forged); assert.throws(() => researchRunnerOutputContract(forged, task), TypeError);
    }
  } finally { await fixture.close(); }
});

test("a successful tool receipt is idempotent and never executes the adapter twice", async () => {
  const fixture = await researchWorkspace();
  try {
    const input = { providerId: "fake-search", round: 1, query: "idempotent query", language: "en", country: "US", count: 2, idempotencyKey: "same-success" };
    await fixture.gateway.search(fixture.capability, fixture.run.runId, input);
    assert.equal(fixture.search.calls.length, 1);
    await assert.rejects(() => fixture.gateway.search(fixture.capability, fixture.run.runId, input), /cannot execute twice/);
    assert.equal(fixture.search.calls.length, 1);
  } finally { await fixture.close(); }
});
