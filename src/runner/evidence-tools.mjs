import { createHash } from "node:crypto";
import { Type } from "typebox";
import { stableJson } from "../domain/contracts.mjs";

const parameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 512 }),
  topK: Type.Integer({ minimum: 1, maximum: 8 }),
}, { additionalProperties: false });

const normalize = (value) => value.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export function createRunnerEvidenceTools(request, { maxCalls = 8 } = {}) {
  if (!request?.evidence) return Object.freeze([]);
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 32) throw new TypeError("tool call limit is invalid");
  let calls = 0;
  const create = (name, kind) => Object.freeze({
    name, label: name,
    description: `Search only the controller-supplied untrusted ${kind} evidence for this attempt.`,
    parameters,
    async execute(toolCallId, input, signal) {
      if (signal?.aborted) throw new Error("tool execution canceled");
      if (++calls > maxCalls || typeof toolCallId !== "string" || typeof input?.query !== "string"
        || [...input.query].length < 1 || [...input.query].length > 512
        || !Number.isInteger(input.topK) || input.topK < 1 || input.topK > 8
        || Object.keys(input).sort().join(",") !== "query,topK") throw new Error("tool invocation denied");
      const needle = normalize(input.query);
      const hits = request.evidence.flatMap((snapshot) => snapshot.hits)
        .filter((hit) => hit.kind === kind && normalize(`${hit.snippet} ${hit.matchedField}`).includes(needle))
        .sort((left, right) => left.rank - right.rank || left.factId.localeCompare(right.factId))
        .slice(0, input.topK)
        .map(({ rank, factId, revisionId, kind: hitKind, language, matchedField, snippet, snippetDigest, contentDigest }) => ({
          rank, factId, revisionId, kind: hitKind, language, matchedField, snippet, snippetDigest, contentDigest,
        }));
      const value = Object.freeze({ hits: Object.freeze(hits), untrusted: true });
      const canonical = stableJson(value);
      if (Buffer.byteLength(canonical) > 64 * 1024) throw new Error("tool result limit exceeded");
      return Object.freeze({
        content: Object.freeze([{ type: "text", text: canonical }]),
        details: Object.freeze({ receiptDigest: digest(stableJson({ toolCallId, name, value })) }),
      });
    },
  });
  return Object.freeze([create("lookup_terms", "term"), create("search_knowledge", "knowledge")]);
}
