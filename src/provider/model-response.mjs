import { stableJson } from "../domain/contracts.mjs";
import { validateTranslationInput } from "../translation/validator.mjs";
import { RESPONSE_VERSION, contentDigest } from "./prompt-context.mjs";

export class ModelResponseError extends Error {
  constructor(message, code = "MALFORMED_RESPONSE") {
    super(message);
    this.name = "ModelResponseError";
    this.code = code;
    this.category = "malformed-response";
    this.retryable = false;
  }
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelResponseError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ModelResponseError(`${label} contains unknown or missing fields`);
  }
}

export function parseModelResponse(input, context, { maxOutputBytes = 1024 * 1024, maxSegmentBytes = 256 * 1024 } = {}) {
  const serialized = typeof input === "string" ? input : stableJson(input);
  if (Buffer.byteLength(serialized, "utf8") > maxOutputBytes) throw new ModelResponseError("model response exceeds output limit", "OUTPUT_LIMIT");
  let value;
  try { value = typeof input === "string" ? JSON.parse(input) : input; }
  catch { throw new ModelResponseError("model response is not valid JSON"); }
  exactKeys(value, ["schemaVersion", "workflowId", "sourceRevisionId", "targetLanguage", "candidates"], "response");
  if (value.schemaVersion !== RESPONSE_VERSION) throw new ModelResponseError("response version mismatch");
  for (const [field, expected] of [
    ["workflowId", context.manifest.workflowId],
    ["sourceRevisionId", context.manifest.sourceRevisionId],
    ["targetLanguage", context.manifest.targetLanguage],
  ]) if (value[field] !== expected) throw new ModelResponseError(`${field} mismatch`);
  if (!Array.isArray(value.candidates)) throw new ModelResponseError("candidates must be an array");
  if (value.candidates.length !== context.manifest.segments.length) throw new ModelResponseError("candidate count mismatch");
  const candidates = value.candidates.map((candidate, index) => {
    exactKeys(candidate, ["segmentId", "structuralPath", "kind", "text"], "candidate");
    const source = context.manifest.segments[index];
    if (candidate.segmentId !== source.segmentId) throw new ModelResponseError("candidate segment order or identity mismatch");
    if (typeof candidate.text !== "string" || Buffer.byteLength(candidate.text, "utf8") > maxSegmentBytes) {
      throw new ModelResponseError("candidate text is invalid or exceeds limit", "OUTPUT_LIMIT");
    }
    return Object.freeze({ ...candidate });
  });
  const workflow = {
    workflowId: context.manifest.workflowId,
    sourceRevisionId: context.manifest.sourceRevisionId,
    targetLanguage: context.manifest.targetLanguage,
  };
  const findings = validateTranslationInput({ workflow, sourceSegments: context.manifest.segments, translations: candidates.map((candidate) => ({
    ...candidate,
    workflowId: workflow.workflowId,
    sourceRevisionId: workflow.sourceRevisionId,
    targetLanguage: workflow.targetLanguage,
  })) });
  const errors = findings.filter((finding) => finding.severity === "error");
  if (errors.length > 0) throw new ModelResponseError(`candidate validation failed: ${errors.map((item) => item.code).join(",")}`, "CANDIDATE_INVALID");
  const normalized = Object.freeze({
    schemaVersion: RESPONSE_VERSION,
    workflowId: workflow.workflowId,
    sourceRevisionId: workflow.sourceRevisionId,
    targetLanguage: workflow.targetLanguage,
    candidates: Object.freeze(candidates),
  });
  const canonical = stableJson(normalized);
  return Object.freeze({ response: normalized, canonical, outputDigest: contentDigest(canonical), findings });
}
