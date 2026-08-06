import { existsSync } from "node:fs";

function positiveInteger(value, name, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}

function boolean(value, name, fallback) {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`${name} must be true or false`);
}

function nonnegativeInteger(value, name, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return parsed;
}

export function loadHttpConfig(env = process.env) {
  const token = env.LECTORIA_AUTH_TOKEN ?? "";
  if (!token) throw new Error("LECTORIA_AUTH_TOKEN is required; all application functions require login");
  const dataRoot = env.LECTORIA_DATA_ROOT ?? "/var/lib/lectoria";
  if (!dataRoot.startsWith("/") || dataRoot === "/") throw new TypeError("LECTORIA_DATA_ROOT must be an absolute non-root path");
  const allowedOrigins = (env.LECTORIA_ALLOWED_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const tls = Object.freeze({
    certFile: env.LECTORIA_TLS_CERT_FILE ?? null,
    keyFile: env.LECTORIA_TLS_KEY_FILE ?? null,
  });
  const translationMode = env.LECTORIA_TRANSLATION_MODE ?? "fake";
  if (!new Set(["fake", "real"]).has(translationMode)) throw new TypeError("LECTORIA_TRANSLATION_MODE must be fake or real");
  return Object.freeze({
    host: env.LECTORIA_HOST ?? "127.0.0.1",
    port: positiveInteger(env.LECTORIA_PORT, "LECTORIA_PORT", 8787),
    maxBodyBytes: positiveInteger(env.LECTORIA_MAX_BODY_BYTES, "LECTORIA_MAX_BODY_BYTES", 4 * 1024 * 1024),
    dataRoot,
    sessionStoreFile: env.LECTORIA_SESSION_STORE_FILE ?? `${dataRoot}/state/sessions.json`,
    authToken: token,
    adminPassword: env.LECTORIA_ADMIN_PASSWORD ?? token,
    adminPasswordFile: env.LECTORIA_ADMIN_PASSWORD_FILE ?? `${dataRoot}/state/admin-password`,
    sessionTtlSeconds: positiveInteger(env.LECTORIA_SESSION_TTL_SECONDS, "LECTORIA_SESSION_TTL_SECONDS", 86_400),
    loginMaxAttempts: positiveInteger(env.LECTORIA_LOGIN_MAX_ATTEMPTS, "LECTORIA_LOGIN_MAX_ATTEMPTS", 5),
    loginWindowSeconds: positiveInteger(env.LECTORIA_LOGIN_WINDOW_SECONDS, "LECTORIA_LOGIN_WINDOW_SECONDS", 300),
    cookieSecure: boolean(env.LECTORIA_COOKIE_SECURE, "LECTORIA_COOKIE_SECURE", Boolean(tls.certFile)),
    allowedOrigins,
    tls,
    translationMode,
    realProviderTimeoutMs: positiveInteger(env.LECTORIA_REAL_PROVIDER_TIMEOUT_MS, "LECTORIA_REAL_PROVIDER_TIMEOUT_MS", 120_000),
    realMaxOutputTokens: positiveInteger(env.LECTORIA_REAL_MAX_OUTPUT_TOKENS, "LECTORIA_REAL_MAX_OUTPUT_TOKENS", 4_096),
    realPricingVersion: env.LECTORIA_REAL_PRICING_VERSION ?? "m6-real-pricing-v1",
    realInputMicrosPerMillion: nonnegativeInteger(env.LECTORIA_REAL_INPUT_MICROS_PER_MILLION, "LECTORIA_REAL_INPUT_MICROS_PER_MILLION", 2_800_000),
    realOutputMicrosPerMillion: nonnegativeInteger(env.LECTORIA_REAL_OUTPUT_MICROS_PER_MILLION, "LECTORIA_REAL_OUTPUT_MICROS_PER_MILLION", 5_600_000),
    realCachedInputMicrosPerMillion: nonnegativeInteger(env.LECTORIA_REAL_CACHED_INPUT_MICROS_PER_MILLION, "LECTORIA_REAL_CACHED_INPUT_MICROS_PER_MILLION", 56_000),
    realSoftLimitMicros: positiveInteger(env.LECTORIA_REAL_SOFT_LIMIT_MICROS, "LECTORIA_REAL_SOFT_LIMIT_MICROS", 5_000_000),
    realHardLimitMicros: positiveInteger(env.LECTORIA_REAL_HARD_LIMIT_MICROS, "LECTORIA_REAL_HARD_LIMIT_MICROS", 10_000_000),
    realRunnerUid: positiveInteger(env.LECTORIA_REAL_RUNNER_UID, "LECTORIA_REAL_RUNNER_UID", 65532),
    realRunnerGid: positiveInteger(env.LECTORIA_REAL_RUNNER_GID, "LECTORIA_REAL_RUNNER_GID", 65532),
  });
}

export function assertHttpConfig(config) {
  if (!config || typeof config !== "object") throw new TypeError("HTTP config is required");
  if (!config.authToken) throw new Error("authenticated HTTP configuration is required");
  if (typeof config.adminPasswordFile !== "string" || !config.adminPasswordFile.startsWith("/") || config.adminPasswordFile === "/") throw new TypeError("adminPasswordFile must be an absolute non-root path");
  if (typeof config.sessionStoreFile !== "string" || !config.sessionStoreFile.startsWith("/") || config.sessionStoreFile === "/") throw new TypeError("sessionStoreFile must be an absolute non-root path");
  if (config.tls.certFile && !existsSync(config.tls.certFile)) throw new Error("TLS certificate file does not exist");
  if (config.tls.keyFile && !existsSync(config.tls.keyFile)) throw new Error("TLS key file does not exist");
  if (Boolean(config.tls.certFile) !== Boolean(config.tls.keyFile)) throw new Error("TLS certificate and key must be configured together");
  return config;
}
