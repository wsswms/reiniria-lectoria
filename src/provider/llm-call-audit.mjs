import { fstatSync, writeSync } from "node:fs";

export const REAL_ARTICLE_EVALUATION_SCOPE = "m5c-real-article-audit-v1";
export const REAL_ARTICLE_MAX_OUTPUT_TOKENS = 384_000;
export const REAL_ARTICLE_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export function evaluationResponseBytes(scope, fallback) {
  return scope === REAL_ARTICLE_EVALUATION_SCOPE ? REAL_ARTICLE_MAX_RESPONSE_BYTES : fallback;
}

export function evaluationOutputTokens(scope, fallback) {
  return scope === REAL_ARTICLE_EVALUATION_SCOPE ? REAL_ARTICLE_MAX_OUTPUT_TOKENS : fallback;
}

export function responseHeaders(headers) {
  const output = {};
  for (const name of ["content-type", "content-length", "x-request-id", "x-ratelimit-limit", "x-ratelimit-remaining"]) {
    const value = headers?.get?.(name);
    if (typeof value === "string" && value.length > 0 && value.length <= 1024) output[name] = value;
  }
  return Object.freeze(output);
}

export function auditWriterForDescriptor(fd) {
  if (!Number.isSafeInteger(fd) || fd < 0) throw new TypeError("audit descriptor is invalid");
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new TypeError("audit descriptor must be a current-user 0600 regular file");
  return (record) => {
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  };
}

export function auditError(error) {
  return Object.freeze({
    category: typeof error?.category === "string" ? error.category : "provider",
    retryable: error?.retryable === true,
    ...(error?.providerCode === undefined ? {} : { providerCode: String(error.providerCode).slice(0, 128) }),
  });
}
