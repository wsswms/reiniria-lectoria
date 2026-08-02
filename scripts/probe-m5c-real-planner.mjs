import { openCredentialFile } from "../src/provider/credential-file.mjs";
import { invokeM5CModelBroker } from "../src/m5c/model-broker-process.mjs";

if (process.env.M5C_REAL_EVALUATION !== "planner-probe") throw new Error("M5C real Planner probe requires M5C_REAL_EVALUATION=planner-probe");
let credential;
try {
  credential = await openCredentialFile("/run/secrets/deepseek"); const segmentId = "10000000-0000-4000-8000-000000000003";
  const response = await invokeM5CModelBroker({ credentialFd: credential.fd, request: { role: "planner", modelId: "deepseek-v4-flash", maxOutputTokens: 2_048,
    request: { schemaVersion: "m5c-planner-request-v1", workflowId: "10000000-0000-4000-8000-000000000001",
      documentId: "10000000-0000-4000-8000-000000000002", sourceRevisionId: "10000000-0000-4000-8000-000000000004", targetLanguage: "zh-CN",
      localPlanDigest: `sha256:${"0".repeat(64)}`, localItems: [{ itemId: "10000000-0000-4000-8000-000000000005", kind: "measurement",
        coverage: "uncovered", instructionType: "preferred", impact: "high", segmentIds: [segmentId], dependencies: {}, content: { token: "3枚" } }] } } },
  { timeoutMs: 60_000 });
  process.stdout.write(`${JSON.stringify({ status: "completed", items: response.items.length, usage: response.usage })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: "failed", category: error?.category ?? "probe",
    providerCode: typeof error?.providerCode === "string" ? error.providerCode : null })}\n`); process.exitCode = 1;
} finally { await credential?.close(); }
