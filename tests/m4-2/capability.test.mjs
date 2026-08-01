import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { CapabilityAuthority, CapabilityDeniedError } from "../../src/runner/capability.mjs";
import { createToolGateway } from "../../src/runner/tool-gateway.mjs";

function scope() {
  return { workspaceId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID() };
}

test("capabilities are signed, minimally scoped and bound to one task attempt", () => {
  const expected = scope();
  const signingKey = randomBytes(32);
  const authority = new CapabilityAuthority(signingKey, { now: () => 1_000 });
  const issued = authority.issue({ ...expected, scopes: ["segment:read"], expiresAt: 2_000 });
  assert.deepEqual(authority.verify(issued.token, { ...expected, scope: "segment:read" }), issued.claims);
  assert.deepEqual(Object.keys(authority), []);
  assert.equal(JSON.stringify(authority), "{}");
  assert.equal(JSON.stringify({ authority, issued }).includes(signingKey.toString("hex")), false);
  assert.equal(issued.tokenDigest.startsWith("sha256:"), true);
});

test("capability expansion and cross-scope attacks are rejected one hundred times each", () => {
  const expected = scope();
  const authority = new CapabilityAuthority(randomBytes(32), { now: () => 1_000 });
  const issued = authority.issue({ ...expected, scopes: ["segment:read"], expiresAt: 2_000 });
  const [payload, signature] = issued.token.split(".");
  for (let index = 0; index < 100; index += 1) {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    claims.scopes.push("candidate:submit");
    claims.grantId = randomUUID();
    const forged = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
    assert.throws(() => authority.verify(forged, { ...expected, scope: "candidate:submit" }), CapabilityDeniedError);
    assert.throws(() => authority.verify(issued.token, { ...expected, workspaceId: randomUUID() }), CapabilityDeniedError);
    assert.throws(() => authority.verify(issued.token, { ...expected, taskId: randomUUID() }), CapabilityDeniedError);
    assert.throws(() => authority.verify(issued.token, { ...expected, attemptId: randomUUID() }), CapabilityDeniedError);
  }
});

test("expired and revoked capability replays are rejected one hundred times each", () => {
  let now = 1_000;
  const expected = scope();
  const authority = new CapabilityAuthority(randomBytes(32), { now: () => now });
  const expired = Array.from({ length: 100 }, () => authority.issue({ ...expected, scopes: ["segment:read"], expiresAt: 2_000 }));
  now = 2_000;
  for (const issued of expired) assert.throws(() => authority.verify(issued.token, expected), CapabilityDeniedError);
  now = 1_000;
  for (let index = 0; index < 100; index += 1) {
    const issued = authority.issue({ ...expected, scopes: ["segment:read"], expiresAt: 2_000 });
    authority.revoke(issued.token);
    assert.throws(() => authority.verify(issued.token, expected), CapabilityDeniedError);
  }
});

test("tool gateway exposes only segment read and candidate submit with exact claims", async () => {
  const expected = scope();
  const segmentId = randomUUID();
  const authority = new CapabilityAuthority(randomBytes(32), { now: () => 1_000 });
  const issued = authority.issue({ ...expected, scopes: ["segment:read", "candidate:submit"], expiresAt: 2_000 });
  const calls = [];
  const gateway = createToolGateway({
    authority,
    async readSegment(input) { calls.push(input); return { sourceText: "public", sourceDigest: `sha256:${"0".repeat(64)}`, protected: [] }; },
    async submitCandidate(input) { calls.push(input); return { accepted: true }; },
  });
  const base = { token: issued.token, args: { ...expected, segmentId } };
  const source = await gateway.invoke({ ...base, tool: "segment.read" });
  const receipt = await gateway.invoke({ ...base, tool: "candidate.submit", args: { ...base.args, text: "target", outputDigest: `sha256:${"1".repeat(64)}` } });
  assert.equal(source.sourceText, "public");
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.receiptDigest.startsWith("sha256:"), true);
  assert.equal(calls.length, 2);

  for (const tool of ["shell", "file.read", "network.fetch", "workspace.read", "docker.exec"]) {
    for (let index = 0; index < 200; index += 1) {
      await assert.rejects(gateway.invoke({ ...base, tool }), CapabilityDeniedError);
    }
  }
});
