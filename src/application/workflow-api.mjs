export class WorkflowApi {
  constructor({ imports, reimports, flowPlans, planner = null, contexts = null, translationExecutor = null, m5cQa = null, modelQa = null, remediation = null, recovery = null, disposition = null, research = null, workCopies, validation, reviews, exports,
    retriever = null, integrity = null }) {
    this.imports = imports;
    this.reimports = reimports;
    this.flowPlans = flowPlans;
    this.planner = planner;
    this.contexts = contexts;
    this.translationExecutor = translationExecutor;
    this.m5cQa = m5cQa;
    this.modelQa = modelQa;
    this.remediation = remediation;
    this.recovery = recovery;
    this.disposition = disposition;
    this.research = research;
    this.workCopies = workCopies;
    this.validation = validation;
    this.reviews = reviews;
    this.exports = exports;
    this.retriever = retriever;
    this.integrity = integrity;
  }

  execute(command, payload) {
    switch (command) {
      case "document:import": return this.imports.import({ format: payload.format, content: payload.content, title: payload.title });
      case "document:get": return this.imports.get(payload.importId);
      case "document:confirm": return this.imports.confirm(payload.importId, payload.actor);
      case "reimport:prepare": return this.reimports.prepare({
        documentId: payload.documentId,
        baseRevisionId: payload.baseRevisionId,
        format: payload.format,
        content: payload.content,
      });
      case "reimport:get": return this.reimports.get(payload.operationId);
      case "reimport:confirm-alignment": return this.reimports.confirmAlignment(payload.operationId, payload.expectedVersion, payload.ordinal, payload.confirmedSegmentId, payload.actor);
      case "reimport:confirm-semantic": return this.reimports.confirmSemanticUnchanged(payload.operationId, payload.expectedVersion, payload.ordinal, payload.actor);
      case "reimport:finalize": return this.reimports.finalize(payload.operationId, payload.expectedVersion);
      case "workflow:create": {
        const imported = this.imports.get(payload.importId);
        if (!imported.confirmed) throw new TypeError("a confirmed document import is required");
        if (!this.flowPlans || typeof this.flowPlans.create !== "function") throw new TypeError("M5C flow service is required");
        return this.flowPlans.create({
          workflowId: payload.workflowId,
          documentId: imported.documentId,
          sourceRevisionId: imported.sourceRevisionId,
          targetLanguage: payload.targetLanguage,
          plannerEnabled: payload.plannerEnabled ?? true,
          ...(payload.budget === undefined ? {} : { budget: payload.budget }),
        }, payload.actor);
      }
      case "workflow:get": return this.flowPlans.get(payload.workflowId);
      case "plan:revise": return this.flowPlans.revisePlan(payload.workflowId, payload.expectedVersion, payload.plan, payload.actor);
      case "plan:assist": return this.planner.execute(payload.workflowId, payload.request);
      case "plan:submit": return this.flowPlans.submitPlan(payload.workflowId, payload.expectedVersion, payload.actor);
      case "plan:decide": return this.flowPlans.decidePlan(payload.workflowId, payload.expectedVersion, payload.decision, payload.actor);
      case "guidance:propose": return this.flowPlans.proposeGuidance(payload.workflowId, payload.rawText, payload.interpretation, payload.actor);
      case "guidance:interpret": return this.flowPlans.interpretGuidance(payload.workflowId, payload.rawText, payload.scopeHint ?? {}, payload.actor);
      case "guidance:get": return this.flowPlans.getGuidance(payload.guidanceId);
      case "guidance:decide": return this.flowPlans.decideGuidance(payload.guidanceId, payload.expectedVersion, payload.decision, payload.actor);
      case "context:assemble": return this.contexts.assemble(payload.workflowId, { guidanceIds: payload.guidanceIds ?? [], researchClaimIds: payload.researchClaimIds ?? [] }, payload.actor);
      case "context:get": return this.contexts.get(payload.workflowId);
      case "context:decide": return this.contexts.decide(payload.workflowId, payload.expectedVersion, payload.decision, payload.actor);
      case "translation:enqueue": return this.contexts.enqueueTranslation(payload.workflowId, payload.request);
      case "translation:task-get": return this.contexts.tasks.getTask(payload.taskId);
      case "translation:run-next": {
        if (!this.translationExecutor) throw new TypeError("translation executor is unavailable");
        return this.translationExecutor.executeNext();
      }
      case "qa:run": {
        const options = payload.options ?? {};
        if (options.modelFindings !== undefined || options.layers?.includes("model")) throw new TypeError("model QA must use the controlled model QA executor");
        return this.m5cQa.run(payload.workflowId, options);
      }
      case "qa:run-model": return this.modelQa.execute(payload.workflowId, payload.request);
      case "qa:get": return this.m5cQa.get(payload.qaRunId);
      case "qa:decide": return this.m5cQa.decideFinding(payload.qaRunId, payload.findingId, payload.decision, payload.actor);
      case "qa:retranslate": return this.remediation.retranslate(payload.qaRunId, payload.findingIds, payload.request, payload.actor);
      case "flow:resolve": return this.recovery.resolve(payload.workflowId, payload.expectedVersion, payload.action, payload.request ?? null, payload.actor);
      case "research:propose": return this.research.propose(payload.workflowId, payload.request, payload.actor);
      case "research:submit": return this.research.submit(payload.requestId, payload.expectedVersion, payload.actor);
      case "research:decide": return this.research.decide(payload.requestId, payload.expectedVersion, payload.decision, payload.actor);
      case "research:grant": return this.research.issueGrant(payload.requestId, payload.grant, payload.actor);
      case "research:run-create": return this.research.createRun(payload.requestId, payload.requestDigest, payload.actor);
      case "research:run-start": return this.research.startRun(payload.requestId, payload.runId, payload.actor);
      case "research:run-get": return this.research.getRun(payload.requestId, payload.runId);
      case "research:run-retry-unknown": return this.research.retryUnknownRun(payload.requestId, payload.runId, payload.actor);
      case "disposition:decide": return this.disposition.decide(payload.workflowId, payload.selections, payload.actor);
      case "disposition:get": return this.disposition.get(payload.workflowId);
      case "disposition:decide-proposal": return this.disposition.decideProposal(payload.proposalId, payload.decision, payload.actor);
      case "disposition:apply-proposal": return this.disposition.applyProposal(payload.proposalId, payload.actor);
      case "candidate:list": return this.workCopies.listCandidates(payload.workflowId, payload.segmentId);
      case "candidate:select": return this.workCopies.selectCandidate(payload.workflowId, payload.segmentId, payload.candidateId, payload.expectedHeadVersion, payload.actor);
      case "working-copy:edit": return this.workCopies.edit(payload.workflowId, payload.segmentId, payload.expectedHeadVersion, payload.text, payload.actor);
      case "working-copy:get": return this.workCopies.getBundle(payload.workflowId);
      case "validate": return this.validation.run(payload.workflowId);
      case "validation:get": return this.validation.get(payload.validationRunId);
      case "warning:confirm": return this.reviews.confirmWarning(payload.workflowId, payload.validationRunId, payload.findingId, payload.actor);
      case "review": return this.reviews.humanReview(payload.workflowId, payload.validationRunId, payload.expectedWorkflowVersion, payload.actor, payload.qualityRunId ?? null);
      case "approve": return this.reviews.approve(payload.workflowId, payload.validationRunId, payload.expectedWorkflowVersion, payload.actor, payload.qualityRunId ?? null);
      case "review:list": return this.reviews.getEvents(payload.workflowId);
      case "export": return this.exports.export(payload.workflowId, payload.validationRunId, payload.format, payload.qualityRunId ?? null);
      case "knowledge:rebuild": return this.retriever.rebuild();
      case "knowledge:search": return this.retriever.search(payload.request);
      case "knowledge:diagnose": return this.integrity.diagnose();
      case "knowledge:repair-derived": return this.integrity.repairDerived();
      default: throw new TypeError("unknown workflow command");
    }
  }
}
