import { randomUUID } from "node:crypto";
import { KnowledgeFactService } from "../../src/knowledge/fact-service.mjs";
import { QualityService } from "../../src/quality/quality-service.mjs";
import { QualityRuleRegistry } from "../../src/quality/rule-registry.mjs";
import { ReviewService } from "../../src/translation/review-service.mjs";
import { createEditableWorkflow, workspace } from "../m3-4/helpers.mjs";
import { styleInput, termInput } from "../m5-1/helpers.mjs";

export const fixtureActor = Object.freeze({ type: "fixture", id: "m5-4-fixture" });
export const userActor = Object.freeze({ type: "user", id: "m5-4-user" });

export async function qualityWorkspace({ facts = true } = {}) {
  const fixture = await workspace("lectoria-m5-4-");
  const workflow = await createEditableWorkflow(fixture, {
    content: "Use workspace safely with 20 kg on 2026-01-02 at [site](https://example.com).",
    targetLanguage: "zh-CN",
  });
  const factService = new KnowledgeFactService(fixture.root, fixture.database, fixture.workspaceId, { now: () => new Date(0) });
  let term = null;
  let style = null;
  if (facts) {
    term = termInput({
      language: "en",
      scope: { targetLanguages: ["zh-CN"], tags: [], documentIds: [workflow.documentId] },
      content: {
        term: "workspace", preferredTranslations: [{ language: "zh-CN", text: "工作区" }],
        forbiddenTranslations: [{ language: "zh-CN", text: "工作空间" }], variants: [], note: "fixed term",
      },
    });
    style = styleInput({
      language: "zh-CN",
      scope: { targetLanguages: ["zh-CN"], tags: [], documentIds: [workflow.documentId] },
      content: { title: "直接语气", description: "不要使用敬语", severity: "warning", forbiddenPatterns: ["您可以"], requiredPatterns: [] },
    });
    await factService.create(term, fixtureActor);
    await factService.create(style, fixtureActor);
  }
  const quality = new QualityService(fixture.database, fixture.workspaceId, {
    now: () => new Date(0), workCopies: fixture.workCopies, validation: fixture.validation,
  });
  const reviews = new ReviewService(fixture.database, fixture.workspaceId, {
    now: () => new Date(0), validation: fixture.validation, quality,
  });
  return { fixture, workflow, facts: factService, term, style, quality, reviews };
}

export function addCandidate(setup, text) {
  return setup.fixture.workCopies.addCandidate(setup.workflow.workflowId, setup.workflow.segments[0].segmentId, text, fixtureActor);
}

export function select(setup, candidate, expectedHeadVersion = null) {
  return setup.fixture.workCopies.selectCandidate(setup.workflow.workflowId, setup.workflow.segments[0].segmentId,
    candidate.candidateId, expectedHeadVersion, userActor);
}

export function changedRegistry(setup, overrides) {
  return new QualityRuleRegistry(setup.fixture.database, setup.fixture.workspaceId, overrides);
}

export const goodText = (setup) => {
  const markers = setup.workflow.segments[0].protected.map((item) => item.marker).join(" ");
  return `请安全使用工作区，在 2026-01-02 搬运 20 kg，并访问 ${markers}。`;
};
export const randomId = () => randomUUID();
