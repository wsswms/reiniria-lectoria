import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ResearchAuthorizationError, ResearchConflictError } from "../../src/research/foundation-service.mjs";
import { researchWorkspace, model, sha, user } from "./helpers.mjs";

test("one hundred grant contenders produce one immutable grant and one hundred reservations never cross hard budgets", async () => {
  const fixture = await researchWorkspace({ limits: { maxSearchCalls: 12 }, providerBudgets: { "fake-search": { maxSearchCalls: 5 } } });
  try {
    const request = { ...fixture.request, requestId: randomUUID(), revisionId: randomUUID(), createdAt: fixture.now().toISOString() };
    fixture.foundation.createRequest(request, model);
    fixture.foundation.submitRequest(request.requestId, 0, model);
    fixture.foundation.decideRequest(request.requestId, 1, "approved", user);
    const contenders = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => Promise.resolve().then(() => fixture.foundation.issueGrant(request.requestId, {
      ...fixture.grant, grantId: randomUUID(), requestId: request.requestId, requestRevisionId: request.revisionId,
      approvedAt: fixture.now().toISOString(), expiresAt: new Date(1_800_000).toISOString(),
      providers: fixture.grant.providers.map((item) => ({ ...item })), limits: { ...fixture.grant.limits },
      allowedDomains: [...fixture.grant.allowedDomains], allowedLanguages: [...fixture.grant.allowedLanguages], approvedBy: user,
    }, user))));
    assert.equal(contenders.filter((item) => item.status === "fulfilled").length, 1);

    const reservations = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => Promise.resolve().then(() => fixture.budgets.reserve(fixture.run.runId, {
      round: 1, capability: "search", providerId: "fake-search", query: `bounded query ${index}`, language: "en", country: "US",
      idempotencyKey: `budget-${index}`, estimate: { searchCalls: 1, contentUrls: 0, modelTokens: 0, costMicrosUsd: 0 },
    }))));
    assert.equal(reservations.filter((item) => item.status === "fulfilled").length, 5);
    assert.equal(reservations.filter((item) => item.status === "rejected").every((item) => item.reason instanceof ResearchConflictError), true);
    assert.deepEqual(fixture.budgets.totals(fixture.grant.grantId), { searchCalls: 5, contentUrls: 0, modelTokens: 0, costMicrosUsd: 0 });
    assert.deepEqual(fixture.budgets.totals(fixture.grant.grantId, "fake-search"), { searchCalls: 5, contentUrls: 0, modelTokens: 0, costMicrosUsd: 0 });
  } finally { await fixture.close(); }
});

test("settled released and unknown outcomes reconcile exactly; unknown never auto-retries", async () => {
  const calls = [];
  const fixture = await researchWorkspace({ adapterOverrides: { search: { async search() { calls.push("called"); throw Object.assign(new Error("disconnect"), { category: "unknown" }); } } } });
  try {
    const input = { providerId: "fake-search", round: 1, query: "disconnect fixture", language: "en", country: "US", count: 2, idempotencyKey: "unknown-search" };
    await assert.rejects(() => fixture.gateway.search(fixture.capability, fixture.run.runId, input), /disconnect/);
    assert.equal(calls.length, 1);
    await assert.rejects(() => fixture.gateway.search(fixture.capability, fixture.run.runId, input), ResearchConflictError);
    assert.equal(calls.length, 1);
    assert.deepEqual(fixture.budgets.totals(fixture.grant.grantId), { searchCalls: 1, contentUrls: 0, modelTokens: 0, costMicrosUsd: 0 });
    fixture.runs.transition(fixture.run.runId, "paused", { reason: "unknown-outcome", details: { query: sha("unknown-search") }, actor: { type: "system", id: "m5r-2-control-plane" } });
    assert.throws(() => fixture.runs.transition(fixture.run.runId, "running", { actor: { type: "user", id: user.id } }), ResearchAuthorizationError);
    const retry = fixture.runs.retryUnknown(fixture.run.runId, user);
    assert.equal(retry.attempt, 2);
    assert.equal(retry.state, "queued");
  } finally { await fixture.close(); }
});

test("runner capability forgeries cannot expand workspace grant run provider tool round or revocation scope", async () => {
  const fixture = await researchWorkspace();
  try {
    const attacks = [
      () => fixture.capabilities.verify(fixture.capability, { runId: randomUUID(), tool: "propose-query", capability: "search", providerId: "fake-search" }),
      () => fixture.capabilities.verify(`${fixture.capability}x`, { runId: fixture.run.runId, tool: "propose-query", capability: "search", providerId: "fake-search" }),
      () => fixture.capabilities.verify(fixture.capability, { runId: fixture.run.runId, tool: "shell", capability: "search", providerId: "fake-search" }),
      () => fixture.capabilities.verify(fixture.capability, { runId: fixture.run.runId, tool: "propose-query", capability: "search", providerId: "ungranted-search" }),
    ];
    for (const attack of attacks) for (let repeat = 0; repeat < 200; repeat += 1) assert.throws(attack, ResearchAuthorizationError);
    for (let repeat = 0; repeat < 200; repeat += 1) assert.throws(() => fixture.budgets.reserve(fixture.run.runId, {
      round: 11, capability: "search", providerId: "fake-search", query: "forged round", language: "en", country: "US",
      idempotencyKey: `forged-${repeat}`, estimate: { searchCalls: 1, contentUrls: 0, modelTokens: 0, costMicrosUsd: 0 },
    }), ResearchConflictError);
    fixture.foundation.revokeGrant(fixture.grant.grantId, "test revocation", user);
    for (let repeat = 0; repeat < 200; repeat += 1) assert.throws(() => fixture.capabilities.verify(fixture.capability, {
      runId: fixture.run.runId, tool: "propose-query", capability: "search", providerId: "fake-search" }), ResearchAuthorizationError);
  } finally { await fixture.close(); }
});
