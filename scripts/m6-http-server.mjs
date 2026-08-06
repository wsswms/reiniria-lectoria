import { createProductionWorkflowHttpServer } from "../src/http/production-server.mjs";
import { assertHttpConfig, loadHttpConfig } from "../src/runtime/config.mjs";
import { WorkspaceManager } from "../src/workspace/manager.mjs";

const config = loadHttpConfig();
assertHttpConfig(config);
const manager = await WorkspaceManager.create(config.dataRoot);
const server = await createProductionWorkflowHttpServer({ config, workspaceManager: manager });
server.listen(config.port, config.host, () => process.stdout.write(`lectoria listening on ${config.host}:${config.port}\n`));
const shutdown = () => server.close(() => { manager.close(); process.exit(0); });
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
