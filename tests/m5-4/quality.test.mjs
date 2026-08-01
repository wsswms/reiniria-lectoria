import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stableJson } from "../../src/domain/contracts.mjs";
import { ExportService } from "../../src/export/export-service.mjs";
import { QualityService } from "../../src/quality/quality-service.mjs";
import { ReviewConflictError, ReviewService } from "../../src/translation/review-service.mjs";
import { addCandidate, changedRegistry, fixtureActor, goodText, qualityWorkspace, select, userActor } from "./helpers.mjs";

test("schema v17 stores immutable traceable quality snapshots", async () => {
  const setup = await qualityWorkspace();
  try {
    assert.equal(setup.fixture.database.pragma("user_version", { simple: true }), 17);
    const candidate = addCandidate(setup, "请使用工作空间。");
    const run = setup.quality.runCandidate(setup.workflow.workflowId, setup.workflow.segments[0].segmentId, candidate.candidateId);
    assert.ok(run.findings.some((item) => item.ruleId.endsWith("preferred") && item.severity === "error"));
    assert.ok(run.findings.some((item) => item.ruleId.endsWith("forbidden") && item.severity === "error"));
    for (const finding of run.findings) {
      assert.match(finding.findingId, /^sha256:[0-9a-f]{64}$/);
      assert.ok(finding.ruleId && finding.ruleVersion && finding.subjectRevisionId);
      assert.match(finding.evidenceDigest, /^sha256:[0-9a-f]{64}$/);
      assert.equal(finding.factId === null, finding.factRevisionId === null);
    }
    assert.throws(() => setup.fixture.database.prepare("UPDATE quality_runs SET subject_id = 'x'").run(), /immutable/);
    assert.throws(() => setup.fixture.database.prepare("DELETE FROM quality_findings").run(), /immutable/);
  } finally { await setup.fixture.close(); }
});

test("quality mutation matrix classifies at least 300 term style protected number date and unit variants", async () => {
  const setup = await qualityWorkspace();
  try {
    const variants = [
      "请使用工作空间。",
      "您可以使用工作区。",
      "请使用工作区，在 2026-01-03 搬运 21 kg，并访问 https://example.com。",
      "请使用工作区，在今日搬运货物，并访问 https://invalid.example/。",
      setup.workflow.segments[0].sourceText,
    ];
    let findings = 0;
    let expectedErrors = 0;
    for (let index = 0; index < 300; index += 1) {
      const candidate = addCandidate(setup, index % variants.length === 4 ? variants[4] : `${variants[index % variants.length]} ${index}`);
      const run = setup.quality.runCandidate(setup.workflow.workflowId, setup.workflow.segments[0].segmentId, candidate.candidateId);
      findings += run.findings.length;
      if ([0, 3].includes(index % variants.length)) {
        expectedErrors += 1;
        assert.ok(run.findings.some((item) => item.severity === "error"));
      }
      if (index % variants.length === 1) assert.ok(run.findings.some((item) => item.severity === "warning" && item.ruleId.includes("style")));
      if (index % variants.length === 4) assert.ok(run.findings.some((item) => item.severity === "info"));
    }
    assert.ok(findings >= 300);
    assert.equal(expectedErrors, 120);
  } finally { await setup.fixture.close(); }
});

test("quality runs and comparisons are byte deterministic with candidate-id tie breaks and no mutation", async () => {
  const setup = await qualityWorkspace();
  try {
    const first = addCandidate(setup, goodText(setup));
    const second = addCandidate(setup, goodText(setup));
    const beforeBundle = stableJson(setup.fixture.workCopies.getBundle(setup.workflow.workflowId));
    const beforeCandidates = stableJson(setup.fixture.workCopies.listCandidates(setup.workflow.workflowId, setup.workflow.segments[0].segmentId));
    const runs = Array.from({ length: 20 }, () => setup.quality.runCandidate(setup.workflow.workflowId, setup.workflow.segments[0].segmentId, first.candidateId));
    assert.equal(new Set(runs.map(stableJson)).size, 1);
    const comparisons = Array.from({ length: 20 }, () => setup.quality.compare(setup.workflow.workflowId, setup.workflow.segments[0].segmentId, [second.candidateId, first.candidateId]));
    assert.equal(new Set(comparisons.map(stableJson)).size, 1);
    assert.deepEqual(comparisons[0].members.map((item) => item.candidateId), [first.candidateId, second.candidateId].sort());
    assert.equal(stableJson(setup.fixture.workCopies.getBundle(setup.workflow.workflowId)), beforeBundle);
    assert.equal(stableJson(setup.fixture.workCopies.listCandidates(setup.workflow.workflowId, setup.workflow.segments[0].segmentId)), beforeCandidates);
    addCandidate(setup, "新增候选");
    assert.equal(setup.quality.getComparison(comparisons[0].comparisonId).current, false);
  } finally { await setup.fixture.close(); }
});

