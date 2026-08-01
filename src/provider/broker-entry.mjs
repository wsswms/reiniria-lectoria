import { createReadStream } from "node:fs";
import { createCredentialResolver, createProviderBroker } from "./broker-contract.mjs";
import { DeterministicFakeProvider, FaultInjectingFakeProvider } from "./fake-provider.mjs";

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

try {
  const envelope = JSON.parse(await readStream(process.stdin, 4 * 1024 * 1024));
  const resolver = createCredentialResolver(async () => readStream(createReadStream(null, { fd: 3 }), 16 * 1024));
  const broker = createProviderBroker({
    adapters: new Map([
      ["fake-primary", new DeterministicFakeProvider({ id: "fake-primary" })],
      ["fake-fault", new FaultInjectingFakeProvider({ id: "fake-fault", mode: envelope.faultMode ?? "transport" })],
    ]),
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
    },
  })}\n`);
  process.exitCode = 1;
}
