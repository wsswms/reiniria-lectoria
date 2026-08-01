import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { ResearchAuthorizationError, ResearchConflictError, ResearchFoundationService } from "../../src/research/foundation-service.mjs";
import { RESEARCH_LIMITS } from "../../src/research/contracts.mjs";
import { capture, enqueueEvidence, evidenceWorkspace } from "../m5-3/helpers.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const model = Object.freeze({ type: "model", id: "research-gap-detector-v1" });
const user = Object.freeze({ type: "user", id: "research-user" });

function requestInput(setup, bound, overrides = {}) {
  return { schemaVersion: "1.0", requestId: randomUUID(), revisionId: randomUUID(),
    taskId: bound.task.task.task_id, workflowId: setup.workflow.workflowId, documentId: setup.workflow.documentId,
    sourceRevisionId: setup.workflow.sourceRevisionId, targetLanguage: setup.workflow.targetLanguage,
    segmentIds: [setup.workflow.segmentId], gapKinds: ["term"], questions: ["What is the official product term?"],
    localEvidenceDigest: sha("local-evidence"), origin: model, createdAt: new Date(0).toISOString(), ...overrides };
}

function grantInput(request, overrides = {}) {
  return { schemaVersion: "1.0", grantId: randomUUID(), requestId: request.requestId, requestRevisionId: request.revisionId,
    providers: [{ capability: "search", providerId: "brave-search", fallbackOrder: 0,
      budget: { maxSearchCalls: 12, maxContentUrls: 0, maxModelTokens: 0, maxCostMicrosUsd: 0 } }], limits: { ...RESEARCH_LIMITS.defaults },
    allowedDomains: ["example.com"], allowedLanguages: ["en", "zh-CN"], approvedBy: user,
    approvedAt: new Date(0).toISOString(), expiresAt: new Date(1_800_000).toISOString(), ...overrides };
}

async function setupService() {
  const setup = await evidenceWorkspace();
  const bound = enqueueEvidence(setup, capture(setup), "m5r-1-task");
  let milliseconds = 0;
  const service = new ResearchFoundationService(setup.fixture.database, setup.fixture.workspaceId, { now: () => new Date(milliseconds) });
  return { setup, bound, service, advance(amount) { milliseconds += amount; } };
}

test("model draft requires a user decision before an immutable grant can become active", async () => {
  const fixture = await setupService();
  try {
    const input = requestInput(fixture.setup, fixture.bound);
    let request = fixture.service.createRequest(input, model);
    assert.equal(request.head.state, "draft");
    request = fixture.service.submitRequest(input.requestId, 0, model);
    assert.equal(request.head.state, "pending-user");
    assert.throws(() => fixture.service.decideRequest(input.requestId, 1, "approved", { type: "system", id: "forged" }), ResearchAuthorizationError);
    const decision = fixture.service.decideRequest(input.requestId, 1, "approved", user);
    assert.equal(decision.head.state, "approved");
    const grant = fixture.service.issueGrant(input.requestId, grantInput(input), user);
    assert.equal(grant.status, "active");
    assert.deepEqual(grant.grant.limits, RESEARCH_LIMITS.defaults);
    assert.throws(() => fixture.service.issueGrant(input.requestId, grantInput(input, { approvedBy: { type: "user", id: "other" } }), user), ResearchAuthorizationError);
  } finally { await fixture.setup.fixture.close(); }
});

test("request revisions are immutable, stale writers fail, and pending revisions return to draft", async () => {
  const fixture = await setupService();
  try {
    const input = requestInput(fixture.setup, fixture.bound);
    fixture.service.createRequest(input, model);
    fixture.service.submitRequest(input.requestId, 0, model);
    const revised = requestInput(fixture.setup, fixture.bound, { requestId: input.requestId, revisionId: randomUUID(),
      questions: ["Which official term is current?"], localEvidenceDigest: sha("revised") });
    const result = fixture.service.reviseRequest(input.requestId, 1, revised, model);
    assert.equal(result.head.state, "draft");
    assert.equal(result.head.revision, 2);
    assert.throws(() => fixture.service.reviseRequest(input.requestId, 1, { ...revised, revisionId: randomUUID() }, model), ResearchConflictError);
    assert.throws(() => fixture.setup.fixture.database.prepare("UPDATE research_request_revisions SET actor_id = 'tampered' WHERE workspace_id = ?").run(fixture.setup.fixture.workspaceId), /immutable/);
  } finally { await fixture.setup.fixture.close(); }
});

test("rejected and canceled requests cannot issue grants; revocation and expiry are derived grant validity", async () => {
  for (const decision of ["rejected", "canceled"]) {
    const fixture = await setupService();
    try {
      const input = requestInput(fixture.setup, fixture.bound);
      fixture.service.createRequest(input, model);
      fixture.service.submitRequest(input.requestId, 0, model);
      fixture.service.decideRequest(input.requestId, 1, decision, user);
      assert.throws(() => fixture.service.issueGrant(input.requestId, grantInput(input), user), ResearchConflictError);
    } finally { await fixture.setup.fixture.close(); }
  }
  const fixture = await setupService();
  try {
    const input = requestInput(fixture.setup, fixture.bound);
    fixture.service.createRequest(input, model);
    fixture.service.submitRequest(input.requestId, 0, model);
    fixture.service.decideRequest(input.requestId, 1, "approved", user);
    const issued = fixture.service.issueGrant(input.requestId, grantInput(input), user);
    assert.equal(fixture.service.revokeGrant(issued.grant.grantId, "user changed scope", user).status, "revoked");
    assert.throws(() => fixture.service.revokeGrant(issued.grant.grantId, "again", user), ResearchConflictError);
  } finally { await fixture.setup.fixture.close(); }
  const expiring = await setupService();
  try {
    const input = requestInput(expiring.setup, expiring.bound);
    expiring.service.createRequest(input, model);
    expiring.service.submitRequest(input.requestId, 0, model);
    expiring.service.decideRequest(input.requestId, 1, "approved", user);
    const issued = expiring.service.issueGrant(input.requestId, grantInput(input), user);
    expiring.advance(1_800_001);
    assert.equal(expiring.service.getGrant(issued.grant.grantId).status, "expired");
  } finally { await expiring.setup.fixture.close(); }
});

test("service and database workspace boundaries reject two hundred forged relationships each", async () => {
  const fixture = await setupService();
  try {
    const input = requestInput(fixture.setup, fixture.bound);
    fixture.service.createRequest(input, model);
    const wrongWorkspace = randomUUID();
    const wrongService = new ResearchFoundationService(fixture.setup.fixture.database, wrongWorkspace);
    for (let index = 0; index < 200; index += 1) {
      assert.throws(() => wrongService.getRequest(input.requestId), ResearchConflictError);
      assert.throws(() => fixture.setup.fixture.database.prepare("INSERT INTO research_request_segments VALUES (?, ?, ?, ?)")
        .run(wrongWorkspace, input.requestId, fixture.setup.workflow.sourceRevisionId, fixture.setup.workflow.segmentId), /FOREIGN KEY/);
    }
  } finally { await fixture.setup.fixture.close(); }
});
