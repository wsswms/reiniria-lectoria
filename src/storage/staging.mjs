import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
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

export async function stageAtomicDirectory(root, relativeDirectory, files, { inject = () => {} } = {}) {
  const parts = validateRelativeWorkspacePath(relativeDirectory);
  const parent = await ensureWorkspaceDirectory(root, ["staging", ...parts.slice(0, -1)].join("/"));
  const target = join(parent, parts.at(-1));
  const temporary = join(parent, `.tmp-${randomUUID()}`);
  await mkdir(temporary);
  try {
    inject("after-temp-directory");
    for (const [name, content] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
      const nameParts = validateRelativeWorkspacePath(name);
      if (nameParts.length !== 1) throw new TypeError("staged filenames must be direct children");
      const handle = await open(join(temporary, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      inject(`after-file-${name}`);
    }
    inject("before-directory-rename");
    await rename(temporary, target);
    inject("after-directory-rename");
    return target;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
    for (const [name, content] of Object.entries(files)) {
      const existing = await readFile(join(target, name)).catch(() => null);
      if (!existing || !Buffer.from(existing).equals(Buffer.from(content))) throw error;
    }
    return target;
  }
}
