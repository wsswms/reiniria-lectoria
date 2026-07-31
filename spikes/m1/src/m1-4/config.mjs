import { createSecureContext } from "node:tls";
import net from "node:net";

const modes = new Set(["http", "https-direct", "https-proxy"]);

export function validateListenerConfig(config) {
  if (!modes.has(config.mode)) throw new Error("invalid listener mode");
  if (!net.isIP(config.bindAddress) || ["0.0.0.0", "::"].includes(config.bindAddress)) {
    throw new Error("bindAddress must be one explicit IP address");
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error("invalid port");
  }
  if (!Array.isArray(config.allowedHosts) || config.allowedHosts.length === 0) {
    throw new Error("at least one allowed Host is required");
  }
  if (!Array.isArray(config.allowedOrigins) || config.allowedOrigins.length === 0) {
    throw new Error("at least one allowed Origin is required");
  }
  if (config.mode === "https-direct") {
    if (!config.cert || !config.key) throw new Error("certificate and key are required");
    createSecureContext({ cert: config.cert, key: config.key });
  }
  if (config.mode === "https-proxy" && (!Array.isArray(config.trustedProxies) || config.trustedProxies.length === 0)) {
    throw new Error("trusted proxy list is required");
  }
  return Object.freeze({ ...config });
}

export class ListenerConfigManager {
  constructor(initialConfig) {
    this.current = validateListenerConfig(initialConfig);
  }

  apply(candidate) {
    try {
      const next = validateListenerConfig(candidate);
      this.current = next;
      return { applied: true, config: next };
    } catch (error) {
      return { applied: false, config: this.current, error: error.message };
    }
  }
}
