import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const appHtml = readFileSync(path.resolve(baseDir, "../app/index.html"), "utf8");
const appScript = readFileSync(path.resolve(baseDir, "../app/app.js"), "utf8");
const appStyles = readFileSync(path.resolve(baseDir, "../app/styles.css"), "utf8");

test("the host fixture is an ordinary website, not simulated browser chrome", () => {
  assert.match(appHtml, /class="site-shell"/);
  assert.match(appHtml, /class="site-header"/);
  assert.match(appHtml, /class="task-console"/);
  assert.match(appHtml, /Ordinary website fixture/);

  for (const forbidden of [
    "browser-shell",
    "browser-chrome",
    "browser-toolbar",
    "tab-strip",
    "window-controls",
    "active-tab",
    "address-field",
    "toolbar-actions",
    "page-tray",
  ]) {
    for (const [surface, source] of [
      ["HTML", appHtml],
      ["CSS", appStyles],
      ["JavaScript", appScript],
    ]) {
      assert.equal(source.includes(forbidden), false, `${surface} retains rejected fake-browser framing: ${forbidden}`);
    }
  }
});

test("website task controls are persistent and no longer driven as a browser dropdown", () => {
  assert.match(appHtml, /<section class="task-console" id="task-console"/);
  assert.equal(appScript.includes("pageTray"), false);
  assert.equal(appScript.includes("page-tray"), false);
});
