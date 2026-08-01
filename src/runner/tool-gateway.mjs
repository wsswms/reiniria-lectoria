import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { CapabilityDeniedError } from "./capability.mjs";
import { knowledgeHitContract } from "../knowledge/contracts.mjs";

const TOOLS = Object.freeze({
  "segment.read": "segment:read",
  "candidate.submit": "candidate:submit",
  lookup_terms: "term:lookup",
  search_knowledge: "knowledge:search",
});

function denied() { throw new CapabilityDeniedError(); }

export function createToolGateway({ authority, readSegment, submitCandidate, lookupTerms, searchKnowledge }) {
  if (!authority || typeof authority.verify !== "function") throw new TypeError("capability authority is required");
  if (typeof readSegment !== "function" || typeof submitCandidate !== "function") throw new TypeError("tool handlers are required");
  return Object.freeze({
    async invoke({ token, tool, args } = {}) {
      const scope = TOOLS[tool];
      if (!scope || !args || typeof args !== "object") denied();
      const claims = authority.verify(token, { scope });
      const expected = { workspaceId: claims.workspaceId, taskId: claims.taskId, attemptId: claims.attemptId, scope };
      if (tool === "lookup_terms" || tool === "search_knowledge") {
        if (Object.keys(args).sort().join(",") !== "query,topK" || typeof args.query !== "string"
          || [...args.query].length < 1 || [...args.query].length > 512
          || !Number.isInteger(args.topK) || args.topK < 1 || args.topK > 8) denied();
        const handler = tool === "lookup_terms" ? lookupTerms : searchKnowledge;
        if (typeof handler !== "function") denied();
        const result = await handler(Object.freeze({ ...expected, query: args.query, topK: args.topK }));
        if (!Array.isArray(result) || result.length > args.topK) denied();
        let hits;
        try { hits = result.map(knowledgeHitContract); } catch { denied(); }
        if (hits.some((hit) => hit.kind !== (tool === "lookup_terms" ? "term" : "knowledge"))
          || Buffer.byteLength(stableJson(hits)) > 64 * 1024) denied();
        return Object.freeze({ hits: Object.freeze(hits) });
      }
      if (args.workspaceId !== claims.workspaceId || args.taskId !== claims.taskId || args.attemptId !== claims.attemptId) denied();
      if (tool === "segment.read") {
        if (typeof args.segmentId !== "string") denied();
        const value = await readSegment(Object.freeze({ ...expected, segmentId: args.segmentId }));
        if (!value || typeof value.sourceText !== "string" || typeof value.sourceDigest !== "string") denied();
        return Object.freeze({ sourceText: value.sourceText, sourceDigest: value.sourceDigest, protected: Object.freeze(value.protected ?? []) });
      }
      if (typeof args.segmentId !== "string" || typeof args.text !== "string" || typeof args.outputDigest !== "string") denied();
      const result = await submitCandidate(Object.freeze({ ...expected, grantId: claims.grantId, segmentId: args.segmentId, text: args.text, outputDigest: args.outputDigest }));
      const receipt = Object.freeze({
        grantId: claims.grantId,
        attemptId: claims.attemptId,
        segmentId: args.segmentId,
        accepted: result?.accepted === true,
      });
      return Object.freeze({ ...receipt, receiptDigest: `sha256:${createHash("sha256").update(stableJson(receipt)).digest("hex")}` });
    },
  });
}
