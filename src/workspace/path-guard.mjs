import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { InvalidWorkspacePathError, ResourceNotFoundError } from "./errors.mjs";

function reject() {
  throw new InvalidWorkspacePathError();
}

function decodeRepeated(value) {
  let decoded = value;
  for (let count = 0; count < 3; count += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      reject();
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  return decoded;
}

export function validateRelativeWorkspacePath(input) {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) reject();
  const decoded = decodeRepeated(input);
  if (decoded !== input || isAbsolute(decoded) || /^[a-zA-Z]:/.test(decoded) || decoded.includes("\\")) reject();
  const parts = decoded.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) reject();
  return parts;
}

function assertContained(root, candidate) {
  const relation = relative(root, candidate);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) reject();
}

async function assertNoLinks(root, parts, { allowMissingLeaf = false } = {}) {
  const canonicalRoot = await realpath(root);
  let cursor = canonicalRoot;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = resolve(cursor, parts[index]);
    assertContained(canonicalRoot, cursor);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) reject();
      if (index < parts.length - 1 && !info.isDirectory()) reject();
    } catch (error) {
      if (error instanceof InvalidWorkspacePathError) throw error;
      if (error?.code === "ENOENT" && allowMissingLeaf && index === parts.length - 1) return cursor;
      if (error?.code === "ENOENT") throw new ResourceNotFoundError();
      throw error;
    }
  }
  return cursor;
}

export async function resolveWorkspaceFile(root, input, { mustExist = true } = {}) {
  const parts = validateRelativeWorkspacePath(input);
  const candidate = await assertNoLinks(root, parts, { allowMissingLeaf: !mustExist });
  if (mustExist) {
    const info = await lstat(candidate);
    if (!info.isFile()) reject();
  }
  return candidate;
}

export async function writeWorkspaceFile(root, input, content) {
  const parts = validateRelativeWorkspacePath(input);
  if (parts.length < 2) reject();
  const parentParts = parts.slice(0, -1);
  const canonicalRoot = await realpath(root);
  let cursor = canonicalRoot;
  for (const part of parentParts) {
    cursor = resolve(cursor, part);
    assertContained(canonicalRoot, cursor);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) reject();
    } catch (error) {
      if (error instanceof InvalidWorkspacePathError) throw error;
      if (error?.code !== "ENOENT") throw error;
      await mkdir(cursor);
    }
  }
  const filename = await assertNoLinks(root, parts, { allowMissingLeaf: true });
  let handle;
  try {
    handle = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") reject();
    throw error;
  } finally {
    await handle?.close();
  }
  return filename;
}
