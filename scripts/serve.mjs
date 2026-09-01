import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appRoot = join(projectRoot, "app");
const port = Number(process.env.BOUNDED_DEMO_PORT || 4173);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function responseHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Origin-Agent-Cluster": "?1",
    "Permissions-Policy": "tools=(self)",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
  };
}

function safePath(urlPath) {
  let requested;
  try {
    requested = decodeURIComponent((urlPath || "/").split("?")[0]);
  } catch {
    return null;
  }
  const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  const candidate = resolve(appRoot, normalize(relative));
  if (candidate !== appRoot && !candidate.startsWith(`${appRoot}\\`) && !candidate.startsWith(`${appRoot}/`)) return null;
  return candidate;
}

export const server = createServer((request, response) => {
  if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
    response.writeHead(405, responseHeaders("text/plain; charset=utf-8"));
    response.end("Method not allowed");
    return;
  }

  const filePath = safePath(request.url);
  if (!filePath) {
    response.writeHead(400, responseHeaders("text/plain; charset=utf-8"));
    response.end("Bad request");
    return;
  }

  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) throw new Error("Not a file");
    response.writeHead(200, responseHeaders(contentTypes[extname(filePath)] || "application/octet-stream"));
    if (request.method === 'HEAD') response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, responseHeaders("text/plain; charset=utf-8"));
    response.end("Not found");
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(port, "127.0.0.1", () => {
    console.log(`doA2Ai is running at http://127.0.0.1:${port}`);
  });
}
