import { existsSync } from "node:fs";

function positiveInteger(value, name, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}

export function loadHttpConfig(env = process.env) {
  const token = env.LECTORIA_AUTH_TOKEN ?? "";
  if (!token) throw new Error("LECTORIA_AUTH_TOKEN is required; all application functions require login");
  const dataRoot = env.LECTORIA_DATA_ROOT ?? "/var/lib/lectoria";
  if (!dataRoot.startsWith("/") || dataRoot === "/") throw new TypeError("LECTORIA_DATA_ROOT must be an absolute non-root path");
  const allowedOrigins = (env.LECTORIA_ALLOWED_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return Object.freeze({
    host: env.LECTORIA_HOST ?? "127.0.0.1",
    port: positiveInteger(env.LECTORIA_PORT, "LECTORIA_PORT", 8787),
    maxBodyBytes: positiveInteger(env.LECTORIA_MAX_BODY_BYTES, "LECTORIA_MAX_BODY_BYTES", 4 * 1024 * 1024),
    dataRoot,
    authToken: token,
    allowedOrigins,
    tls: Object.freeze({
      certFile: env.LECTORIA_TLS_CERT_FILE ?? null,
      keyFile: env.LECTORIA_TLS_KEY_FILE ?? null,
    }),
  });
}

export function assertHttpConfig(config) {
  if (!config || typeof config !== "object") throw new TypeError("HTTP config is required");
  if (!config.authToken) throw new Error("authenticated HTTP configuration is required");
  if (config.tls.certFile && !existsSync(config.tls.certFile)) throw new Error("TLS certificate file does not exist");
  if (config.tls.keyFile && !existsSync(config.tls.keyFile)) throw new Error("TLS key file does not exist");
  if (Boolean(config.tls.certFile) !== Boolean(config.tls.keyFile)) throw new Error("TLS certificate and key must be configured together");
  return config;
}
