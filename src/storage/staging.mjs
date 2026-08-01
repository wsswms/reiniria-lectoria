import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensureWorkspaceDirectory, resolveWorkspaceFile, validateRelativeWorkspacePath } from "../workspace/path-guard.mjs";

async function readRegularFileNoFollow(root, relativeName) {
  const filename = await resolveWorkspaceFile(root, relativeName);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new TypeError("staged artifact must be a regular file");
    return await handle.readFile();
  } finally { await handle.close(); }
}

export async function readStagedFile(root, relativeName) {
  const parts = validateRelativeWorkspacePath(relativeName);
  if (parts[0] !== "staging" || parts.length < 3) throw new TypeError("staged artifact path is invalid");
  return readRegularFileNoFollow(root, parts.join("/"));
}

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
    const targetInfo = await lstat(target).catch(() => null);
    if (!targetInfo?.isDirectory() || targetInfo.isSymbolicLink()) throw error;
    const expectedNames = Object.keys(files).sort();
    const existingNames = (await readdir(target)).sort();
    if (JSON.stringify(existingNames) !== JSON.stringify(expectedNames)) throw error;
    for (const [name, content] of Object.entries(files)) {
      const existing = await readRegularFileNoFollow(root, ["staging", ...parts, name].join("/")).catch(() => null);
      if (!existing || !Buffer.from(existing).equals(Buffer.from(content))) throw error;
    }
    return target;
  }
}
