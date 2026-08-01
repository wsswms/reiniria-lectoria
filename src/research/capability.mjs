import { createHmac, randomBytes } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { ResearchAuthorizationError, ResearchFoundationService } from "./foundation-service.mjs";
import { ResearchRunService } from "./run-service.mjs";

const TOOLS = Object.freeze(["propose-query", "select-source", "submit-report"]);

function mac(key, value) { return createHmac("sha256", key).update(value).digest("base64url"); }

export class ResearchCapabilityService {
  constructor(database, workspaceId, { key, now = () => new Date() } = {}) {
    if (!(key instanceof Uint8Array) || key.byteLength < 32) throw new TypeError("research capability key is invalid");
    this.database = database; this.workspaceId = workspaceId; this.key = Buffer.from(key); this.now = now;
    this.foundation = new ResearchFoundationService(database, workspaceId, { now });
    this.runs = new ResearchRunService(database, workspaceId, { now });
  }

  issue(runId, ttlMs = 60_000) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 300_000) throw new TypeError("research capability TTL is invalid");
    const run = this.runs.get(runId);
    const { grant, status } = this.foundation.getGrant(run.grantId);
    if (status !== "active" || !["queued", "running", "paused"].includes(run.state)) throw new ResearchAuthorizationError("run cannot receive a capability");
    const expiresAt = new Date(Math.min(this.now().getTime() + ttlMs, new Date(run.deadlineAt).getTime(), new Date(grant.expiresAt).getTime())).toISOString();
    const payload = stableJson({ version: "research-capability-v1", workspaceId: this.workspaceId, grantId: run.grantId, runId,
      providers: grant.providers, tools: TOOLS, expiresAt, nonce: randomBytes(16).toString("hex") });
    return `${Buffer.from(payload).toString("base64url")}.${mac(this.key, payload)}`;
  }

  verify(token, { runId, tool, capability, providerId } = {}) {
    if (typeof token !== "string" || token.length > 16_384) throw new ResearchAuthorizationError("research capability is invalid");
    const [encoded, signature, extra] = token.split(".");
    if (!encoded || !signature || extra !== undefined) throw new ResearchAuthorizationError("research capability is invalid");
    let payload;
    try { payload = Buffer.from(encoded, "base64url").toString("utf8"); } catch { throw new ResearchAuthorizationError("research capability is invalid"); }
    if (mac(this.key, payload) !== signature) throw new ResearchAuthorizationError("research capability signature is invalid");
    let claims;
    try { claims = JSON.parse(payload); } catch { throw new ResearchAuthorizationError("research capability payload is invalid"); }
    if (claims.version !== "research-capability-v1" || claims.workspaceId !== this.workspaceId || claims.runId !== runId ||
      !TOOLS.includes(tool) || !claims.tools.includes(tool) || this.now().toISOString() >= claims.expiresAt) throw new ResearchAuthorizationError("research capability scope is invalid or expired");
    const run = this.runs.get(runId);
    const grant = this.foundation.getGrant(run.grantId);
    if (run.grantId !== claims.grantId || grant.status !== "active" || !["queued", "running", "paused"].includes(run.state)) throw new ResearchAuthorizationError("research capability is revoked or stale");
    if (capability !== undefined && !claims.providers.some((item) => item.capability === capability && item.providerId === providerId)) throw new ResearchAuthorizationError("provider capability is outside the token");
    return Object.freeze(claims);
  }
}

export const RESEARCH_RUNNER_TOOLS = TOOLS;
