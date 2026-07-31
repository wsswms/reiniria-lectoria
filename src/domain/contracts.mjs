const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

export function opaqueId(value, name = "id") {
  if (!UUID.test(value)) throw new TypeError(`${name} must be a lowercase UUID`);
  return value;
}

export function digest(value, name = "digest") {
  if (!SHA256.test(value)) throw new TypeError(`${name} must be a sha256 digest`);
  return value;
}

export function workspaceContract(input) {
  return Object.freeze({
    workspaceId: opaqueId(input.workspaceId, "workspaceId"),
    displayName: requiredString(input.displayName, "displayName"),
    schemaVersion: Number.isInteger(input.schemaVersion) && input.schemaVersion > 0
      ? input.schemaVersion
      : (() => { throw new TypeError("schemaVersion must be a positive integer"); })(),
  });
}

export function documentContract(input) {
  return Object.freeze({
    workspaceId: opaqueId(input.workspaceId, "workspaceId"),
    documentId: opaqueId(input.documentId, "documentId"),
    title: requiredString(input.title, "title"),
  });
}

export function sourceRevisionContract(input) {
  return Object.freeze({
    workspaceId: opaqueId(input.workspaceId, "workspaceId"),
    documentId: opaqueId(input.documentId, "documentId"),
    sourceRevisionId: opaqueId(input.sourceRevisionId, "sourceRevisionId"),
    originalDigest: digest(input.originalDigest, "originalDigest"),
    normalizedDigest: digest(input.normalizedDigest, "normalizedDigest"),
  });
}

export function segmentContract(input) {
  if (!Number.isInteger(input.ordinal) || input.ordinal < 0) throw new TypeError("ordinal must be a non-negative integer");
  if (typeof input.translatable !== "boolean") throw new TypeError("translatable must be boolean");
  if (!Array.isArray(input.protected)) throw new TypeError("protected must be an array");
  return Object.freeze({
    workspaceId: opaqueId(input.workspaceId, "workspaceId"),
    sourceRevisionId: opaqueId(input.sourceRevisionId, "sourceRevisionId"),
    segmentId: opaqueId(input.segmentId, "segmentId"),
    kind: requiredString(input.kind, "kind"),
    structuralPath: requiredString(input.structuralPath, "structuralPath"),
    sourceText: requiredString(input.sourceText, "sourceText"),
    sourceDigest: digest(input.sourceDigest, "sourceDigest"),
    ordinal: input.ordinal,
    translatable: input.translatable,
    protected: Object.freeze(input.protected.map((item) => Object.freeze({ ...item }))),
  });
}

export function documentSegmentContract(input) {
  return Object.freeze({
    workspaceId: opaqueId(input.workspaceId, "workspaceId"),
    documentId: opaqueId(input.documentId, "documentId"),
    segmentId: opaqueId(input.segmentId, "segmentId"),
  });
}

const ALIGNMENT_STATUSES = new Set([
  "initial", "unchanged", "changed", "inserted", "deleted", "moved", "ambiguous",
]);

export function sourceSegmentVersionContract(input) {
  if (!Number.isInteger(input.ordinal) || input.ordinal < 0) throw new TypeError("ordinal must be a non-negative integer");
  if (typeof input.translatable !== "boolean") throw new TypeError("translatable must be boolean");
  if (!Array.isArray(input.protected)) throw new TypeError("protected must be an array");
  if (!ALIGNMENT_STATUSES.has(input.alignmentStatus)) throw new TypeError("alignmentStatus is invalid");
  return Object.freeze({
    workspaceId: opaqueId(input.workspaceId, "workspaceId"),
    documentId: opaqueId(input.documentId, "documentId"),
    sourceRevisionId: opaqueId(input.sourceRevisionId, "sourceRevisionId"),
    segmentId: opaqueId(input.segmentId, "segmentId"),
    kind: requiredString(input.kind, "kind"),
    structuralPath: requiredString(input.structuralPath, "structuralPath"),
    sourceText: requiredString(input.sourceText, "sourceText"),
    sourceDigest: digest(input.sourceDigest, "sourceDigest"),
    ordinal: input.ordinal,
    translatable: input.translatable,
    protected: Object.freeze(input.protected.map((item) => Object.freeze({ ...item }))),
    alignmentStatus: input.alignmentStatus,
  });
}

function canonicalLanguageTag(value) {
  requiredString(value, "targetLanguage");
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    if (!canonical) throw new RangeError();
    return canonical;
  } catch {
    throw new TypeError("targetLanguage must be a valid language tag");
  }
}

export function translationWorkflowContract(input) {
  return Object.freeze({
    workspaceId: opaqueId(input.workspaceId, "workspaceId"),
    workflowId: opaqueId(input.workflowId, "workflowId"),
    documentId: opaqueId(input.documentId, "documentId"),
    sourceRevisionId: opaqueId(input.sourceRevisionId, "sourceRevisionId"),
    targetLanguage: canonicalLanguageTag(input.targetLanguage),
  });
}

export function stableJson(value) {
  const seen = new Set();
  function normalize(item) {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (typeof item !== "object") throw new TypeError("unsupported JSON value");
    if (seen.has(item)) throw new TypeError("cyclic JSON value");
    seen.add(item);
    const output = {};
    for (const key of Object.keys(item).sort()) {
      if (item[key] === undefined) throw new TypeError("undefined is not allowed in canonical JSON");
      output[key] = normalize(item[key]);
    }
    seen.delete(item);
    return output;
  }
  return JSON.stringify(normalize(value));
}
