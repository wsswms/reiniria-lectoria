import { createHash } from "node:crypto";
import { stableJson } from "../domain/contracts.mjs";
import { PARSER_VERSION } from "../document/parser.mjs";
import { VALIDATOR_VERSION } from "../translation/validator.mjs";

export const QUALITY_REGISTRY_VERSION = "lectoria-quality-registry-v1";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const BUILTIN_RULES = Object.freeze([
  ["builtin.duplicate-segment", "error", "DUPLICATE_SEGMENT"],
  ["builtin.unknown-segment", "error", "UNKNOWN_SEGMENT"],
  ["builtin.workflow-scope", "error", "WORKFLOW_MISMATCH"],
  ["builtin.source-revision", "error", "SOURCE_REVISION_MISMATCH"],
  ["builtin.target-language", "error", "TARGET_LANGUAGE_MISMATCH"],
  ["builtin.structure", "error", "STRUCTURE_MISMATCH"],
  ["builtin.empty-target", "error", "EMPTY_TARGET"],
  ["builtin.protected-value", "error", "PROTECTED_VALUE_MISMATCH"],
  ["builtin.missing-segment", "error", "MISSING_SEGMENT"],
  ["builtin.serialization-structure", "error", "SERIALIZATION_STRUCTURE_MISMATCH"],
  ["builtin.date", "warning", "DATE_VALUE_CHANGED"],
  ["builtin.unit", "warning", "UNIT_VALUE_CHANGED"],
  ["builtin.number", "warning", "NUMBER_VALUE_CHANGED"],
  ["builtin.target-equals-source", "info", "TARGET_EQUALS_SOURCE"],
].map(([ruleId, severity, validatorCode]) => Object.freeze({
  ruleId, ruleVersion: "1", severity, validatorCode, kind: "builtin", factId: null, factRevisionId: null,
})));

function applies(scope, workflow) {
  return (scope.targetLanguages.length === 0 || scope.targetLanguages.includes(workflow.targetLanguage))
    && (scope.documentIds.length === 0 || scope.documentIds.includes(workflow.documentId));
}

export class QualityRuleRegistry {
  constructor(database, trustedWorkspaceId, {
    registryVersion = QUALITY_REGISTRY_VERSION,
    parserVersion = PARSER_VERSION,
    validatorVersion = VALIDATOR_VERSION,
  } = {}) {
    this.database = database;
    this.workspaceId = trustedWorkspaceId;
    this.registryVersion = registryVersion;
    this.parserVersion = parserVersion;
    this.validatorVersion = validatorVersion;
  }

  build(workflow) {
    const rows = this.database.prepare(`
      SELECT fact.fact_id AS factId, fact.kind, revision.revision_id AS revisionId,
             revision.version AS revisionVersion, revision.language,
             revision.scope_json AS scopeJson, revision.content_json AS contentJson,
             revision.content_digest AS contentDigest, head.version AS headVersion
      FROM knowledge_facts AS fact
      JOIN knowledge_fact_heads AS head
        ON head.workspace_id = fact.workspace_id AND head.fact_id = fact.fact_id AND head.state = 'active'
      JOIN knowledge_fact_revisions AS revision
        ON revision.workspace_id = head.workspace_id AND revision.revision_id = head.revision_id
      WHERE fact.workspace_id = ? ORDER BY fact.fact_id
    `).all(this.workspaceId);
    const active = rows.map((row) => ({ ...row, scope: JSON.parse(row.scopeJson), content: JSON.parse(row.contentJson) }))
      .filter((row) => applies(row.scope, workflow));
    const dynamic = [];
    for (const fact of active) {
      if (fact.kind === "term") {
        const preferred = fact.content.preferredTranslations.filter((item) => item.language === workflow.targetLanguage).map((item) => item.text).sort();
        const forbidden = fact.content.forbiddenTranslations.filter((item) => item.language === workflow.targetLanguage).map((item) => item.text).sort();
        if (preferred.length > 0) dynamic.push({
          ruleId: `term.${fact.factId}.preferred`, ruleVersion: String(fact.revisionVersion), severity: "error", kind: "term-preferred",
          factId: fact.factId, factRevisionId: fact.revisionId, sourceTerms: [fact.content.term, ...fact.content.variants].sort(), values: preferred,
        });
        if (preferred.length > 0) dynamic.push({
          ruleId: `term.${fact.factId}.consistency`, ruleVersion: String(fact.revisionVersion), severity: "warning", kind: "term-consistency",
          factId: fact.factId, factRevisionId: fact.revisionId, sourceTerms: [fact.content.term, ...fact.content.variants].sort(), values: preferred,
        });
        if (forbidden.length > 0) dynamic.push({
          ruleId: `term.${fact.factId}.forbidden`, ruleVersion: String(fact.revisionVersion), severity: "error", kind: "term-forbidden",
          factId: fact.factId, factRevisionId: fact.revisionId, sourceTerms: [fact.content.term, ...fact.content.variants].sort(), values: forbidden,
        });
      } else if (fact.kind === "style") {
        if (fact.content.requiredPatterns.length > 0) dynamic.push({
          ruleId: `style.${fact.factId}.required`, ruleVersion: String(fact.revisionVersion), severity: fact.content.severity, kind: "style-required",
          factId: fact.factId, factRevisionId: fact.revisionId, values: [...fact.content.requiredPatterns].sort(),
        });
        if (fact.content.forbiddenPatterns.length > 0) dynamic.push({
          ruleId: `style.${fact.factId}.forbidden`, ruleVersion: String(fact.revisionVersion), severity: fact.content.severity, kind: "style-forbidden",
          factId: fact.factId, factRevisionId: fact.revisionId, values: [...fact.content.forbiddenPatterns].sort(),
        });
      }
    }
    const rules = Object.freeze([...BUILTIN_RULES, ...dynamic]
      .sort((left, right) => left.ruleId.localeCompare(right.ruleId))
      .map((rule) => Object.freeze(rule)));
    const heads = active.map((fact) => ({
      factId: fact.factId, revisionId: fact.revisionId, headVersion: fact.headVersion, contentDigest: fact.contentDigest,
    }));
    const factHeadsDigest = sha(stableJson(heads));
    const rulesDigest = sha(stableJson(rules));
    const identity = {
      registryVersion: this.registryVersion, rulesDigest, factHeadsDigest,
      parserVersion: this.parserVersion, validatorVersion: this.validatorVersion,
    };
    return Object.freeze({ ...identity, ruleSnapshotId: sha(stableJson(identity)), rules });
  }
}
