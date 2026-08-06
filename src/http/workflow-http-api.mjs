import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createWorkspaceBackup, restoreWorkspaceBackup, validateWorkspaceBackup } from "../storage/backup.mjs";
import { assertDatabaseIntegrity } from "../db/connection.mjs";

const AUTH_COMMANDS = new Set([
  "document:confirm", "reimport:confirm-alignment", "reimport:confirm-semantic", "workflow:create",
  "plan:decide", "guidance:decide", "context:decide", "flow:resolve",
  "candidate:add", "candidate:select", "working-copy:edit", "warning:confirm",
  "quality:run", "quality:get", "quality:confirm-warning", "qa:decide", "qa:retranslate", "review", "approve", "internet:create", "internet:fetch",
  "proposal:create", "proposal:revise", "proposal:decide", "proposal:apply",
  "knowledge-proposal:decide", "knowledge-proposal:apply",
  "translation:run-next",
  "knowledge:fact-create", "knowledge:fact-revise", "knowledge:fact-state",
]);
const SYSTEM_COMMANDS = new Set(["plan:submit", "guidance:propose", "guidance:interpret", "context:assemble"]);

function sameSecret(actual, expected) {
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sessionDigest(token) { return createHash("sha256").update(token).digest("hex"); }

function loadSessions(file) {
  if (!file) return new Map();
  if (!existsSync(file)) return new Map();
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("session store must be a private regular file");
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("session store is invalid");
  return new Map(parsed.filter((item) => item && typeof item.digest === "string" && typeof item.expiresAt === "number" && typeof item.csrfToken === "string")
    .map((item) => [item.digest, { expiresAt: item.expiresAt, csrfToken: item.csrfToken }]));
}

function persistSessions(file, sessions) {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const body = JSON.stringify([...sessions].map(([digest, session]) => ({ digest, ...session })));
  writeFileSync(temp, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temp, file);
}

function loadPassword(file, fallback) {
  if (!file) return fallback;
  if (!existsSync(file)) { persistPassword(file, fallback); return fallback; }
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("admin password store must be a private regular file");
  const password = readFileSync(file, "utf8").trimEnd();
  if (!password) throw new Error("admin password store is empty");
  return password;
}

function persistPassword(file, password) {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temp, `${password}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temp, file);
}

function cookieValue(header, name) {
  return String(header ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}

function jsonResponse(response, status, body, headers = {}) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": encoded.length,
    "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
    "content-security-policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    "permissions-policy": "camera=(), microphone=(), geolocation=()", "referrer-policy": "no-referrer", ...headers });
  response.end(encoded);
}

function backupId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw Object.assign(new Error("backup id is invalid"), { statusCode: 400, code: "INVALID_BACKUP_ID" });
  return value;
}

function backupRoot(config, workspaceManager) { return join(config.dataRoot ?? workspaceManager.root, "backups"); }

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

export function createWorkflowHttpHandler({ api, apiForWorkspace = null, config, workspaceManager = null, providerConfiguration = null, health = () => ({ status: "ok" }), diagnostics = null }) {
  if ((!api || typeof api.execute !== "function") && typeof apiForWorkspace !== "function") throw new TypeError("workflow API is required");
  if (!config) throw new TypeError("HTTP config is required");
  const sessions = loadSessions(config.sessionStoreFile);
  let currentAdminPassword = loadPassword(config.adminPasswordFile, config.adminPassword);
  const loginFailures = new Map();
  const sessionCookie = "lectoria_session";
  const issueSession = () => { const token = randomBytes(32).toString("base64url"); const session = { expiresAt: Date.now() + config.sessionTtlSeconds * 1000, csrfToken: randomBytes(24).toString("base64url") }; sessions.set(config.sessionStoreFile ? sessionDigest(token) : token, session); persistSessions(config.sessionStoreFile, sessions); return { token, ...session }; };
  const sessionUser = (request) => {
    const cookie = cookieValue(request.headers.cookie, sessionCookie);
    const key = cookie && (config.sessionStoreFile ? sessionDigest(cookie) : cookie);
    const session = key && sessions.get(key);
    if (session && session.expiresAt > Date.now()) return { token: cookie, csrfToken: session.csrfToken, id: "owner" };
    if (cookie && session) { sessions.delete(key); persistSessions(config.sessionStoreFile, sessions); }
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
        if (!input || typeof input.password !== "string" || !sameSecret(input.password, currentAdminPassword)) {
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
    if (request.method === "GET" && url.pathname === "/api/v1/diagnostics") {
      if (!user) return jsonResponse(response, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication required" } }, cors);
      try {
        const data = typeof diagnostics === "function" ? await diagnostics() : { status: "ok", service: "lectoria", node: process.versions.node, uptimeSeconds: Math.floor(process.uptime()), tlsEnabled: Boolean(config.tls?.certFile) };
        return jsonResponse(response, 200, { ok: true, data }, { ...cors, "cache-control": "no-store" });
      } catch (error) {
        return jsonResponse(response, 503, { ok: false, error: { code: "DIAGNOSTICS_UNAVAILABLE", message: "diagnostics unavailable" } }, cors);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/v1/upgrade/preflight") {
      if (!user) return jsonResponse(response, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication required" } }, cors);
      if (!workspaceManager) return jsonResponse(response, 503, { ok: false, error: { code: "UPGRADE_PREFLIGHT_UNAVAILABLE", message: "workspace manager is unavailable" } }, cors);
      const requestedWorkspaceId = url.searchParams.get("workspaceId");
      try {
        const records = requestedWorkspaceId ? [workspaceManager.get(requestedWorkspaceId)] : workspaceManager.list();
        const workspaces = records.map((record) => {
          const handle = workspaceManager.open(record.workspaceId);
          try {
            const integrity = assertDatabaseIntegrity(handle.database);
            const activeTaskCount = handle.database.prepare("SELECT count(*) AS count FROM translation_tasks WHERE state IN ('queued','running','retry-wait','paused')").get().count;
            return { workspaceId: record.workspaceId, schemaVersion: integrity.schemaVersion, expectedSchemaVersion: integrity.expectedSchemaVersion,
              activeTaskCount, integrity: integrity.integrity, foreignKeyViolations: integrity.foreignKeyViolations,
              ready: integrity.integrity === "ok" && integrity.foreignKeyViolations === 0 && integrity.schemaVersion === integrity.expectedSchemaVersion };
          } finally { handle.database.close(); }
        });
        return jsonResponse(response, 200, { ok: true, data: { checkedAt: new Date().toISOString(), workspaces, ready: workspaces.every((item) => item.ready) } }, cors);
      } catch (error) { return jsonResponse(response, error.statusCode ?? 422, { ok: false, error: { code: error.code ?? "UPGRADE_PREFLIGHT_FAILED", message: error.message } }, cors); }
    }
    if (request.method === "GET" && url.pathname === "/api/v1/session") {
      if (!user) return jsonResponse(response, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication required" } }, cors);
      return jsonResponse(response, 200, { ok: true, data: { user: { type: "user", id: user.id }, ...(user.csrfToken ? { csrfToken: user.csrfToken } : {}) } }, cors);
    }
    if (user?.token && request.method !== "GET" && !sameSecret(request.headers["x-csrf-token"] ?? "", user.csrfToken)) return jsonResponse(response, 403, { ok: false, error: { code: "CSRF_DENIED", message: "CSRF token is missing or invalid" } }, cors);
    if (request.method === "POST" && url.pathname === "/api/v1/session/password") {
      try {
        const input = await readJson(request, config.maxBodyBytes);
        if (!input || typeof input.currentPassword !== "string" || !sameSecret(input.currentPassword, currentAdminPassword)) throw Object.assign(new Error("current password is invalid"), { statusCode: 401, code: "UNAUTHENTICATED" });
        if (typeof input.newPassword !== "string" || input.newPassword.length < 8 || input.newPassword.length > 256) throw Object.assign(new Error("new password must be 8 to 256 characters"), { statusCode: 422, code: "INVALID_PASSWORD" });
        currentAdminPassword = input.newPassword; persistPassword(config.adminPasswordFile, currentAdminPassword);
        sessions.clear(); persistSessions(config.sessionStoreFile, sessions);
        const session = issueSession(); const secure = config.cookieSecure ? "; Secure" : "";
        return jsonResponse(response, 200, { ok: true, data: { changed: true, csrfToken: session.csrfToken } }, { ...cors, "set-cookie": `${sessionCookie}=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.sessionTtlSeconds}${secure}` });
      } catch (error) {
        return jsonResponse(response, error.statusCode ?? 422, { ok: false, error: { code: error.code ?? "PASSWORD_CHANGE_FAILED", message: error.message } }, cors);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/v1/session/logout") {
      if (!user) return jsonResponse(response, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication required" } }, cors);
      if (user.token) { sessions.delete(config.sessionStoreFile ? sessionDigest(user.token) : user.token); persistSessions(config.sessionStoreFile, sessions); }
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
    const workspaceBackupsMatch = url.pathname.match(/^\/api\/v1\/workspaces\/([^/]+)\/backups$/);
    if (workspaceManager && workspaceBackupsMatch && (request.method === "GET" || request.method === "POST")) {
      if (!user) return jsonResponse(response, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication required" } }, cors);
      const workspaceId = decodeURIComponent(workspaceBackupsMatch[1]);
      try {
        const root = backupRoot(config, workspaceManager);
        if (request.method === "POST") {
          const handle = workspaceManager.open(workspaceId);
          try {
            const id = `${Date.now()}-${randomUUID()}`;
            const manifest = await createWorkspaceBackup({ database: handle.database, workspaceRoot: handle.root, destination: join(root, id) });
            return jsonResponse(response, 201, { ok: true, data: { backupId: id, workspaceId: manifest.workspace_id, schemaVersion: manifest.schema_version, manifestDigest: manifest.manifest_digest, objectCount: manifest.objects.length, portableFactCount: manifest.portable_facts.length } }, cors);
          } finally { handle.database.close(); }
        }
        const entries = await readdir(join(root, ""), { withFileTypes: true }).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
        const backups = [];
        for (const entry of entries) {
          if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(entry.name)) continue;
          try {
            const manifest = await validateWorkspaceBackup(join(root, entry.name));
            if (manifest.workspace_id === workspaceId) backups.push({ backupId: entry.name, workspaceId, schemaVersion: manifest.schema_version, manifestDigest: manifest.manifest_digest, objectCount: manifest.objects.length, portableFactCount: manifest.portable_facts.length });
          } catch { /* invalid backups are not presented as restorable */ }
        }
        backups.sort((a, b) => b.backupId.localeCompare(a.backupId));
        return jsonResponse(response, 200, { ok: true, data: backups }, cors);
      } catch (error) { return jsonResponse(response, error.statusCode ?? 422, { ok: false, error: { code: error.code ?? "BACKUP_ERROR", message: error.message } }, cors); }
    }
    if (workspaceManager && request.method === "POST" && url.pathname === "/api/v1/backups/restore") {
      if (!user) return jsonResponse(response, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "authentication required" } }, cors);
      try {
        const input = await readJson(request, config.maxBodyBytes); const id = backupId(input?.backupId);
        const restored = await restoreWorkspaceBackup({ backupRoot: join(backupRoot(config, workspaceManager), id), manager: workspaceManager, targetWorkspaceId: randomUUID() });
        return jsonResponse(response, 201, { ok: true, data: restored }, cors);
      } catch (error) { return jsonResponse(response, error.statusCode ?? 422, { ok: false, error: { code: error.code ?? "BACKUP_RESTORE_ERROR", message: error.message } }, cors); }
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
        response.writeHead(200, { ...cors, "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
          "content-security-policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'", "permissions-policy": "camera=(), microphone=(), geolocation=()",
          "referrer-policy": "no-referrer", "content-type": contentTypes[artifact.format] ?? "application/octet-stream", "content-disposition": `attachment; filename="${artifact.filename}"`, "content-length": artifact.content.length });
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
