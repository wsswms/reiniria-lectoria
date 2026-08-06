import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, open, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { invokeBrokerProcess, BrokerProcessError } from "../../src/provider/broker-process.mjs";
import { invokeBrokerWithCredentialFile, openCredentialFile } from "../../src/provider/credential-file.mjs";
import { auditWriterForDescriptor } from "../../src/provider/llm-call-audit.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const hangingBroker = new URL("./broker-hang-fixture.mjs", import.meta.url);
function request(providerId = "fake-primary") {
  return {
    workspaceId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), workflowId: randomUUID(), sourceRevisionId: randomUUID(),
    targetLanguage: "zh-CN", providerId, modelId: "fixture-model-v1", promptVersion: "prompt-v1", contextDigest: sha("context"),
    segments: [{ segmentId: randomUUID(), sourceDigest: sha("source"), sourceText: "Hello", protected: [] }],
  };
}

test("independent Broker receives credentials through a dedicated descriptor and returns only normalized data", async () => {
  const canary = `M4-BROKER-SECRET-${randomUUID()}`;
  for (let index = 0; index < 20; index += 1) {
    const response = await invokeBrokerProcess({ request: request(), credentialRef: "test:fake-primary", credential: canary });
    assert.equal(response.providerId, "fake-primary");
    assert.equal(JSON.stringify(response).includes(canary), false);
  }
});

test("Broker fixed allowlist and fault normalization fail closed without secret leakage", async () => {
  const canary = `M4-BROKER-SECRET-${randomUUID()}`;
  await assert.rejects(invokeBrokerProcess({ request: request("not-allowed"), credentialRef: "test:no", credential: canary }), (error) => error instanceof BrokerProcessError && error.category === "policy" && !error.message.includes(canary));
  await assert.rejects(invokeBrokerProcess({ request: request("fake-fault"), credentialRef: "test:fault", credential: canary, faultMode: "auth" }), (error) => error instanceof BrokerProcessError && error.category === "auth" && !error.message.includes(canary));
  await assert.rejects(invokeBrokerProcess({ request: request("fake-fault"), credentialRef: "test:fault", credential: canary, faultMode: "rate-limit" }), (error) => error instanceof BrokerProcessError && error.category === "rate-limit" && error.retryable === true && !error.message.includes(canary));
});

test("Broker receives a credential through a secure file descriptor without loading it into argv or environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-broker-credential-"));
  const secret = `M4-FD-SECRET-${randomUUID()}`;
  const path = join(root, "gemini.key");
  try {
    await writeFile(path, `${secret}\n`, { mode: 0o600 });
    const response = await invokeBrokerWithCredentialFile({
      request: request(), credentialRef: "file:provider/fake-primary", credentialPath: path,
    });
    assert.equal(response.providerId, "fake-primary");
    assert.equal(JSON.stringify(response).includes(secret), false);
    assert.equal(process.argv.join(" ").includes(secret), false);
    assert.equal(JSON.stringify(process.env).includes(secret), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Broker can reuse one unlinked credential descriptor without advancing its shared offset", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-broker-unlinked-"));
  const path = join(root, "provider.key");
  let handle;
  try {
    await writeFile(path, "fixture-only-credential\n", { mode: 0o600 });
    handle = await openCredentialFile(path);
    await unlink(path);
    for (let index = 0; index < 20; index += 1) {
      const response = await invokeBrokerProcess({
        request: request(), credentialRef: "file:provider/fake-primary", credentialFd: handle.fd,
      });
      assert.equal(response.providerId, "fake-primary");
    }
  } finally {
    await handle?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("credential files reject relative paths, symlinks, broad permissions and empty values", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-broker-invalid-"));
  const path = join(root, "credential.key");
  const link = join(root, "credential-link.key");
  try {
    await writeFile(path, "fixture", { mode: 0o600 });
    await symlink(path, link);
    await assert.rejects(openCredentialFile("relative.key"), /absolute/);
    await assert.rejects(openCredentialFile(link), /safely/);
    await chmod(path, 0o644);
    await assert.rejects(openCredentialFile(path), /permissions/);
    await writeFile(path, "", { mode: 0o600 });
    await chmod(path, 0o600);
    await assert.rejects(openCredentialFile(path), /invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("killing an unresponsive Broker after request handoff is a non-retryable unknown outcome", async () => {
  await assert.rejects(invokeBrokerProcess({
    request: request(), credentialRef: "test:fake-primary", credential: "fixture",
  }, { entry: hangingBroker, timeoutMs: 25 }), (error) => error instanceof BrokerProcessError
    && error.category === "unknown-outcome" && error.retryable === false);
});

test("LLM audit descriptors require a current-user private regular file and append crash-safe JSONL events", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-llm-audit-fd-")); const path = join(root, "call.json"); let handle;
  try {
    handle = await open(path, "wx", 0o600); const writer = auditWriterForDescriptor(handle.fd); writer({ event: "request", request: "full" }); writer({ event: "response", response: "full" });
    assert.deepEqual((await readFile(path, "utf8")).trim().split("\n").map(JSON.parse),
      [{ event: "request", request: "full" }, { event: "response", response: "full" }]); await handle.close(); handle = undefined;
    await chmod(path, 0o644); handle = await open(path, "r+"); assert.throws(() => auditWriterForDescriptor(handle.fd), /0600/);
  } finally { await handle?.close(); await rm(root, { recursive: true, force: true }); }
});

test("translation Broker passes private audit fd 4 and records pre-network auth failures without credential leakage", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-translation-broker-audit-")); const auditPath = join(root, "call.jsonl"); let auditHandle;
  try {
    auditHandle = await open(auditPath, "wx", 0o600); const secret = "invalid translation credential";
    await assert.rejects(invokeBrokerProcess({ request: request("deepseek"), credentialRef: "test:deepseek", credential: secret,
      auditFd: auditHandle.fd, evaluationScope: "m5c-real-article-audit-v1" }),
    (error) => error instanceof BrokerProcessError && error.category === "auth"); await auditHandle.close(); auditHandle = undefined;
    const text = await readFile(auditPath, "utf8"); const events = text.trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.map((event) => event.event), ["request", "response"]); assert.equal(text.includes(secret), false);
    assert.equal(text.includes("authorization"), false); assert.equal(events[1].outcome.error.category, "auth");
  } finally { await auditHandle?.close(); await rm(root, { recursive: true, force: true }); }
});
