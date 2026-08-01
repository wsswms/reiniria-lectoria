import { openCredentialFile } from "../provider/credential-file.mjs";
import { invokeSearchBroker } from "./broker-process.mjs";

export async function searchWithCredentialFile({ credentialPath, ...input }, options) {
  const handle = await openCredentialFile(credentialPath);
  try { return await invokeSearchBroker({ ...input, credentialFd: handle.fd }, options); }
  finally { await handle.close(); }
}
