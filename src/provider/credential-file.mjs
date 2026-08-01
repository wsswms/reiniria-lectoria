import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { invokeBrokerProcess } from "./broker-process.mjs";

const MAX_CREDENTIAL_BYTES = 16 * 1024;

export async function openCredentialFile(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new TypeError("credential path must be absolute");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_CREDENTIAL_BYTES) throw new Error("credential file is invalid");
    if ((stat.mode & 0o077) !== 0) throw new Error("credential file permissions must be 0600 or stricter");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("credential file owner mismatch");
    return handle;
  } catch (error) {
    await handle?.close();
    if (error?.message?.startsWith("credential file")) throw error;
    throw new Error("credential file cannot be opened safely");
  }
}

export async function invokeBrokerWithCredentialFile({ credentialPath, ...input }, options) {
  const handle = await openCredentialFile(credentialPath);
  try {
    return await invokeBrokerProcess({ ...input, credentialFd: handle.fd }, options);
  } finally {
    await handle.close();
  }
}
