import http from "node:http";
import https from "node:https";

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new Error("request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function cookieValue(request, name) {
  const values = Object.fromEntries(
    String(request.headers.cookie ?? "")
      .split(";")
      .map((entry) => entry.trim().split("="))
      .filter(([key, value]) => key && value),
  );
  return values[name];
}

function remoteAddress(request) {
  return request.socket.remoteAddress?.replace(/^::ffff:/, "");
}

function transportState(request, config) {
  if (config.mode === "https-direct") return { secure: Boolean(request.socket.encrypted), trustedProxy: false };
  if (config.mode === "https-proxy") {
    const trustedProxy = config.trustedProxies.includes(remoteAddress(request));
    return { secure: trustedProxy && request.headers["x-forwarded-proto"] === "https", trustedProxy };
  }
  return { secure: false, trustedProxy: false };
}

export function createSpikeServer({ config, auth }) {
  const handler = async (request, response) => {
    try {
      const host = request.headers.host;
      if (!config.allowedHosts.includes(host)) return json(response, 400, { error: "invalid Host" });
      const origin = request.headers.origin;
      if (request.method !== "GET" && !config.allowedOrigins.includes(origin)) {
        return json(response, 403, { error: "invalid Origin" });
      }
      const transport = transportState(request, config);
      if (config.mode === "https-direct" && !transport.secure) return json(response, 400, { error: "TLS required" });
      if (config.mode === "https-proxy" && (!transport.trustedProxy || !transport.secure)) {
        return json(response, 400, { error: "trusted HTTPS proxy required" });
      }

      if (request.method === "POST" && request.url === "/login") {
        const body = await readJson(request);
        const login = auth.login(body.password ?? "");
        if (!login) return json(response, 401, { error: "invalid credentials" });
        const secure = transport.secure ? "; Secure" : "";
        return json(
          response,
          200,
          { csrf: login.csrf, mode: config.mode, httpRisk: config.mode === "http" },
          { "set-cookie": `session=${login.token}; HttpOnly; SameSite=Strict${secure}` },
        );
      }

      const session = auth.getSession(cookieValue(request, "session"));
      if (!session) return json(response, 401, { error: "authentication required" });
      if (request.method !== "GET" && request.headers["x-csrf-token"] !== session.csrf) {
        return json(response, 403, { error: "invalid CSRF token" });
      }
      if (request.method === "GET" && request.url === "/private") {
        return json(response, 200, { mode: config.mode, httpRisk: config.mode === "http", secure: transport.secure });
      }
      if (request.method === "POST" && request.url === "/state") {
        return json(response, 200, { updated: true });
      }
      return json(response, 404, { error: "not found" });
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  };

  const server = config.mode === "https-direct"
    ? https.createServer({ cert: config.cert, key: config.key }, handler)
    : http.createServer(handler);

  return {
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.bindAddress, resolve);
      });
      return server.address();
    },
    async stop() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
