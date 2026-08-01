import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ALLOWED_SCOPES = new Set(["segment:read", "candidate:submit"]);

const encode = (value) => Buffer.from(value).toString("base64url");
const digestToken = (token) => `sha256:${createHash("sha256").update(token).digest("hex")}`;

function claimsContract(input) {
  if (!input || typeof input !== "object") throw new TypeError("capability claims are required");
  for (const name of ["grantId", "workspaceId", "taskId", "attemptId"]) {
    if (!UUID.test(input[name] ?? "")) throw new TypeError(`${name} must be a lowercase UUID`);
  }
  if (!Array.isArray(input.scopes) || input.scopes.length === 0 || input.scopes.some((scope) => !ALLOWED_SCOPES.has(scope))) {
    throw new TypeError("capability scopes are invalid");
  }
  const scopes = [...new Set(input.scopes)].sort();
  if (scopes.length !== input.scopes.length) throw new TypeError("capability scopes must be unique");
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0) throw new TypeError("expiresAt must be epoch milliseconds");
  return Object.freeze({
    version: 1,
    grantId: input.grantId,
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    scopes: Object.freeze(scopes),
    expiresAt: input.expiresAt,
  });
}

export class CapabilityDeniedError extends Error {
  constructor() {
    super("capability denied");
    this.name = "CapabilityDeniedError";
    this.code = "CAPABILITY_DENIED";
  }
}

export class CapabilityAuthority {
  #signingKey;
  #now;
  #id;
  #revoked;

  constructor(signingKey, { now = () => Date.now(), id = () => randomUUID() } = {}) {
    if (!Buffer.isBuffer(signingKey) || signingKey.byteLength < 32) throw new TypeError("signingKey must contain at least 32 bytes");
    this.#signingKey = Buffer.from(signingKey);
    this.#now = now;
    this.#id = id;
    this.#revoked = new Set();
  }

  issue(input) {
    const claims = claimsContract({ ...input, grantId: input.grantId ?? this.#id() });
    if (claims.expiresAt <= this.#now()) throw new TypeError("capability must expire in the future");
    const payload = encode(stableJson(claims));
    const signature = createHmac("sha256", this.#signingKey).update(payload).digest("base64url");
    const token = `${payload}.${signature}`;
    return Object.freeze({ token, tokenDigest: digestToken(token), claims });
  }

  verify(token, expected = {}) {
    try {
      if (typeof token !== "string" || token.length > 4096) throw new Error();
      const [payload, signature, extra] = token.split(".");
      if (!payload || !signature || extra !== undefined) throw new Error();
      const actual = Buffer.from(signature, "base64url");
      const wanted = createHmac("sha256", this.#signingKey).update(payload).digest();
      if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw new Error();
      if (this.#revoked.has(digestToken(token))) throw new Error();
      const claims = claimsContract(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
      if (claims.expiresAt <= this.#now()) throw new Error();
      for (const name of ["workspaceId", "taskId", "attemptId"]) {
        if (expected[name] !== undefined && claims[name] !== expected[name]) throw new Error();
      }
      if (expected.scope !== undefined && !claims.scopes.includes(expected.scope)) throw new Error();
      return claims;
    } catch {
      throw new CapabilityDeniedError();
    }
  }

  revoke(token) {
    this.#revoked.add(digestToken(token));
  }
}

export { digestToken as capabilityTokenDigest };
