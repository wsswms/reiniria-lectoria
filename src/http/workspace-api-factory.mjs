import { DocumentImportService } from "../document/import-service.mjs";
import { ReimportService } from "../document/reimport-service.mjs";
import { WorkflowApi } from "../application/workflow-api.mjs";
import { FlowPlanService } from "../m5c/flow-plan-service.mjs";
import { WorkCopyService } from "../translation/work-copy-service.mjs";
import { ValidationService } from "../translation/validator.mjs";
import { QualityService } from "../quality/quality-service.mjs";
import { ReviewService } from "../translation/review-service.mjs";
import { ExportService } from "../export/export-service.mjs";
import { TemporaryContextService } from "../m5c/temporary-context-service.mjs";
import { FlowRecoveryService } from "../m5c/flow-recovery-service.mjs";
import { M5CQAService } from "../m5c/qa-service.mjs";
import { M5CRemediationService } from "../m5c/remediation-service.mjs";

/**
 * Build the application facade for one trusted workspace. The HTTP layer only
 * supplies the workspace id; the manager resolves and verifies the filesystem
 * and database identity before any domain service is constructed.
 */
export function createWorkspaceApiFactory(workspaceManager) {
  if (!workspaceManager || typeof workspaceManager.open !== "function") throw new TypeError("workspace manager is required");
  return (workspaceId) => {
    const handle = workspaceManager.open(workspaceId);
    const options = { database: handle.database, root: handle.root, trustedWorkspaceId: handle.record.workspaceId };
    const imports = new DocumentImportService(options);
    const reimports = new ReimportService(options);
    const flowPlans = new FlowPlanService(handle.database, handle.record.workspaceId);
    const workCopies = new WorkCopyService(handle.database, handle.record.workspaceId);
    const validation = new ValidationService(handle.database, handle.record.workspaceId, { workCopies });
    const quality = new QualityService(handle.database, handle.record.workspaceId, { workCopies, validation });
    const reviews = new ReviewService(handle.database, handle.record.workspaceId, { validation, quality });
    const exports = new ExportService({ ...options, workCopies, validation, quality });
    const contexts = new TemporaryContextService(handle.database, handle.record.workspaceId);
    const recovery = new FlowRecoveryService(handle.database, handle.record.workspaceId, { contexts, tasks: contexts.tasks, budgets: contexts.budgets });
    const m5cQa = new M5CQAService(handle.database, handle.record.workspaceId, { workCopies });
    const remediation = new M5CRemediationService(handle.database, handle.record.workspaceId, { contexts, budgets: contexts.budgets });
    const api = new WorkflowApi({ imports, reimports, flowPlans, contexts, recovery, m5cQa, remediation, workCopies, validation, reviews, exports });
    return Object.freeze({ api, close: () => handle.database.close() });
  };
}
