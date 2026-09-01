import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionRoot = join(projectRoot, "extension");
const previewRoot = join(projectRoot, "preview");
const port = Number(process.env.CURRENT_PAGE_PREVIEW_PORT || 4175);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const files = new Map([
  ["/popup.css", join(extensionRoot, "popup.css")],
  ["/popup.js", join(extensionRoot, "popup.js")],
  ["/view-model.js", join(extensionRoot, "view-model.js")],
  ["/preview-shim.js", join(previewRoot, "chrome-shim.js")],
  ["/preview-shell.css", join(previewRoot, "shell.css")],
]);

function headers(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    "Permissions-Policy": "tools=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function previewHtml() {
  return readFileSync(join(extensionRoot, "popup.html"), "utf8")
    .replace(
      '<link rel="stylesheet" href="./popup.css" />',
      '<link rel="stylesheet" href="./popup.css" />\n    <link rel="stylesheet" href="./preview-shell.css" />',
    )
    .replace(
      '<script type="module" src="./popup.js"></script>',
      '<script src="./preview-shim.js"></script>\n    <script type="module" src="./popup.js"></script>',
    );
}

export const previewServer = createServer((request, response) => {
  const method = request.method || "GET";
  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, headers("text/plain; charset=utf-8"));
    response.end("Method not allowed");
    return;
  }

  let pathname;
  try {
    pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  } catch {
    response.writeHead(400, headers("text/plain; charset=utf-8"));
    response.end("Bad request");
    return;
  }

  if (pathname === "/" || pathname === "/index.html") {
    const html = previewHtml();
    response.writeHead(200, headers(contentTypes[".html"]));
    response.end(method === "HEAD" ? undefined : html);
    return;
  }

  const filePath = files.get(pathname);
  if (!filePath) {
    response.writeHead(404, headers("text/plain; charset=utf-8"));
    response.end("Not found");
    return;
  }

  const source = readFileSync(filePath);
  response.writeHead(200, headers(contentTypes[extname(filePath)] || "application/octet-stream"));
  response.end(method === "HEAD" ? undefined : source);
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  previewServer.listen(port, "127.0.0.1", () => {
    console.log(`Current-page UI preview is running at http://127.0.0.1:${port}`);
  });
}
