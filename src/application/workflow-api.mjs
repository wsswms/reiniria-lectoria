export class WorkflowApi {
  constructor({ imports, reimports, states, workCopies, validation, reviews, exports }) {
    this.imports = imports;
    this.reimports = reimports;
    this.states = states;
    this.workCopies = workCopies;
    this.validation = validation;
    this.reviews = reviews;
    this.exports = exports;
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
        return this.states.create({
          workflowId: payload.workflowId,
          documentId: imported.documentId,
          sourceRevisionId: imported.sourceRevisionId,
          targetLanguage: payload.targetLanguage,
        }, {}, "editing");
      }
      case "workflow:get": return this.states.get(payload.workflowId);
      case "candidate:add": return this.workCopies.addCandidate(payload.workflowId, payload.segmentId, payload.text, payload.actor);
      case "candidate:list": return this.workCopies.listCandidates(payload.workflowId, payload.segmentId);
      case "candidate:select": return this.workCopies.selectCandidate(payload.workflowId, payload.segmentId, payload.candidateId, payload.expectedHeadVersion, payload.actor);
      case "working-copy:edit": return this.workCopies.edit(payload.workflowId, payload.segmentId, payload.expectedHeadVersion, payload.text, payload.actor);
      case "working-copy:get": return this.workCopies.getBundle(payload.workflowId);
      case "validate": return this.validation.run(payload.workflowId);
      case "validation:get": return this.validation.get(payload.validationRunId);
      case "warning:confirm": return this.reviews.confirmWarning(payload.workflowId, payload.validationRunId, payload.findingId, payload.actor);
      case "review": return this.reviews.humanReview(payload.workflowId, payload.validationRunId, payload.expectedWorkflowVersion, payload.actor);
      case "approve": return this.reviews.approve(payload.workflowId, payload.validationRunId, payload.expectedWorkflowVersion, payload.actor);
      case "review:list": return this.reviews.getEvents(payload.workflowId);
      case "export": return this.exports.export(payload.workflowId, payload.validationRunId, payload.format);
      default: throw new TypeError("unknown workflow command");
    }
  }
}
