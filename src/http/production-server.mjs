import { createWorkflowHttpServer } from "./server.mjs";
import { createWorkspaceApiFactory } from "./workspace-api-factory.mjs";
import { ProviderConfigurationService } from "../provider/configuration-service.mjs";

/** Create the LAN HTTP server with real workspace-scoped domain services. */
export async function createProductionWorkflowHttpServer({ config, workspaceManager, health = () => ({ status: "ok", service: "lectoria" }) }) {
  if (!config || !workspaceManager) throw new TypeError("config and workspaceManager are required");
  const providerConfiguration = new ProviderConfigurationService(config.dataRoot ?? workspaceManager.root);
  return createWorkflowHttpServer({ config, workspaceManager, providerConfiguration, apiForWorkspace: createWorkspaceApiFactory(workspaceManager), health,
    diagnostics: () => ({ status: "ok", service: "lectoria", node: process.versions.node, uptimeSeconds: Math.floor(process.uptime()),
      workspaceCount: workspaceManager.list().length, tlsEnabled: Boolean(config.tls?.certFile) }) });
}
