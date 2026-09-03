import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionRoot = resolve(projectRoot, "extension");
const requiredFiles = [
  "README.md",
  "activity.html",
  "activity.js",
  "action-model.js",
  "background.js",
  "device-identity.js",
  "local-store.js",
  "manifest.json",
  "mark.svg",
  "page-bridge.js",
  "policy.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "protected-tools.js",
  "protocol.js",
  "receipt.html",
  "receipt.js",
  "review.css",
  "review.html",
  "review.js",
  "rules.html",
  "rules.js",
  "setup.css",
  "setup.html",
  "setup.js",
  "task-manager.js",
  "tasks.html",
  "tasks.js",
  "v2-client.js",
  "view-model.js",
];

function fail(message) {
  console.error(`Extension check failed: ${message}`);
  process.exitCode = 1;
}

function source(relativePath) {
  return readFileSync(resolve(extensionRoot, relativePath), "utf8");
}

for (const relativePath of requiredFiles) {
  const path = resolve(extensionRoot, relativePath);
  if (!existsSync(path) || !statSync(path).isFile()) fail(`required file is missing: extension/${relativePath}`);
}

const manifest = JSON.parse(source("manifest.json"));
const permissions = [...(manifest.permissions ?? [])].sort();
if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
if (Number(manifest.minimum_chrome_version) < 149) {
  fail("minimum_chrome_version must support the WebMCP candidate API (Chrome 149 or newer)");
}
if (manifest.action?.default_popup !== "popup.html") fail("the browser action must open popup.html");
if (manifest.background?.service_worker !== "background.js" || manifest.background?.type !== "module") {
  fail("background.js must be the MV3 module service worker");
}
if (manifest.options_page !== "setup.html") fail("setup.html must be the normal-tab options page");
if (JSON.stringify(permissions) !== JSON.stringify(["activeTab", "alarms", "notifications", "scripting", "storage"])) {
  fail(`permissions must be exactly activeTab, alarms, notifications, scripting, storage; received: ${permissions.join(", ")}`);
}
if (manifest.host_permissions || manifest.content_scripts) {
  fail("the manifest must not grant persistent hosts or declare a static content script");
}
if (JSON.stringify(manifest.optional_host_permissions) !== JSON.stringify(["https://*/*"])) {
  fail("the optional host permission must be the HTTPS-only WebMCP page boundary");
}
if (manifest.content_security_policy?.extension_pages !== "script-src 'self'; object-src 'none'") {
  fail("extension pages must retain the self-only MV3 content security policy");
}

const sourceFiles = readdirSync(extensionRoot).filter((name) => /\.(?:js|html|md)$/.test(name));
const providerOrFixtureTerms = [
  /\binsurance\b/i,
  /\bcoverage\b/i,
  /\bpremium\b/i,
  /\bdeductible\b/i,
  /research[ ._-]?brief/i,
  /research\.example/i,
  /localhost/i,
  /127\.0\.0\.1/i,
];
for (const relativePath of sourceFiles) {
  const contents = source(relativePath);
  for (const pattern of providerOrFixtureTerms) {
    if (pattern.test(contents)) fail(`extension/${relativePath} contains fixture-specific term ${pattern}`);
  }
  if (relativePath.endsWith(".js") && /(?:innerHTML|outerHTML|insertAdjacentHTML)/.test(contents)) {
    fail(`extension/${relativePath} must render remote/page data without HTML parsing sinks`);
  }
}

const background = source("background.js");
const pageBridge = source("page-bridge.js");
const protectedTools = source("protected-tools.js");
const localStore = source("local-store.js");
const deviceIdentity = source("device-identity.js");
const v2Client = source("v2-client.js");
const worker = readFileSync(resolve(projectRoot, "service", "src", "worker.js"), "utf8");

