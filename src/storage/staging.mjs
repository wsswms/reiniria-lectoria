import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensureWorkspaceDirectory, validateRelativeWorkspacePath } from "../workspace/path-guard.mjs";

export async function stageAtomicOutput(root, relativeName, content, { inject = () => {} } = {}) {
  const parts = validateRelativeWorkspacePath(relativeName);
  const directory = await ensureWorkspaceDirectory(root, ["staging", ...parts.slice(0, -1)].join("/"));
  const target = join(directory, parts.at(-1));
  const temporary = join(directory, `.tmp-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    inject("after-temp");
    await rename(temporary, target);
    return target;
  } catch (error) {
    await handle?.close();
    await rm(temporary, { force: true });
    throw error;
  }
}
