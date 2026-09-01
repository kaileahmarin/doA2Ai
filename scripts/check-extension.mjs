import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionRoot = resolve(projectRoot, "extension");
const requiredFiles = ["manifest.json", "popup.html", "popup.css", "popup.js", "view-model.js", "README.md"];
const userVisibleFiles = ["popup.html", "popup.js", "view-model.js", "README.md"];
const forbiddenProductFixtureTerms = [
  /\bdemo\b/i,
  /\bdashboard\b/i,
  /\binbox\b/i,
  /\bapproval\b/i,
  /\bauthorize\b/i,
  /\bdeny\b/i,
  /\breceipt\b/i,
  /\breview\b/i,
  /\binsurance\b/i,
  /\brenewal\b/i,
  /\bpremium\b/i,
  /\bdeductible\b/i,
  /\bcoverage\b/i,
  /\bpayment instrument\b/i,
];

function fail(message) {
  console.error(`Extension check failed: ${message}`);
  process.exitCode = 1;
}

for (const relativePath of requiredFiles) {
  const path = resolve(extensionRoot, relativePath);
  if (!existsSync(path) || !statSync(path).isFile()) fail(`required file is missing: extension/${relativePath}`);
}

const manifest = JSON.parse(readFileSync(resolve(extensionRoot, "manifest.json"), "utf8"));
const permissions = [...(manifest.permissions ?? [])].sort();
if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
if (manifest.action?.default_popup !== "popup.html") fail("the browser action must open popup.html");
if (JSON.stringify(permissions) !== JSON.stringify(["activeTab", "scripting"])) {
  fail(`permissions must be exactly activeTab and scripting, received: ${permissions.join(", ")}`);
}
if (manifest.host_permissions || manifest.optional_host_permissions || manifest.content_scripts) {
  fail("the initial extension must not request persistent host access or install content scripts");
}

for (const relativePath of userVisibleFiles) {
  const source = readFileSync(resolve(extensionRoot, relativePath), "utf8");
  for (const pattern of forbiddenProductFixtureTerms) {
    if (pattern.test(source)) fail(`extension/${relativePath} contains product-fixture term ${pattern}`);
  }
}

const extensionScriptFiles = readdirSync(extensionRoot)
  .filter((relativePath) => relativePath.endsWith(".js"))
  .sort();
const forbiddenScriptSurfaces = [
  "executeTool(",
  "chrome.storage",
  "fetch(",
  "XMLHttpRequest",
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
];

for (const relativePath of extensionScriptFiles) {
  const source = readFileSync(resolve(extensionRoot, relativePath), "utf8");
  for (const forbiddenSurface of forbiddenScriptSurfaces) {
    if (source.includes(forbiddenSurface)) {
      fail(`extension/${relativePath} contains forbidden surface: ${forbiddenSurface}`);
    }
  }
}

const popupSource = readFileSync(resolve(extensionRoot, "popup.js"), "utf8");
if (!popupSource.includes("context.getTools()")) fail("popup.js must discover the current page through getTools()");
if (!/world\s*:\s*["']MAIN["']/.test(popupSource)) {
  fail("popup.js must inspect the page WebMCP surface in Chrome's MAIN execution world");
}
if (!popupSource.includes("textContent")) fail("popup.js must render page-supplied metadata as text");

const popupHtml = readFileSync(resolve(extensionRoot, "popup.html"), "utf8");
if (!popupHtml.includes("Human action stays on this page.")) fail("popup must preserve the page-owned human-action boundary");
if (/<(?:form|input|select|textarea)\b/i.test(popupHtml)) fail("popup must not contain duplicate human-input controls");
const buttonCount = [...popupHtml.matchAll(/<button\b/gi)].length;
if (buttonCount !== 1 || !popupHtml.includes('id="refresh-button"')) {
  fail("popup must expose only the capability refresh button");
}

if (!process.exitCode) {
  console.log("Extension checks passed: MV3, activeTab-only host access, read-only WebMCP discovery, domain-neutral copy.");
}
