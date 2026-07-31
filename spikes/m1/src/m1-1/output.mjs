const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export function sanitizeOutput(value, maxBytes) {
  let text;
  if (value instanceof Uint8Array) {
    text = strictDecoder.decode(value);
  } else {
    text = String(value);
  }
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  const suffix = "…[truncated]";
  const suffixBytes = encoder.encode(suffix);
  const budget = Math.max(0, maxBytes - suffixBytes.length);
  let end = budget;
  while (end > 0) {
    try {
      const prefix = strictDecoder.decode(bytes.slice(0, end));
      return { text: `${prefix}${suffix}`, truncated: true };
    } catch {
      end -= 1;
    }
  }
  return { text: suffix.slice(0, maxBytes), truncated: true };
}
