import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { previewServer } from "../scripts/serve-extension-preview.mjs";

let baseUrl;

test.before(async () => {
  await new Promise((resolve, reject) => {
    previewServer.once("error", reject);
    previewServer.listen(0, "127.0.0.1", resolve);
  });
  const address = previewServer.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => previewServer.close((error) => (error ? reject(error) : resolve())));
});

test("the local preview wraps the real popup with explicit sample-only assets", async () => {
  const response = await fetch(`${baseUrl}/?state=restricted`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("permissions-policy"), "tools=()");
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);

  const html = await response.text();
  assert.match(html, /<link rel="stylesheet" href="\.\/popup\.css" \/>/);
  assert.match(html, /<link rel="stylesheet" href="\.\/preview-shell\.css" \/>/);
  assert.match(html, /<script src="\.\/preview-shim\.js"><\/script>/);
  assert.match(html, /<script type="module" src="\.\/popup\.js"><\/script>/);
  assert.equal((html.match(/preview-shim\.js/g) ?? []).length, 1);
  assert.equal((html.match(/preview-shell\.css/g) ?? []).length, 1);
});

test("the preview serves only its bounded asset map and fails closed", async () => {
  for (const path of ["/popup.js", "/view-model.js", "/preview-shim.js", "/preview-shell.css"]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, path);
  }

  const missing = await fetch(`${baseUrl}/missing`);
  assert.equal(missing.status, 404);
  const unsupported = await fetch(`${baseUrl}/`, { method: "POST" });
  assert.equal(unsupported.status, 405);
});

function previewChromeFor(state) {
  const source = readFileSync(new URL("../preview/chrome-shim.js", import.meta.url), "utf8");
  const window = { location: { search: `?state=${state}` } };
  runInNewContext(source, { URLSearchParams, window });
  return window.chrome;
}

test("the preview shim returns the same inspection envelope the popup consumes", async () => {
  const cases = [
    { state: "ready", expectedKind: "ready", expectedTools: 3 },
    { state: "empty", expectedKind: "empty", expectedTools: 0 },
    { state: "unsupported", expectedKind: "unsupported", expectedTools: 0 },
    { state: "listing_unavailable", expectedKind: "listing_unavailable", expectedTools: 0 },
    { state: "error", expectedKind: "error", expectedTools: 0 },
  ];

  for (const { state, expectedKind, expectedTools } of cases) {
    const chrome = previewChromeFor(state);
    const [tab] = await chrome.tabs.query();
    const [injection] = await chrome.scripting.executeScript();
    const result = JSON.parse(JSON.stringify(injection.result));

    assert.deepEqual(Object.keys(result).sort(), ["inspection", "pageUrl", "stale"]);
    assert.equal(result.pageUrl, tab.url, state);
    assert.equal(result.stale, false, state);
    assert.equal(result.inspection.kind, expectedKind, state);
    assert.equal(result.inspection.tools.length, expectedTools, state);
  }

  const restrictedChrome = previewChromeFor("restricted");
  const [restrictedTab] = await restrictedChrome.tabs.query();
  assert.equal(restrictedTab.url, "chrome://extensions/");
});