if (!/chrome\.scripting\.registerContentScripts\s*\(/.test(background)) {
  fail("background must register the HTTPS page bridge dynamically after enablement");
}
if (!background.includes("page-bridge.js")) fail("dynamic registration must install extension/page-bridge.js");
if (!/world\s*:\s*["']MAIN["']/.test(background)) {
  fail("WebMCP discovery, protected registration, and invocation must enter the page MAIN world");
}
if (!background.includes("document.modelContext.getTools()")) fail("background must rediscover page-owned WebMCP tools");
if (!/(?:document\.modelContext|context)\.registerTool/.test(protectedTools)) {
  fail("protected-tools.js must register page-scoped protected WebMCP tools");
}
if (!protectedTools.includes("doa2ai_action_status")) {
  fail("protected-tools.js must expose the stable pending-action status tool");
}
if (!pageBridge.includes("window.postMessage") || !pageBridge.includes("chrome.runtime.sendMessage")) {
  fail("page-bridge.js must bridge the page and extension isolated worlds");
}
if (!localStore.includes("chrome.storage.local")) fail("durable policy, tasks, and receipts must be local-first");
if (!deviceIdentity.includes("P-256")) fail("device identity must use the locked P-256 signing algorithm");
for (const route of ["/v2/devices/challenge", "/v2/devices/register", "/v2/connections"]) {
  if (!v2Client.includes(route)) fail(`v2-client.js is missing product route ${route}`);
}
if (!v2Client.includes("DEVICE_REQUEST_HEADERS") || !v2Client.includes("device-identity.js")) {
  fail("v2-client.js must source the signed request header allowlist from device-identity.js");
}
for (const header of ["X-doA2Ai-Device", "X-doA2Ai-Timestamp", "X-doA2Ai-Nonce", "X-doA2Ai-Signature"]) {
  if (!deviceIdentity.includes(header)) fail(`device-identity.js is missing signed request header ${header}`);
}
if (!background.includes("https://doa2ai-broker.cooing-cupcake.workers.dev")) {
  fail("normal enablement must use the built-in HTTPS service without endpoint entry");
}
if (!background.includes("chrome.notifications.create")) {
  fail("pending human reviews must use the notifications permission");
}
if (!background.includes("chrome.tabs.create")) {
  fail("detailed setup, review, receipt, and control surfaces must open as normal Chrome tabs");
}
if (!background.includes("chrome.storage.local") && !localStore.includes("chrome.storage.local")) {
  fail("durable product state must use chrome.storage.local");
}

const popupHtml = source("popup.html");
const popupJs = source("popup.js");
for (const id of [
  "enable-button",
  "tasks-button",
  "reviews-button",
  "activity-button",
  "pause-button",
  "revoke-button",
  "control-button",
  "setup-button",
]) {
  if (!popupHtml.includes(`id="${id}"`)) fail(`popup is missing compact ${id} action`);
}
const popupWithoutPolicyConfirmation = popupHtml.replace(
  /<input\b(?=[^>]*\bid=["']policy-confirm["'])(?=[^>]*\btype=["']checkbox["'])[^>]*>/i,
  "",
);
if (popupWithoutPolicyConfirmation === popupHtml) {
  fail("the compact popup must include the one-time starter-policy confirmation");
}
if (/<(?:form|input|textarea|select)\b/i.test(popupWithoutPolicyConfirmation)) {
  fail("the compact popup must not duplicate setup, credentials, tool selection, or review forms");
}
for (const pattern of [
  /browser[_-]?token/i,
  /operator[_-]?token/i,
  /mcp[_-]?token/i,
  /service[_-]?(?:url|origin)/i,
  /selectedToolNames/,
  /tool[_-]?checkbox/i,
]) {
  if (pattern.test(popupHtml) || pattern.test(popupJs)) {
    fail(`the compact popup contains manual setup control ${pattern}`);
  }
}

const extensionSources = requiredFiles
  .filter((path) => path.endsWith(".js"))
  .map((path) => source(path))
  .join("\n");
for (const page of ["activity.html", "tasks.html", "rules.html", "setup.html", "review.html", "receipt.html"]) {
  if (!extensionSources.includes(page)) fail(`${page} must be reachable as a normal Chrome tab`);
}
if (
  extensionSources.includes("args: [session.sessionId, session.pairingKey]") ||
  worker.includes("sessionStorage") ||
  worker.includes('id="pairing"')
) {
  fail("pairing or signing material must never be injected into the control page or its storage");
}

if (!process.exitCode) {
  console.log(
    "Extension checks passed: product-only MV3 module, dynamic HTTPS page bridge, local authority state, signed V2 transport, and compact no-credential popup.",
  );
}
