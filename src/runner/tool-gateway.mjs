import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { CapabilityDeniedError } from "./capability.mjs";

const TOOLS = Object.freeze({
  "segment.read": "segment:read",
  "candidate.submit": "candidate:submit",
});

function denied() { throw new CapabilityDeniedError(); }

export function createToolGateway({ authority, readSegment, submitCandidate }) {
  if (!authority || typeof authority.verify !== "function") throw new TypeError("capability authority is required");
  if (typeof readSegment !== "function" || typeof submitCandidate !== "function") throw new TypeError("tool handlers are required");
  return Object.freeze({
    async invoke({ token, tool, args } = {}) {
      const scope = TOOLS[tool];
      if (!scope || !args || typeof args !== "object") denied();
      const expected = {
        workspaceId: args.workspaceId,
        taskId: args.taskId,
        attemptId: args.attemptId,
        scope,
      };
      const claims = authority.verify(token, expected);
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
