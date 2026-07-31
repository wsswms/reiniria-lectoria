export class WorkflowApi {
  constructor({ workCopies, validation, reviews }) {
    this.workCopies = workCopies;
    this.validation = validation;
    this.reviews = reviews;
  }

  execute(command, payload) {
    switch (command) {
      case "candidate:add": return this.workCopies.addCandidate(payload.workflowId, payload.segmentId, payload.text, payload.actor);
      case "candidate:list": return this.workCopies.listCandidates(payload.workflowId, payload.segmentId);
      case "candidate:select": return this.workCopies.selectCandidate(payload.workflowId, payload.segmentId, payload.candidateId, payload.expectedHeadVersion, payload.actor);
      case "working-copy:edit": return this.workCopies.edit(payload.workflowId, payload.segmentId, payload.expectedHeadVersion, payload.text, payload.actor);
      case "working-copy:get": return this.workCopies.getBundle(payload.workflowId);
      case "validate": return this.validation.run(payload.workflowId);
      case "warning:confirm": return this.reviews.confirmWarning(payload.workflowId, payload.validationRunId, payload.findingId, payload.actor);
      case "review": return this.reviews.humanReview(payload.workflowId, payload.validationRunId, payload.expectedWorkflowVersion, payload.actor);
      case "approve": return this.reviews.approve(payload.workflowId, payload.validationRunId, payload.expectedWorkflowVersion, payload.actor);
      default: throw new TypeError("unknown workflow command");
    }
  }
}
