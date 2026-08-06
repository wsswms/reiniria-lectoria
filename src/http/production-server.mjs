import { createWorkflowHttpServer } from "./server.mjs";
import { createWorkspaceApiFactory } from "./workspace-api-factory.mjs";
import { ProviderConfigurationService } from "../provider/configuration-service.mjs";

/** Create the LAN HTTP server with real workspace-scoped domain services. */
export async function createProductionWorkflowHttpServer({ config, workspaceManager, health = () => ({ status: "ok", service: "lectoria" }) }) {
  if (!config || !workspaceManager) throw new TypeError("config and workspaceManager are required");
  const providerConfiguration = new ProviderConfigurationService(config.dataRoot ?? workspaceManager.root);
  return createWorkflowHttpServer({ config, workspaceManager, providerConfiguration, apiForWorkspace: createWorkspaceApiFactory(workspaceManager, {
    providerConfiguration, translationMode: config.translationMode, realProviderTimeoutMs: config.realProviderTimeoutMs, realMaxOutputTokens: config.realMaxOutputTokens,
    realPricingVersion: config.realPricingVersion, realInputMicrosPerMillion: config.realInputMicrosPerMillion, realOutputMicrosPerMillion: config.realOutputMicrosPerMillion,
    realCachedInputMicrosPerMillion: config.realCachedInputMicrosPerMillion, realSoftLimitMicros: config.realSoftLimitMicros, realHardLimitMicros: config.realHardLimitMicros,
    realRunnerUid: config.realRunnerUid, realRunnerGid: config.realRunnerGid,
  }), health,
    diagnostics: () => ({ status: "ok", service: "lectoria", node: process.versions.node, uptimeSeconds: Math.floor(process.uptime()),
      workspaceCount: workspaceManager.list().length, tlsEnabled: Boolean(config.tls?.certFile) }) });
}
