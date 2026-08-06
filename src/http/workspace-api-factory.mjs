import { DocumentImportService } from "../document/import-service.mjs";
import { ReimportService } from "../document/reimport-service.mjs";
import { WorkflowApi } from "../application/workflow-api.mjs";
import { FlowPlanService } from "../m5c/flow-plan-service.mjs";
import { WorkCopyService } from "../translation/work-copy-service.mjs";
import { ValidationService } from "../translation/validator.mjs";
import { QualityService } from "../quality/quality-service.mjs";
import { ReviewService } from "../translation/review-service.mjs";
import { ExportService } from "../export/export-service.mjs";

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
    const api = new WorkflowApi({ imports, reimports, flowPlans, workCopies, validation, reviews, exports });
    return Object.freeze({ api, close: () => handle.database.close() });
  };
}
