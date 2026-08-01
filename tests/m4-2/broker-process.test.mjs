import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { invokeBrokerProcess, BrokerProcessError } from "../../src/provider/broker-process.mjs";
import { invokeBrokerWithCredentialFile, openCredentialFile } from "../../src/provider/credential-file.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
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
