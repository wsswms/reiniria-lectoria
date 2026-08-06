import { createServer } from "node:http";
import { createWorkflowHttpHandler } from "./workflow-http-api.mjs";

export function createWorkflowHttpServer(options) {
  const handler = createWorkflowHttpHandler(options);
  return createServer((request, response) => {
    handler(request, response).catch((error) => {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: error.message } }));
    });
  });
}
