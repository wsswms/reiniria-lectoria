import { createHmac, timingSafeEqual } from "node:crypto";

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issueCapability(claims, secret) {
  const payload = encode(claims);
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyCapability(token, secret, now = Date.now()) {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new Error("invalid capability format");
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("invalid capability signature");
  }
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!Number.isFinite(claims.expiresAt) || claims.expiresAt <= now) {
    throw new Error("expired capability");
  }
  return claims;
}

export function createTaskGateway({ secret, tasks, now = () => Date.now() }) {
  return {
    getSegment({ capability, taskId, segmentId }) {
      const claims = verifyCapability(capability, secret, now());
      if (claims.taskId !== taskId) throw new Error("task outside capability");
      if (!claims.segmentIds.includes(segmentId)) throw new Error("segment outside capability");
      const task = tasks.get(claims.taskId);
      if (!task || task.workspaceId !== claims.workspaceId) throw new Error("server task scope mismatch");
      const segment = task.segments.get(segmentId);
      if (!segment) throw new Error("segment not found");
      return { workspaceId: task.workspaceId, taskId, segmentId, text: segment };
    },
  };
}
