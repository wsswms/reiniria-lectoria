import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { referenceLookupResultContract } from "./contracts.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export function referenceResultDigest(input) {
  const { resultDigest: ignored, ...unsigned } = input;
  return sha(stableJson(unsigned));
}

export function createReferenceResult(input) {
  return referenceLookupResultContract({ ...input, resultDigest: referenceResultDigest(input) });
}

export function verifyReferenceResult(input) {
  const result = referenceLookupResultContract(input);
  if (result.resultDigest !== referenceResultDigest(result)) throw new TypeError("reference result digest mismatch");
  return result;
}