test("working quality gates review and only users may select confirm review or approve", async () => {
  const setup = await qualityWorkspace();
  try {
    const candidate = addCandidate(setup, goodText(setup));
    for (const type of ["system", "fixture", "provider", "runner"]) {
      for (let repeat = 0; repeat < 50; repeat += 1) {
        assert.throws(() => setup.fixture.workCopies.selectCandidate(setup.workflow.workflowId, setup.workflow.segments[0].segmentId,
          candidate.candidateId, null, { type, id: `${type}-${repeat}` }), /only a user/);
      }
    }
    select(setup, candidate);
    const run = setup.quality.runWorking(setup.workflow.workflowId);
    assert.equal(run.validationRunId !== null, true);
    assert.equal(run.findings.some((item) => item.severity === "error"), false);
    for (const type of ["system", "fixture", "provider", "runner"]) {
      for (let repeat = 0; repeat < 50; repeat += 1) {
        assert.throws(() => setup.reviews.humanReview(setup.workflow.workflowId, run.validationRunId, 0,
          { type, id: `${type}-${repeat}` }, run.qualityRunId), ReviewConflictError);
      }
    }
    const reviewed = setup.reviews.humanReview(setup.workflow.workflowId, run.validationRunId, 0, userActor, run.qualityRunId);
    assert.equal(reviewed.state, "human-reviewed");
    for (const type of ["system", "fixture", "provider", "runner"]) {
      for (let repeat = 0; repeat < 50; repeat += 1) {
        assert.throws(() => setup.reviews.approve(setup.workflow.workflowId, run.validationRunId, 1,
          { type, id: `${type}-${repeat}` }, run.qualityRunId), ReviewConflictError);
      }
    }
    assert.equal(setup.reviews.approve(setup.workflow.workflowId, run.validationRunId, 1, userActor, run.qualityRunId).state, "approved-for-export");
  } finally { await setup.fixture.close(); }
});

test("quality warnings require explicit user confirmation", async () => {
  const setup = await qualityWorkspace();
  try {
    const candidate = addCandidate(setup, `您可以使用工作区，在 2026-01-02 搬运 20 kg，并访问 ${setup.workflow.segments[0].protected[0].marker}。`);
    select(setup, candidate);
    const run = setup.quality.runWorking(setup.workflow.workflowId);
    const warning = run.findings.find((item) => item.severity === "warning" && item.ruleId.includes("style"));
    assert.ok(warning);
    assert.throws(() => setup.reviews.humanReview(setup.workflow.workflowId, run.validationRunId, 0, userActor, run.qualityRunId), /quality/);
    for (const type of ["system", "fixture", "provider", "runner"]) {
      for (let repeat = 0; repeat < 50; repeat += 1) assert.throws(() => setup.quality.confirmWarning(
        setup.workflow.workflowId, run.qualityRunId, warning.findingId, { type, id: `${type}-${repeat}` }), /only a user/);
    }
    setup.quality.confirmWarning(setup.workflow.workflowId, run.qualityRunId, warning.findingId, userActor);
    assert.equal(setup.reviews.humanReview(setup.workflow.workflowId, run.validationRunId, 0, userActor, run.qualityRunId).state, "human-reviewed");
  } finally { await setup.fixture.close(); }
});

test("export requires the same current quality run that the user approved", async () => {
  const setup = await qualityWorkspace();
  try {
    const candidate = addCandidate(setup, goodText(setup));
    select(setup, candidate);
    const run = setup.quality.runWorking(setup.workflow.workflowId);
    setup.reviews.humanReview(setup.workflow.workflowId, run.validationRunId, 0, userActor, run.qualityRunId);
    setup.reviews.approve(setup.workflow.workflowId, run.validationRunId, 1, userActor, run.qualityRunId);
    const exports = new ExportService({
      database: setup.fixture.database, root: setup.fixture.root, trustedWorkspaceId: setup.fixture.workspaceId,
      now: () => new Date(0), workCopies: setup.fixture.workCopies, validation: setup.fixture.validation, quality: setup.quality,
    });
    await assert.rejects(exports.export(setup.workflow.workflowId, run.validationRunId, "markdown"), /quality/);
    await assert.rejects(exports.export(setup.workflow.workflowId, run.validationRunId, "markdown", `sha256:${"0".repeat(64)}`), /quality/);
    const result = await exports.export(setup.workflow.workflowId, run.validationRunId, "markdown", run.qualityRunId);
    assert.match(result.contentDigest, /^sha256:[0-9a-f]{64}$/);
  } finally { await setup.fixture.close(); }
});

