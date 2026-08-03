import { fstatSync, readSync } from "node:fs";
import { createCredentialResolver, createProviderBroker } from "./broker-contract.mjs";
import { createProviderRegistry } from "./provider-registry.mjs";
import { auditWriterForDescriptor, REAL_ARTICLE_EVALUATION_SCOPE } from "./llm-call-audit.mjs";

async function readStream(stream, maximum) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximum) throw new Error("broker input limit exceeded");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readDescriptorAtStart(fd, maximum) {
  const buffer = Buffer.alloc(maximum + 1);
  const positional = fstatSync(fd).isFile();
  let size = 0;
  while (size < buffer.length) {
    const bytes = readSync(fd, buffer, size, buffer.length - size, positional ? size : null);
    if (bytes === 0) break;
    size += bytes;
  }
  if (size > maximum) throw new Error("broker input limit exceeded");
  return buffer.subarray(0, size).toString("utf8");
}

try {
  const envelope = JSON.parse(await readStream(process.stdin, 4 * 1024 * 1024));
  if (envelope.auditEnabled !== true && envelope.auditEnabled !== false) throw Object.assign(new Error(), { category: "policy" });
  if (envelope.evaluationScope !== undefined && envelope.evaluationScope !== REAL_ARTICLE_EVALUATION_SCOPE) throw Object.assign(new Error(), { category: "policy" });
  const audit = envelope.auditEnabled ? auditWriterForDescriptor(4) : undefined;
  const resolver = createCredentialResolver(async () => readDescriptorAtStart(3, 16 * 1024).trim());
  const broker = createProviderBroker({
    adapters: createProviderRegistry({ faultMode: envelope.faultMode ?? "transport", audit, evaluationScope: envelope.evaluationScope }),
    credentialResolver: resolver,
  });
  const response = await broker.invoke({ request: envelope.request, credentialRef: envelope.credentialRef });
  process.stdout.write(`${JSON.stringify({ ok: true, response })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: {
      category: typeof error?.category === "string" ? error.category : "provider",
      message: "provider broker invocation failed",
      retryable: error?.retryable === true,
      ...(error?.providerCode === undefined ? {} : { providerCode: String(error.providerCode) }),
    },
  })}\n`);
  process.exitCode = 1;
}
