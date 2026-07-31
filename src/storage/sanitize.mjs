const SECRET_KEYS = new Set(["secret", "secrets", "apikey", "token", "accesstoken", "oauthtoken", "cookie", "authorization", "providerrequest", "providerresponse", "rawrequest", "rawresponse"]);

export function sanitizeRecord(value) {
  if (Array.isArray(value)) return value.map(sanitizeRecord);
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      output[key] = SECRET_KEYS.has(normalized) ? "[REDACTED]" : sanitizeRecord(child);
    }
    return output;
  }
  return value;
}
