const BLOCKERS = Object.freeze([
  ["isolatedModules", "module-isolation"], ["clusterTestsPassed", "cluster-tests"], ["coordinatorTestsPassed", "coordinator-tests"],
  ["persistenceProbePassed", "persistence-probe"], ["historicalReferenceSeedReady", "historical-reference-seed"],
  ["referenceFamiliesFrozen", "reference-families"], ["blindProtocolPassed", "blind-protocol"],
  ["articleInputsReady", "article-inputs"], ["fullRegressionPassed", "full-regression"], ["secretsReady", "secrets"],
]);

export function buildM5EPreflight(input) {
  if (!input || input.branch !== "exp-m5e-knowledge-effect") throw new TypeError("M5E must run from the isolated experiment branch");
  const limits = input.limits;
  if (!limits || limits.deepSeekAttempts > 310 || limits.deepSeekCostCny > 20 || limits.braveCalls > 50
    || limits.braveCostUsd > 0.25 || limits.fetchUrls > 30) throw new TypeError("M5E resource hard limit exceeded");
  if (input.auditDirectoryMode !== "0700" || input.auditFileMode !== "0600") throw new TypeError("M5E audit permissions are invalid");
  if (Number.isNaN(Date.parse(input.pricingCheckedAt))) throw new TypeError("M5E pricing check is invalid");
  const blockers = BLOCKERS.filter(([field]) => input[field] !== true).map(([, code]) => code);
  const value = { schemaVersion: "m5e-real-resource-preflight-v1", status: blockers.length === 0 ? "ready" : "closed",
    blockers: Object.freeze(blockers), branch: input.branch, limits: Object.freeze({ ...limits }), pricingCheckedAt: new Date(input.pricingCheckedAt).toISOString(),
    realCallsAuthorized: blockers.length === 0 };
  return Object.freeze(value);
}
