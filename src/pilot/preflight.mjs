import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { openCredentialFile } from "../provider/credential-file.mjs";
import { realArticlePilotConfigContract } from "./contracts.mjs";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_ARTICLE_BYTES = 1024 * 1024;
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function secureRegularFile(path, maximum, label) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > maximum || (info.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error(`${label} is not a private regular file`);
    return { bytes: await handle.readFile(), info };
  } finally { await handle.close(); }
}

export async function loadRealArticlePilotConfig(configPath, { allowLive = false } = {}) {
  if (typeof configPath !== "string" || resolve(configPath) !== configPath) throw new Error("config path must be absolute");
  const { bytes } = await secureRegularFile(configPath, MAX_CONFIG_BYTES, "config");
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("config JSON is invalid"); }
  return realArticlePilotConfigContract(parsed, { allowLive });
}

export async function preflightRealArticlePilot(configInput, { allowLive = false } = {}) {
  const config = realArticlePilotConfigContract(configInput, { allowLive });
  const { bytes: articleBytes } = await secureRegularFile(config.article.path, MAX_ARTICLE_BYTES, "article");
  if (sha(articleBytes) !== config.article.digest) throw new Error("article digest mismatch");
  for (const path of [config.deepseek.credentialPath, config.brave.credentialPath]) {
    const credential = await openCredentialFile(path); await credential.close();
  }
  await mkdir(config.output.directory, { recursive: true, mode: 0o700 });
  const output = await stat(config.output.directory);
  if (!output.isDirectory() || (output.mode & 0o077) !== 0 || (typeof process.getuid === "function" && output.uid !== process.getuid())) {
    throw new Error("output directory is not private");
  }
  const paragraphs = articleBytes.toString("utf8").split(/\n\s*\n/u).map((item) => item.trim()).filter(Boolean);
  if (paragraphs.length < 1 || paragraphs.length > config.deepseek.translation.maxCalls) throw new Error("article segment count exceeds the translation boundary");
  return Object.freeze({ config, articleText: articleBytes.toString("utf8"), articleBytes,
    plan: Object.freeze({ mode: config.mode, articleDigest: config.article.digest, segments: paragraphs.length,
      translationMaxCalls: config.deepseek.translation.maxCalls, researchMaxCalls: config.deepseek.research.maxCalls,
      braveMaxCalls: config.brave.maxCalls, fetchMaxUrls: config.fetch.maxUrls, totalHardLimitMicros: config.totalHardLimitMicros }) });
}
