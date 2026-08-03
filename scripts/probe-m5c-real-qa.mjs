import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { invokeM5CModelBroker } from "../src/m5c/model-broker-process.mjs";

if (process.env.M5C_REAL_EVALUATION !== "qa-probe") throw new Error("M5C real QA probe requires M5C_REAL_EVALUATION=qa-probe");
let credential;
try {
  credential = await openCredentialFile("/run/secrets/deepseek");
  const response = await invokeM5CModelBroker({ credentialFd: credential.fd, request: { role: "qa", modelId: "deepseek-v4-flash", maxOutputTokens: 2_048,
    request: { schemaVersion: "m5c-model-qa-request-v1", workflowId: "10000000-0000-4000-8000-000000000001",
      sourceRevisionId: "10000000-0000-4000-8000-000000000002", targetLanguage: "zh-CN", workingCopyDigest: `sha256:${"0".repeat(64)}`,
      scope: "full", segments: [{ segmentId: "10000000-0000-4000-8000-000000000003", sourceText: "The service does not delete cached files.",
        targetText: "该服务会删除缓存文件。", targetDigest: `sha256:${"1".repeat(64)}` }] } } }, { timeoutMs: 60_000 });
  process.stdout.write(`${JSON.stringify({ status: "completed", findings: response.findings.length, usage: response.usage })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: "failed", category: error?.category ?? "probe",
    providerCode: typeof error?.providerCode === "string" ? error.providerCode : null })}\n`); process.exitCode = 1;
} finally { await credential?.close(); }
