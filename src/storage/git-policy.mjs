const PRIORITY = Object.freeze({ track: 0, "metadata-only": 1, never: 2 });

export function normalizeGitPolicies(entries) {
  const selected = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.documentId !== "string" || !(entry.policy in PRIORITY)) throw new TypeError("invalid Git policy");
    const current = selected.get(entry.documentId);
    if (!current || PRIORITY[entry.policy] > PRIORITY[current.policy]) selected.set(entry.documentId, { documentId: entry.documentId, policy: entry.policy });
  }
  return [...selected.values()].sort((a, b) => a.documentId.localeCompare(b.documentId));
}

export function generateGitIgnore(entries) {
  const lines = ["state/", "private/", "derived/", "staging/", "*.sqlite3", "*.sqlite3-wal", "*.sqlite3-shm", ".env", "*.secret"];
  for (const { documentId, policy } of normalizeGitPolicies(entries)) {
    if (policy === "never") lines.push(`documents/${documentId}/`);
    else if (policy === "metadata-only") lines.push(`documents/${documentId}/content/`);
  }
  return `${lines.join("\n")}\n`;
}
