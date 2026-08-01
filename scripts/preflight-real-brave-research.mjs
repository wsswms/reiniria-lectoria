import { stableJson } from "../src/domain/contracts.mjs";
import { loadRealBraveEvaluationManifest, preflightRealBraveEvaluation } from "../src/research/real-brave-evaluation.mjs";

if (process.env.BRAVE_REAL_SEARCH !== "1") throw new Error("real Brave Search requires BRAVE_REAL_SEARCH=1");
const credentialPath = process.env.BRAVE_KEY_FILE;
if (typeof credentialPath !== "string" || credentialPath.length === 0) throw new Error("BRAVE_KEY_FILE is required");
const manifest = await loadRealBraveEvaluationManifest();
process.stdout.write(`${stableJson(await preflightRealBraveEvaluation({ manifest, credentialPath }))}\n`);
