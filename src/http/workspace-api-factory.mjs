import { DocumentImportService } from "../document/import-service.mjs";
import { ReimportService } from "../document/reimport-service.mjs";
import { WorkflowApi } from "../application/workflow-api.mjs";
import { FlowPlanService } from "../m5c/flow-plan-service.mjs";

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
    const api = new WorkflowApi({ imports, reimports, flowPlans });
    return Object.freeze({ api, close: () => handle.database.close() });
  };
}
