import { createHash } from "node:crypto";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { normalizeP1LitePayload, p1LiteCanonicalKey, summarizeP1LiteResult } from "../src/m5e/p1-lite.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex")}`;
async function privateBytes(path, maximum = 4 * 1024 * 1024) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > maximum) {
    throw new Error("P1-Lite analysis input is invalid");
  }
  return readFile(path);
}
const events = (bytes) => bytes.toString("utf8").trim().split("\n").map(JSON.parse);
const rawResponses = (bytes) => events(bytes).filter((event) => event?.event === "response").map((event) => ({ event,
  payload: JSON.parse(event.response.content) }));
const counts = (items, key) => Object.fromEntries([...new Set(items.map((item) => item[key]))].sort()
  .map((value) => [value, items.filter((item) => item[key] === value).length]));
const keyOf = (item) => JSON.stringify([item.kind, item.subject.normalize("NFKC").toLocaleLowerCase("und").trim().replace(/\s+/gu, " "), item.issue]);
function setComparison(leftItems, rightItems) {
  const left = new Set(leftItems.map(keyOf)); const right = new Set(rightItems.map(keyOf)); const intersection = [...left].filter((key) => right.has(key)).length;
  const union = new Set([...left, ...right]).size; return { intersection, union, jaccard: union === 0 ? 1 : intersection / union,
    leftOnly: [...left].filter((key) => !right.has(key)).sort(), rightOnly: [...right].filter((key) => !left.has(key)).sort() };
}
function rawDiagnostic(response, request) {
  const items = response.payload.items; const invalid = []; const identities = new Map(); const normalizedItems = [];
  for (const [index, item] of items.entries()) {
    try { normalizedItems.push(normalizeP1LitePayload({ items: [item] }, request).items[0]); } catch (error) { invalid.push({ index, message: error.message }); }
    const key = keyOf(item); identities.set(key, [...(identities.get(key) ?? []), index]);
  }
  const duplicates = [...identities.entries()].filter(([, indexes]) => indexes.length > 1).map(([key, indexes]) => ({ key, indexes }));
  return { itemCount: items.length, overLimitBy: Math.max(0, items.length - 96), individuallyInvalid: invalid, duplicateCanonicalIdentities: duplicates,
    uniqueCanonicalIdentities: identities.size, byKind: counts(items, "kind"), byIssue: counts(items, "issue"), byImpact: counts(items, "impact"),
    referencedLocalItems: new Set(normalizedItems.flatMap((item) => item.dependencies.localItemIndexes)).size,
    referencedSegments: new Set(normalizedItems.flatMap((item) => item.segmentIds)).size,
    usage: response.event.response.usage, elapsedMs: response.event.elapsedMs, contentDigest: sha(response.event.response.content), items };
}

const oldPart1 = events(await privateBytes(process.env.M5E_P1LITE_INPUT_ONE));
const oldPart2 = events(await privateBytes(process.env.M5E_P1LITE_INPUT_TWO));
const part1Request = JSON.parse(oldPart1.find((event) => event?.event === "request")?.request?.body?.messages?.[1]?.content ?? "null");
const part2Request = JSON.parse(oldPart2.find((event) => event?.event === "request")?.request?.body?.messages?.[1]?.content ?? "null");
const part1Disabled = JSON.parse((await privateBytes(process.env.M5E_P1LITE_PART1_DISABLED_ARTIFACT)).toString("utf8")).result;
const part1EnabledRaw = rawResponses(await privateBytes(process.env.M5E_P1LITE_PART1_ENABLED_AUDIT))[0];
const part1Enabled = normalizeP1LitePayload(part1EnabledRaw.payload, part1Request);
const part2Enabled = JSON.parse((await privateBytes(process.env.M5E_P1LITE_PART2_ENABLED_ARTIFACT)).toString("utf8")).result;
const disabledResponses = [...rawResponses(await privateBytes(process.env.M5E_P1LITE_PART2_DISABLED_FIRST_AUDIT)),
  ...rawResponses(await privateBytes(process.env.M5E_P1LITE_PART2_DISABLED_RETRY_AUDIT))];
const diagnostics = disabledResponses.map((response) => rawDiagnostic(response, part2Request));
const part1Comparison = (() => {
  const left = part1Disabled.items.map((item) => ({ kind: item.kind, subject: item.content.subject, issue: item.content.issue }));
  const right = part1Enabled.items.map((item) => ({ kind: item.kind, subject: item.content.subject, issue: item.content.issue })); return setComparison(left, right);
})();
const enabledRawItems = part2Enabled.items.map((item) => ({ kind: item.kind, subject: item.content.subject, issue: item.content.issue }));
const output = { schemaVersion: "m5e-p1-lite-thinking-analysis-v1", generatedAt: new Date().toISOString(), strictOutcome: {
  part1Disabled: "normalized", part1Enabled: "normalized", part2Enabled: "normalized", part2Disabled: "failed-three-responses-over-96-item-limit" },
  part1: { disabled: summarizeP1LiteResult(part1Disabled, part1Request), enabled: summarizeP1LiteResult(part1Enabled, part1Request), comparison: part1Comparison },
  part2: { enabled: summarizeP1LiteResult(part2Enabled, part2Request), disabledDiagnostics: diagnostics.map(({ items, ...value }) => value),
    comparisonsToEnabled: diagnostics.map((item) => setComparison(item.items, enabledRawItems)),
    disabledPairwise: diagnostics.flatMap((left, leftIndex) => diagnostics.slice(leftIndex + 1).map((right, offset) => ({ left: leftIndex + 1,
      right: leftIndex + offset + 2, ...setComparison(left.items, right.items) }))) },
  limits: { maximumItems: 96, cumulativeActualAttempts: 8, maximumActualAttempts: 8 },
  researchPerformed: false, translationPerformed: false, approvalPerformed: false };
const target = process.env.M5E_P1LITE_ANALYSIS_OUTPUT; await writeFile(target, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx", mode: 0o600 }); await chmod(target, 0o600);
process.stdout.write(`${JSON.stringify({ status: "analyzed", digest: sha(await readFile(target)), part1: { disabledItems: output.part1.disabled.outputItems,
  enabledItems: output.part1.enabled.outputItems, jaccard: output.part1.comparison.jaccard }, part2: { enabledItems: output.part2.enabled.outputItems,
  disabledItemCounts: output.part2.disabledDiagnostics.map((item) => item.itemCount), individuallyInvalid: output.part2.disabledDiagnostics.map((item) => item.individuallyInvalid.length),
  duplicates: output.part2.disabledDiagnostics.map((item) => item.duplicateCanonicalIdentities.length), jaccardToEnabled: output.part2.comparisonsToEnabled.map((item) => item.jaccard),
  disabledPairwiseJaccard: output.part2.disabledPairwise.map((item) => item.jaccard) } })}\n`);
