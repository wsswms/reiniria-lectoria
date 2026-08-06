import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { createWorkflowHttpHandler } from "./workflow-http-api.mjs";

export function createWorkflowHttpServer(options) {
  const handler = createWorkflowHttpHandler(options);
  const listener = (request, response) => {
    handler(request, response).catch((error) => {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: error.message } }));
    });
  };
  if (options?.config?.tls?.certFile && options?.config?.tls?.keyFile) {
    return createHttpsServer({ cert: readFileSync(options.config.tls.certFile), key: readFileSync(options.config.tls.keyFile) }, listener);
  }
  return createServer(listener);
}
