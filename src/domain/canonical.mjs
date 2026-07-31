import { createHash, randomUUID } from "node:crypto";
import { stableJson } from "./contracts.mjs";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORBIDDEN_KEYS = new Set([
  "secret", "secrets", "apikey", "token", "accesstoken", "oauthtoken", "cookie", "ledger",
  "providerpayload", "providerrequest", "providerresponse", "rawrequest", "rawresponse",
]);

function invalid(message = "invalid canonical package") {
  const error = new TypeError(message);
  error.code = "INVALID_CANONICAL_PACKAGE";
  throw error;
}

function copySafe(value) {
  if (Array.isArray(value)) return value.map(copySafe);
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!FORBIDDEN_KEYS.has(normalizedKey)) output[key] = copySafe(child);
    }
    return output;
  }
  return value;
}

function digestPayload(value) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function digestText(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function withoutDigest(value, { sanitize = true } = {}) {
  const copy = sanitize ? copySafe(value) : JSON.parse(JSON.stringify(value));
  copy.integrity = { algorithm: "sha256", normalization: "canonical-json-v1" };
  return copy;
}

export function validateCanonicalPackage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  if (typeof value.schema_version !== "string" || !/^1\.[0-9]+$/.test(value.schema_version)) invalid("unsupported canonical major version");
  if (!["source_document", "translation_bundle"].includes(value.package_type)) invalid();
  if (!UUID.test(value.package_id ?? "")) invalid("invalid package id");
  if (typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))) invalid("invalid creation time");
  if (!value.origin || !SHA256.test(value.origin.source_digest ?? "")) invalid("invalid source digest");
  if (!value.document || typeof value.document.title !== "string" || value.document.title.length === 0) invalid();
  if (typeof value.document.source_language !== "string" || value.document.source_language.length === 0) invalid("invalid source language");
  if (!value.document.metadata || typeof value.document.metadata !== "object" || Array.isArray(value.document.metadata)) invalid("invalid document metadata");
  if (!Array.isArray(value.document.segments) || value.document.segments.length === 0) invalid("segments are required");
  const references = new Set();
  const orders = new Set();
  for (const segment of value.document.segments) {
    if (!segment || typeof segment.segment_ref !== "string" || segment.segment_ref.length === 0) invalid("invalid segment reference");
    if (references.has(segment.segment_ref)) invalid("duplicate segment reference");
    if (!Number.isInteger(segment.order) || segment.order < 0 || orders.has(segment.order)) invalid("invalid segment order");
    if (typeof segment.kind !== "string" || typeof segment.source !== "string" || !Array.isArray(segment.protected)) invalid("invalid segment");
    if (value.package_type === "translation_bundle") {
      if (!segment.target || typeof segment.target.language !== "string" || typeof segment.target.text !== "string" || typeof segment.target.review_status !== "string") invalid("translation target is required");
    }
    references.add(segment.segment_ref);
    orders.add(segment.order);
  }
  return value;
}

export function encodeCanonicalPackage(input) {
  const clean = copySafe(input);
  delete clean.integrity;
  validateCanonicalPackage(clean);
  const unsigned = withoutDigest(clean);
  return stableJson({ ...unsigned, integrity: { ...unsigned.integrity, package_digest: digestPayload(unsigned) } });
}

export function decodeCanonicalPackage(encoded) {
  let parsed;
  try { parsed = JSON.parse(encoded); } catch { invalid(); }
  validateCanonicalPackage(parsed);
  if (parsed.integrity?.algorithm !== "sha256" || parsed.integrity?.normalization !== "canonical-json-v1" || !SHA256.test(parsed.integrity?.package_digest ?? "")) invalid("invalid package integrity");
  const expected = digestPayload(withoutDigest(parsed, { sanitize: false }));
  if (parsed.integrity.package_digest !== expected) invalid("canonical package digest mismatch");
  return copySafe(parsed);
}

export function importCanonicalPackage(database, trustedWorkspaceId, encoded, { id = () => randomUUID(), now = () => new Date() } = {}) {
  const packageValue = decodeCanonicalPackage(encoded);
  const documentId = id();
  const sourceRevisionId = id();
  const timestamp = now().toISOString();
  const segmentIds = [];
  database.transaction(() => {
    database.prepare("INSERT INTO documents VALUES (?, ?, ?, ?)").run(trustedWorkspaceId, documentId, packageValue.document.title, timestamp);
    database.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?)")
      .run(trustedWorkspaceId, sourceRevisionId, documentId, packageValue.origin.source_digest, packageValue.origin.source_digest, timestamp);
    for (const segment of packageValue.document.segments) {
      const segmentId = id();
      segmentIds.push(segmentId);
      database.prepare("INSERT INTO segments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(trustedWorkspaceId, segmentId, sourceRevisionId, segment.kind, `/${segment.order}`, segment.source, digestText(segment.source), segment.order, 1, stableJson(segment.protected));
      database.prepare("INSERT INTO canonical_import_origins VALUES (?, ?, ?, ?, ?, ?)")
        .run(trustedWorkspaceId, segmentId, documentId, sourceRevisionId, packageValue.package_id, segment.segment_ref);
    }
  })();
  return Object.freeze({ documentId, sourceRevisionId, segmentIds: Object.freeze(segmentIds), originPackageId: packageValue.package_id });
}
