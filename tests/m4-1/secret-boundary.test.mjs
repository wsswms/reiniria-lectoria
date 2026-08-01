import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeCanonicalPackage } from "../../src/domain/canonical.mjs";
import { openWorkspaceDatabase } from "../../src/db/connection.mjs";
import { PrivateLedger } from "../../src/storage/ledger.mjs";
import { createCredentialResolver, createProviderBroker } from "../../src/provider/broker-contract.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function requestFixture(canary) {
  return {
    workspaceId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), workflowId: randomUUID(), sourceRevisionId: randomUUID(),
    targetLanguage: "ja", providerId: "fake-primary", modelId: "fixture-model-v1", promptVersion: "prompt-v1", contextDigest: sha("context"),
    segments: [{ segmentId: randomUUID(), sourceDigest: sha("source"), sourceText: "public fixture", protected: [] }],
    apiKey: canary,
    prompt: { authorization: canary },
    toolArguments: { secret: canary },
    runnerEnvironment: { PROVIDER_TOKEN: canary },
  };
}

function canonicalFixture(canary) {
  return {
    schema_version: "1.0", package_type: "source_document", package_id: randomUUID(), created_at: new Date(0).toISOString(),
    origin: { source_digest: sha("source") },
    document: {
      title: "M4 public fixture", source_language: "en", metadata: {},
      segments: [{ segment_ref: "s1", order: 0, kind: "paragraph", source: "public fixture", protected: [] }],
    },
    secrets: { apiKey: canary },
    providerRequest: canary,
  };
}

test("credential canary is confined to resolver and provider adapter across the M4.1 matrix", async () => {
  const canary = `M4-SECRET-CANARY-${randomUUID()}`;
  const root = await mkdtemp(join(tmpdir(), "lectoria-m4-1-canary-"));
  await mkdir(join(root, "private/ledger"), { recursive: true });
  const workspaceId = randomUUID();
  const database = openWorkspaceDatabase(join(root, "app.sqlite3"), { workspaceId });
  const emitted = [];
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.stdout.write = function captureStdout(chunk, ...args) { emitted.push(String(chunk)); return originalStdout.call(this, chunk, ...args); };
  process.stderr.write = function captureStderr(chunk, ...args) { emitted.push(String(chunk)); return originalStderr.call(this, chunk, ...args); };
  try {
    let adapterSawCredential = false;
    let normalizedTaskPackage;
    const broker = createProviderBroker({
      adapters: new Map([["fake-primary", {
        async invoke(adapterRequest, context) {
          normalizedTaskPackage = adapterRequest;
          adapterSawCredential = context.credential === canary;
          throw new Error(`private upstream failure ${context.credential}`);
        },
      }]]),
      credentialResolver: createCredentialResolver(async () => canary),
    });
    const request = requestFixture(canary);
    let safeError;
    await assert.rejects(broker.invoke({ request, credentialRef: "test:fake-primary" }), (error) => {
      safeError = error;
      return !error.message.includes(canary) && !JSON.stringify(error).includes(canary);
    });
    assert.equal(adapterSawCredential, true);

    const ledger = new PrivateLedger(root, { now: () => new Date(0) });
    const ledgerRecord = await ledger.append({
      action: "provider-attempt", providerRequest: canary,
      error: { category: safeError.category, message: safeError.message },
    });
    const canonical = encodeCanonicalPackage(canonicalFixture(canary));
    database.prepare("INSERT INTO domain_audit_events(workspace_id,event_id,entity_type,entity_id,action,actor_type,actor_id,succeeded,details_json,occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(workspaceId, randomUUID(), "attempt", request.attemptId, "provider-failed", "system", "broker", 0, JSON.stringify({ category: safeError.category, message: safeError.message }), new Date(0).toISOString());

    const databaseText = database.prepare(`
      SELECT group_concat(value, '') AS value FROM (
        SELECT details_json AS value FROM domain_audit_events
        UNION ALL SELECT sql FROM sqlite_master WHERE sql IS NOT NULL
      )
    `).get().value;
    const channels = {
      sqliteAndAudit: databaseText,
      taskPackagePromptToolAndRunnerEnvironment: JSON.stringify(normalizedTaskPackage),
      stdoutAndStderr: emitted.join(""),
      exception: `${safeError.name}:${safeError.message}:${JSON.stringify(safeError)}`,
      ledger: `${JSON.stringify(ledgerRecord)}:${await ledger.readDay("1970-01-01")}`,
      canonicalExport: canonical,
      processEnvironment: JSON.stringify(process.env),
    };
    for (const [channel, content] of Object.entries(channels)) {
      assert.equal(content.includes(canary), false, `${channel} leaked the credential canary`);
    }
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
