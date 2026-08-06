import { randomBytes, timingSafeEqual } from "node:crypto";

const AUTH_COMMANDS = new Set([
  "document:confirm", "reimport:confirm-alignment", "reimport:confirm-semantic", "workflow:create",
  "plan:decide", "guidance:decide", "context:decide", "flow:resolve",
  "candidate:add", "candidate:select", "working-copy:edit", "warning:confirm",
  "quality:confirm-warning", "qa:decide", "qa:retranslate", "review", "approve", "internet:create", "internet:fetch",
  "proposal:create", "proposal:revise", "proposal:decide", "proposal:apply",
  "translation:run-next",
  "knowledge:fact-create", "knowledge:fact-revise", "knowledge:fact-state",
]);
const SYSTEM_COMMANDS = new Set(["plan:submit", "guidance:propose", "guidance:interpret", "context:assemble"]);

function sameSecret(actual, expected) {
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(header, name) {
  return String(header ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
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

export function createWorkflowHttpHandler({ api, apiForWorkspace = null, config, workspaceManager = null, providerConfiguration = null, health = () => ({ status: "ok" }) }) {
  if ((!api || typeof api.execute !== "function") && typeof apiForWorkspace !== "function") throw new TypeError("workflow API is required");
  if (!config) throw new TypeError("HTTP config is required");
  const sessions = new Map();
  const loginFailures = new Map();
  const sessionCookie = "lectoria_session";
  const issueSession = () => { const token = randomBytes(32).toString("base64url"); const session = { expiresAt: Date.now() + config.sessionTtlSeconds * 1000, csrfToken: randomBytes(24).toString("base64url") }; sessions.set(token, session); return { token, ...session }; };
  const sessionUser = (request) => {
    const cookie = cookieValue(request.headers.cookie, sessionCookie);
    const session = cookie && sessions.get(cookie);
    if (session && session.expiresAt > Date.now()) return { token: cookie, csrfToken: session.csrfToken, id: "owner" };
    if (cookie && session) sessions.delete(cookie);
    const authorization = request.headers.authorization ?? "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (sameSecret(supplied, config.authToken)) return { token: null, id: "owner" };
    return null;
  };
  return async function workflowHttpHandler(request, response) {
    const origin = request.headers.origin;
    if (origin && config.allowedOrigins.length > 0 && !config.allowedOrigins.includes(origin)) return jsonResponse(response, 403, { ok: false, error: { code: "ORIGIN_DENIED", message: "origin is not allowed" } });
    const cors = origin && config.allowedOrigins.includes(origin) ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" } : {};
    if (request.method === "OPTIONS") return jsonResponse(response, 204, {}, { ...cors, "access-control-allow-methods": "POST,GET,OPTIONS", "access-control-allow-headers": "authorization,content-type,x-csrf-token" });
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/healthz") return jsonResponse(response, 200, health(), cors);
    if (request.method === "POST" && url.pathname === "/api/v1/session/login") {
      try {
        const key = request.socket?.remoteAddress ?? "unknown";
        const now = Date.now(); const failure = loginFailures.get(key);
        if (failure && failure.resetAt > now && failure.count >= (config.loginMaxAttempts ?? 5)) throw Object.assign(new Error("too many login attempts"), { statusCode: 429, code: "LOGIN_RATE_LIMITED" });
        if (failure && failure.resetAt <= now) loginFailures.delete(key);
        const input = await readJson(request, config.maxBodyBytes);
        if (!input || typeof input.password !== "string" || !sameSecret(input.password, config.adminPassword)) {
          const current = loginFailures.get(key); const windowMs = (config.loginWindowSeconds ?? 300) * 1000;
          loginFailures.set(key, { count: (current?.resetAt > now ? current.count : 0) + 1, resetAt: current?.resetAt > now ? current.resetAt : now + windowMs });
          throw Object.assign(new Error("invalid credentials"), { statusCode: 401, code: "UNAUTHENTICATED" });
        }
        loginFailures.delete(key);
        const session = issueSession();
        const secure = config.cookieSecure ? "; Secure" : "";
        return jsonResponse(response, 200, { ok: true, data: { user: { type: "user", id: "owner" }, csrfToken: session.csrfToken } }, { ...cors, "set-cookie": `${sessionCookie}=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.sessionTtlSeconds}${secure}` });
      } catch (error) {
        return jsonResponse(response, error.statusCode ?? 400, { ok: false, error: { code: error.code ?? "INVALID_REQUEST", message: error.message } }, cors);
      }
    }
    const user = sessionUser(request);
    if (request.method === "GET" && url.pathname === "/api/v1/session") {
      if (!user) return jsonResponse(response, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication required" } }, cors);
      return jsonResponse(response, 200, { ok: true, data: { user: { type: "user", id: user.id }, ...(user.csrfToken ? { csrfToken: user.csrfToken } : {}) } }, cors);
    }
    if (user?.token && request.method !== "GET" && !sameSecret(request.headers["x-csrf-token"] ?? "", user.csrfToken)) return jsonResponse(response, 403, { ok: false, error: { code: "CSRF_DENIED", message: "CSRF token is missing or invalid" } }, cors);
    if (request.method === "POST" && url.pathname === "/api/v1/session/logout") {
      if (!user) return jsonResponse(response, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication required" } }, cors);
      if (user.token) sessions.delete(user.token);
      return jsonResponse(response, 200, { ok: true, data: { loggedOut: true } }, { ...cors, "set-cookie": `${sessionCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }
    if (providerConfiguration && url.pathname === "/api/v1/provider-config" && request.method === "GET") {
      if (!user) return jsonResponse(response, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication required" } }, cors);
      try { return jsonResponse(response, 200, { ok: true, data: await providerConfiguration.list() }, cors); }
      catch (error) { return jsonResponse(response, 422, { ok: false, error: { code: error.code ?? "PROVIDER_CONFIG_ERROR", message: error.message } }, cors); }
    }
    if (providerConfiguration && url.pathname === "/api/v1/provider-config/sources" && request.method === "POST") {
      if (!user) return jsonResponse(response, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication required" } }, cors);
      try { const input = await readJson(request, config.maxBodyBytes); return jsonResponse(response, 201, { ok: true, data: await providerConfiguration.createSource(input, input.expectedRevision ?? null) }, cors); }
      catch (error) { return jsonResponse(response, error.statusCode ?? 422, { ok: false, error: { code: error.code ?? "PROVIDER_CONFIG_ERROR", message: error.message } }, cors); }
    }
    if (providerConfiguration && url.pathname === "/api/v1/provider-config/presets" && request.method === "POST") {
      if (!user) return jsonResponse(response, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication required" } }, cors);
      try { const input = await readJson(request, config.maxBodyBytes); return jsonResponse(response, 201, { ok: true, data: await providerConfiguration.setPreset(input, input.expectedRevision ?? null) }, cors); }
      catch (error) { return jsonResponse(response, error.statusCode ?? 422, { ok: false, error: { code: error.code ?? "PROVIDER_CONFIG_ERROR", message: error.message } }, cors); }
    }
    if (workspaceManager && url.pathname === "/api/v1/workspaces" && (request.method === "GET" || request.method === "POST")) {
      if (!user) return jsonResponse(response, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication required" } }, cors);
      try {
        const data = request.method === "GET" ? workspaceManager.list() : await workspaceManager.createWorkspace((await readJson(request, config.maxBodyBytes)).displayName);
        return jsonResponse(response, request.method === "POST" ? 201 : 200, { ok: true, data }, cors);
      } catch (error) {
        return jsonResponse(response, error.statusCode ?? 422, { ok: false, error: { code: error.code ?? "WORKSPACE_ERROR", message: error.message } }, cors);
      }
    }
    const workspaceMatch = url.pathname.match(/^\/api\/v1\/workspaces\/([^/]+)$/);
    if (workspaceManager && workspaceMatch && request.method === "GET") {
      if (!user) return jsonResponse(response, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication required" } }, cors);
      try { return jsonResponse(response, 200, { ok: true, data: workspaceManager.get(decodeURIComponent(workspaceMatch[1])) }, cors); }
      catch (error) { return jsonResponse(response, error.statusCode ?? 404, { ok: false, error: { code: error.code ?? "WORKSPACE_ERROR", message: error.message } }, cors); }
    }
    const downloadMatch = url.pathname.match(/^\/api\/v1\/workspaces\/([^/]+)\/exports\/([^/]+)\/download$/);
    if (downloadMatch && request.method === "GET") {
      if (!user) return jsonResponse(response, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication required" } }, cors);
      let close = () => {};
      try {
        const scoped = await apiForWorkspace(decodeURIComponent(downloadMatch[1]));
        const selected = scoped?.api ?? scoped; close = scoped?.close ?? close;
        const artifact = await selected.execute("export:download", { workspaceId: decodeURIComponent(downloadMatch[1]), exportId: decodeURIComponent(downloadMatch[2]) });
        const contentTypes = { markdown: "text/markdown; charset=utf-8", html: "text/html; charset=utf-8", text: "text/plain; charset=utf-8", canonical: "application/json; charset=utf-8" };
        response.writeHead(200, { ...cors, "content-type": contentTypes[artifact.format] ?? "application/octet-stream", "content-disposition": `attachment; filename="${artifact.filename}"`, "content-length": artifact.content.length });
        response.end(artifact.content); return;
      } catch (error) { return jsonResponse(response, error.statusCode ?? 422, { ok: false, error: { code: error.code ?? "EXPORT_ERROR", message: error.message } }, cors); }
      finally { close(); }
    }
    if (request.method !== "POST" || url.pathname !== "/api/v1/execute") return jsonResponse(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "route not found" } }, cors);
    if (!user) return jsonResponse(response, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication required" } }, cors);
    try {
      const input = await readJson(request, config.maxBodyBytes);
      if (!input || typeof input.command !== "string" || !input.payload || typeof input.payload !== "object") throw Object.assign(new Error("command and payload are required"), { statusCode: 400, code: "INVALID_REQUEST" });
      const workspaceId = input.payload.workspaceId;
      if (apiForWorkspace && (typeof workspaceId !== "string" || workspaceId.length === 0)) throw Object.assign(new Error("workspaceId is required"), { statusCode: 400, code: "WORKSPACE_REQUIRED" });
      const payload = { ...input.payload };
      if (AUTH_COMMANDS.has(input.command)) payload.actor = { type: "user", id: user.id };
      if (SYSTEM_COMMANDS.has(input.command)) payload.actor = { type: "system", id: "http-control" };
      let selected = api;
      let close = () => {};
      if (apiForWorkspace) {
        const scoped = await apiForWorkspace(workspaceId);
        selected = scoped?.api ?? scoped;
        close = typeof scoped?.close === "function" ? scoped.close : close;
      }
      if (!selected || typeof selected.execute !== "function") throw new Error("workspace workflow API is unavailable");
      try {
        if (["translation:enqueue", "flow:resolve"].includes(input.command) && providerConfiguration && payload.request?.presetId) {
          const preset = await providerConfiguration.resolvePreset({ stage: payload.request.stage ?? "translation", presetId: payload.request.presetId });
          payload.request = { ...payload.request, providerId: preset.sourceId, modelId: preset.modelId, thinking: preset.thinking,
            temperature: preset.temperature, toolNames: preset.toolNames, configDigest: preset.configDigest };
          delete payload.request.presetId; delete payload.request.stage;
        }
        const data = await selected.execute(input.command, payload);
        return jsonResponse(response, 200, { ok: true, data }, cors);
      } finally { close(); }
    } catch (error) {
      const unknownCommand = error.message === "unknown workflow command";
      const status = error.statusCode ?? (unknownCommand ? 400 : 422);
      const code = unknownCommand ? "UNKNOWN_COMMAND" : (error.code ?? "WORKFLOW_ERROR");
      return jsonResponse(response, status, { ok: false, error: { code, message: error.message ?? "workflow request failed" } }, cors);
    }
  };
}
