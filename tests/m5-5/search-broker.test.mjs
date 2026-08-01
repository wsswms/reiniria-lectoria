import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { searchWithCredentialFile } from "../../src/search/credential-file.mjs";
import { secretCanary } from "./helpers.mjs";

const entry = new URL("./search-broker-fixture.mjs", import.meta.url);
const request = Object.freeze({ query: "public fixture", count: 1, country: "US", searchLanguage: "en" });

test("independent Search Broker receives Brave credential only through fd 3", async () => {
  const root = await mkdtemp(join(tmpdir(), "lectoria-search-broker-"));
  const credentialPath = join(root, "brave.key");
  try {
    await writeFile(credentialPath, `${secretCanary}\n`, { mode: 0o600 });
    for (let repeat = 0; repeat < 20; repeat += 1) {
      const response = await searchWithCredentialFile({ credentialPath, request,
        credentialRef: "external-file:brave-search/m5" }, { entry });
      assert.equal(response.adapterId, "brave-search");
      assert.equal(JSON.stringify(response).includes(secretCanary), false);
      assert.equal(process.argv.join(" ").includes(secretCanary), false);
      assert.equal(JSON.stringify(process.env).includes(secretCanary), false);
    }
    await chmod(credentialPath, 0o644);
    await assert.rejects(searchWithCredentialFile({ credentialPath, request,
      credentialRef: "external-file:brave-search/m5" }, { entry }), /permissions/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
