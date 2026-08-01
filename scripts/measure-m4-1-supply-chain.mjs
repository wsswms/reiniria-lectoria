import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const lockBytes = await readFile(new URL("package-lock.json", root));
const lock = JSON.parse(lockBytes);
const packages = Object.entries(lock.packages).filter(([path]) => path.startsWith("node_modules/"));
const licenses = [...new Set(packages.flatMap(([, metadata]) => {
  if (Array.isArray(metadata.license)) return metadata.license;
  return metadata.license ? [metadata.license] : [];
}))].sort();

const installedScripts = [];
for (const [path, metadata] of packages) {
  if (!metadata.hasInstallScript) continue;
  const manifest = JSON.parse(await readFile(new URL(`${path}/package.json`, root)));
  installedScripts.push({
    name: manifest.name,
    version: manifest.version,
    scripts: Object.fromEntries(Object.entries(manifest.scripts ?? {}).filter(([name]) => ["preinstall", "install", "postinstall"].includes(name))),
  });
}

const piCore = JSON.parse(await readFile(new URL("node_modules/@earendil-works/pi-agent-core/package.json", root)));
const piAi = JSON.parse(await readFile(new URL("node_modules/@earendil-works/pi-ai/package.json", root)));
const coreEntries = await readdir(new URL("node_modules/@earendil-works/pi-agent-core/dist", root));

process.stdout.write(`${JSON.stringify({
  stage: "M4.1",
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  packageLockSha256: createHash("sha256").update(lockBytes).digest("hex"),
  installedProductionPackages: packages.length,
  licenses,
  installScripts: installedScripts,
  selectedPiRuntime: {
    agentCore: { version: piCore.version, license: piCore.license, engines: piCore.engines, exports: piCore.exports },
    ai: { version: piAi.version, license: piAi.license, engines: piAi.engines, exports: piAi.exports },
    requiredCoreArtifactsPresent: ["agent.js", "agent-loop.js", "index.js"].every((name) => coreEntries.includes(name)),
  },
  excludedDependency: {
    name: "@earendil-works/pi-coding-agent",
    versionReviewed: "0.83.0",
    reason: "published shrinkwrap retains brace-expansion 5.0.7 affected by GHSA-mh99-v99m-4gvg; the narrower agent-core API satisfies the Runner boundary",
  },
  installation: "npm ci --ignore-scripts; better-sqlite3 rebuilt explicitly from source",
}, null, 2)}\n`);
