import { createWorkflowHttpServer } from "./server.mjs";
import { createWorkspaceApiFactory } from "./workspace-api-factory.mjs";

/** Create the LAN HTTP server with real workspace-scoped domain services. */
export async function createProductionWorkflowHttpServer({ config, workspaceManager, health = () => ({ status: "ok", service: "lectoria" }) }) {
  if (!config || !workspaceManager) throw new TypeError("config and workspaceManager are required");
  return createWorkflowHttpServer({ config, workspaceManager, apiForWorkspace: createWorkspaceApiFactory(workspaceManager), health });
}
