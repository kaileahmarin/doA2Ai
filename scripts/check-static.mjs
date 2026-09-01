import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appRoot = resolve(projectRoot, "app");
const extensionRoot = resolve(projectRoot, "extension");

const requiredFiles = [
  "README.md",
  "LICENSE",
  "PRODUCT_CHARTER.md",
  "PROJECT_PROVENANCE.md",
  "BRANDING_STATUS.md",
  "CLEAN_ROOM_REVIEW.md",
  "VERIFICATION.md",
  "package.json",
  "app/index.html",
  "app/styles.css",
  "app/app.js",
  "app/domain.js",
  "app/webmcp.js",
  "extension/manifest.json",
  "extension/popup.html",
  "extension/popup.css",
  "extension/popup.js",
  "extension/view-model.js",
  "extension/README.md",
  "preview/chrome-shim.js",
  "preview/shell.css",
  "docs/ARCHITECTURE.md",
  "docs/LAUNCHABLE_GUI_UI_TRACK.md",
  "docs/T1_OFFLINE_RUNTIME_CONTRACT.md",
  "runtime/t1/request-manifest.js",
  "runtime/t1/session.js",
  "runtime/t1/synthetic-target.js",
  "scripts/serve.mjs",
  "scripts/serve-extension-preview.mjs",
  "scripts/run-t1-synthetic.mjs",
  "scripts/check-static.mjs",
  "scripts/check-extension.mjs",
  "tests/extension-preview.test.js",
];

const textExtensions = new Set([".css", ".html", ".js", ".json", ".md", ".mjs"]);
const ignoredDirectories = new Set([".git", ".worktrees", "coverage", "dist", "node_modules"]);

function fail(message) {
  console.error(`Static check failed: ${message}`);
  process.exitCode = 1;
}

function filesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function localTarget(sourceFile, reference) {
  const clean = reference.split(/[?#]/, 1)[0];
  if (!clean || clean.startsWith("#") || clean.startsWith("data:") || clean.startsWith("mailto:")) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(clean)) return null;
  if (clean.startsWith("/")) return resolve(appRoot, clean.replace(/^\/+/, ""));
  return resolve(dirname(sourceFile), clean);
}

function checkReference(sourceFile, reference, kind, allowedRoot = appRoot) {
  if (isAbsolute(reference) && !reference.startsWith("/")) {
    fail(`${kind} reference must not use an absolute filesystem path: ${reference}`);
    return true;
  }
  const target = localTarget(sourceFile, reference);
  if (!target) return false;
  if (!target.startsWith(`${allowedRoot}\\`) && !target.startsWith(`${allowedRoot}/`) && target !== allowedRoot) {
    fail(`${kind} reference escapes ${allowedRoot === appRoot ? "app/" : "the project root"}: ${reference}`);
    return true;
  }
  if (!existsSync(target) || !statSync(target).isFile()) fail(`${kind} reference is missing: ${reference}`);
  return true;
}

for (const relativePath of requiredFiles) {
  const path = resolve(projectRoot, relativePath);
  if (!existsSync(path) || !statSync(path).isFile()) fail(`required file is missing: ${relativePath}`);
}

const sourceFiles = filesUnder(projectRoot).filter((path) => textExtensions.has(extname(path).toLowerCase()));

let referenceCount = 0;
for (const htmlPath of [resolve(appRoot, "index.html"), resolve(extensionRoot, "popup.html")]) {
  const html = readFileSync(htmlPath, "utf8");
  const allowedRoot = htmlPath.startsWith(extensionRoot) ? extensionRoot : appRoot;
  for (const match of html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    if (checkReference(htmlPath, match[1], "HTML asset", allowedRoot)) referenceCount += 1;
  }
}

for (const cssPath of sourceFiles.filter((path) => extname(path).toLowerCase() === ".css")) {
  const css = readFileSync(cssPath, "utf8");
  const allowedRoot = cssPath.startsWith(extensionRoot) ? extensionRoot : appRoot;
  for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    if (checkReference(cssPath, match[1], "CSS asset", allowedRoot)) referenceCount += 1;
  }
}

for (const modulePath of sourceFiles.filter((path) => [".js", ".mjs"].includes(extname(path).toLowerCase()))) {
  const source = readFileSync(modulePath, "utf8");
  for (const match of source.matchAll(/\b(?:from\s*|import\s*)["']([^"']+)["']/g)) {
    const reference = match[1];
    if (reference.startsWith("node:")) continue;
    if (checkReference(modulePath, reference, "module import", projectRoot)) referenceCount += 1;
  }
}

if (!process.exitCode) {
  console.log(
    `Static checks passed: ${requiredFiles.length} required files, ${referenceCount} local references, ${sourceFiles.length} text source files.`,
  );
}