test("fact rule working-copy parser and validator changes make old quality results stale", async () => {
  const cases = await Promise.all(Array.from({ length: 4 }, () => qualityWorkspace()));
  try {
    const [factCase, workingCase, parserCase, validatorCase] = cases;
    const factCandidate = addCandidate(factCase, goodText(factCase));
    const factRun = factCase.quality.runCandidate(factCase.workflow.workflowId, factCase.workflow.segments[0].segmentId, factCandidate.candidateId);
    factCase.facts.setActive(factCase.term.factId, 0, false, fixtureActor);
    assert.deepEqual(factCase.quality.currentStatus(factRun.qualityRunId), { current: false, reason: "rule-or-fact" });

    const workingCandidate = addCandidate(workingCase, goodText(workingCase));
    const head = select(workingCase, workingCandidate);
    const workingRun = workingCase.quality.runWorking(workingCase.workflow.workflowId);
    workingCase.fixture.workCopies.edit(workingCase.workflow.workflowId, workingCase.workflow.segments[0].segmentId, head.version, `${goodText(workingCase)} 已编辑`, userActor);
    assert.deepEqual(workingCase.quality.currentStatus(workingRun.qualityRunId), { current: false, reason: "working-copy" });

    const parserCandidate = addCandidate(parserCase, goodText(parserCase));
    const parserRun = parserCase.quality.runCandidate(parserCase.workflow.workflowId, parserCase.workflow.segments[0].segmentId, parserCandidate.candidateId);
    const parserChanged = new QualityService(parserCase.fixture.database, parserCase.fixture.workspaceId, {
      workCopies: parserCase.fixture.workCopies, validation: parserCase.fixture.validation,
      registry: changedRegistry(parserCase, { parserVersion: "parser-changed" }),
    });
    assert.deepEqual(parserChanged.currentStatus(parserRun.qualityRunId), { current: false, reason: "rule-or-fact" });

    const validatorCandidate = addCandidate(validatorCase, goodText(validatorCase));
    const validatorRun = validatorCase.quality.runCandidate(validatorCase.workflow.workflowId, validatorCase.workflow.segments[0].segmentId, validatorCandidate.candidateId);
    const validatorChanged = new QualityService(validatorCase.fixture.database, validatorCase.fixture.workspaceId, {
      workCopies: validatorCase.fixture.workCopies, validation: validatorCase.fixture.validation,
      registry: changedRegistry(validatorCase, { validatorVersion: "validator-changed" }),
    });
    assert.deepEqual(validatorChanged.currentStatus(validatorRun.qualityRunId), { current: false, reason: "rule-or-fact" });
  } finally { for (const setup of cases) await setup.fixture.close(); }
});

test("cross-workspace workflow segment candidate and quality references are rejected 200 times each", async () => {
  const first = await qualityWorkspace();
  const second = await qualityWorkspace();
  try {
    const candidate = addCandidate(first, goodText(first));
    const run = first.quality.runCandidate(first.workflow.workflowId, first.workflow.segments[0].segmentId, candidate.candidateId);
    for (let repeat = 0; repeat < 200; repeat += 1) {
      assert.throws(() => second.quality.get(run.qualityRunId), /not found/);
      assert.throws(() => first.quality.runCandidate(randomUUID(), first.workflow.segments[0].segmentId, candidate.candidateId), /workflow not found/);
      assert.throws(() => first.quality.runCandidate(first.workflow.workflowId, randomUUID(), candidate.candidateId), /segment not found/);
      assert.throws(() => second.quality.runCandidate(second.workflow.workflowId, second.workflow.segments[0].segmentId, candidate.candidateId), /candidate not found/);
    }
  } finally { await first.fixture.close(); await second.fixture.close(); }
});

test("no-fact mode degrades explicitly while validator edit review path remains available", async () => {
  const setup = await qualityWorkspace({ facts: false });
  try {
    const candidate = addCandidate(setup, goodText(setup));
    select(setup, candidate);
    const run = setup.quality.runWorking(setup.workflow.workflowId);
    assert.equal(run.findings.some((item) => item.factRevisionId), false);
    assert.equal(run.current, true);
    const rules = JSON.parse(setup.fixture.database.prepare("SELECT rules_json AS rulesJson FROM quality_rule_snapshots WHERE workspace_id = ? AND rule_snapshot_id = ?")
      .get(setup.fixture.workspaceId, run.ruleSnapshotId).rulesJson);
    assert.equal(rules.some((rule) => rule.factRevisionId), false);
    assert.ok(rules.some((rule) => rule.ruleId === "builtin.protected-value"));
  } finally { await setup.fixture.close(); }
});
