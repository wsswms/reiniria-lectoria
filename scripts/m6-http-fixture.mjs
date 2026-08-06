import { createWorkflowHttpServer } from "../src/http/server.mjs";
import { assertHttpConfig, loadHttpConfig } from "../src/runtime/config.mjs";

const config = loadHttpConfig();
assertHttpConfig(config);
const api = {
  async execute(command, payload) {
    if (command === "workflow:get") return { workflowId: payload.workflowId, state: "editing" };
    if (command === "document:import") return { importId: "fixture-import", format: payload.format };
    throw new TypeError("unknown workflow command");
  },
};
const server = createWorkflowHttpServer({ api, config, health: () => ({ status: "ok", service: "m6-http" }) });
server.listen(config.port, config.host, () => process.stdout.write(`m6-http listening on ${config.host}:${config.port}\n`));
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
