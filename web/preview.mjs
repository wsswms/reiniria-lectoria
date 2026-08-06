import { createReadStream, stat } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./dist/", import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
createServer((request, response) => {
  const relative = request.url === "/" ? "/index.html" : new URL(request.url, "http://localhost").pathname;
  const target = normalize(join(root, relative));
  if (!target.startsWith(root)) { response.writeHead(403); return response.end(); }
  stat(target, (error, info) => { if (error || !info.isFile()) { response.writeHead(404); return response.end(); } response.writeHead(200, { "content-type": types[extname(target)] ?? "application/octet-stream" }); createReadStream(target).pipe(response); });
}).listen(Number(process.env.PORT ?? 4173), "0.0.0.0");
