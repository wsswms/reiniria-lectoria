import { timingSafeEqual } from "node:crypto";

const AUTH_COMMANDS = new Set([
  "document:confirm", "reimport:confirm-alignment", "reimport:confirm-semantic",
  "candidate:add", "candidate:select", "working-copy:edit", "warning:confirm",
  "quality:confirm-warning", "review", "approve", "internet:create", "internet:fetch",
  "proposal:create", "proposal:revise", "proposal:decide", "proposal:apply",
]);

function sameSecret(actual, expected) {
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function jsonResponse(response, status, body, headers = {}) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": encoded.length, ...headers });
  response.end(encoded);
}

async function readJson(request, maxBodyBytes) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error("request body exceeds limit"), { statusCode: 413, code: "PAYLOAD_TOO_LARGE" });
    chunks.push(chunk);
  }
  if (size === 0) throw Object.assign(new Error("JSON body is required"), { statusCode: 400, code: "INVALID_JSON" });
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("request body must be valid JSON"), { statusCode: 400, code: "INVALID_JSON" }); }
}

export function createWorkflowHttpHandler({ api, config, health = () => ({ status: "ok" }) }) {
  if (!api || typeof api.execute !== "function") throw new TypeError("workflow API is required");
  if (!config) throw new TypeError("HTTP config is required");
  return async function workflowHttpHandler(request, response) {
    const origin = request.headers.origin;
    if (origin && config.allowedOrigins.length > 0 && !config.allowedOrigins.includes(origin)) return jsonResponse(response, 403, { ok: false, error: { code: "ORIGIN_DENIED", message: "origin is not allowed" } });
    const cors = origin && config.allowedOrigins.includes(origin) ? { "access-control-allow-origin": origin, vary: "Origin" } : {};
    if (request.method === "OPTIONS") return jsonResponse(response, 204, {}, { ...cors, "access-control-allow-methods": "POST,GET,OPTIONS", "access-control-allow-headers": "authorization,content-type,x-csrf-token" });
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/healthz") return jsonResponse(response, 200, health(), cors);
    if (request.method !== "POST" || url.pathname !== "/api/v1/execute") return jsonResponse(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "route not found" } }, cors);
    if (config.authToken) {
      const authorization = request.headers.authorization ?? "";
      const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!sameSecret(supplied, config.authToken)) return jsonResponse(response, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication required" } }, cors);
    }
    try {
      const input = await readJson(request, config.maxBodyBytes);
      if (!input || typeof input.command !== "string" || !input.payload || typeof input.payload !== "object") throw Object.assign(new Error("command and payload are required"), { statusCode: 400, code: "INVALID_REQUEST" });
      const payload = { ...input.payload };
      if (AUTH_COMMANDS.has(input.command)) payload.actor = { type: "user", id: request.headers["x-lectoria-user"] ?? "web-user" };
      const data = await api.execute(input.command, payload);
      return jsonResponse(response, 200, { ok: true, data }, cors);
    } catch (error) {
      const unknownCommand = error.message === "unknown workflow command";
      const status = error.statusCode ?? (unknownCommand ? 400 : 422);
      const code = unknownCommand ? "UNKNOWN_COMMAND" : (error.code ?? "WORKFLOW_ERROR");
      return jsonResponse(response, status, { ok: false, error: { code, message: error.message ?? "workflow request failed" } }, cors);
    }
  };
}
