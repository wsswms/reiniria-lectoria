import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateGitIgnore } from "../src/storage/git-policy.mjs";

const root = process.argv[2];
if (!root) throw new Error("fixture root is required");
const canary = "M2-GIT-SECRET-CANARY";
for (const path of ["documents/track/content", "documents/metadata/content", "documents/never/content", "private", "state", "derived", "staging"]) await mkdir(join(root, path), { recursive: true });
await writeFile(join(root, ".gitignore"), generateGitIgnore([{ documentId: "track", policy: "track" }, { documentId: "metadata", policy: "metadata-only" }, { documentId: "never", policy: "never" }]));
await writeFile(join(root, "documents/track/content/document.md"), "tracked");
await writeFile(join(root, "documents/track/metadata.json"), "{}");
await writeFile(join(root, "documents/metadata/content/document.md"), "ignored content");
await writeFile(join(root, "documents/metadata/metadata.json"), "{}");
await writeFile(join(root, "documents/never/content/document.md"), canary);
await writeFile(join(root, "documents/never/metadata.json"), canary);
for (const path of ["private/secret", "state/app.sqlite3", "derived/index", "staging/output"]) await writeFile(join(root, path), canary);
