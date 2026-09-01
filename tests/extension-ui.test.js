import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import {
  isCurrentInspection,
  isInspectableUrl,
  normalizeInspection,
  normalizeTool,
  presentTab,
  sameToolPresentation,
  setTextIfChanged,
  viewCopy,
} from "../extension/view-model.js";

test("unchanged status text is not rewritten", () => {
  let writes = 0;
  const node = {
    value: "Tools available",
    get textContent() {
      return this.value;
    },
    set textContent(value) {
      writes += 1;
      this.value = value;
    },
  };

  assert.equal(setTextIfChanged(node, "Tools available"), false);
  assert.equal(writes, 0);
  assert.equal(setTextIfChanged(node, "No active capabilities"), true);
  assert.equal(writes, 1);
  assert.equal(node.textContent, "No active capabilities");
});

test("unchanged capability presentations retain their rendered list", () => {
  const initial = normalizeInspection({
    kind: "ready",
    tools: [{ name: "search_page", title: "Search page", readOnly: true }],
  }).tools;
  const unchanged = normalizeInspection({
    kind: "ready",
    tools: [{ name: "search_page", title: "Search page", readOnly: true }],
  }).tools;
  const changed = normalizeInspection({
    kind: "ready",
    tools: [{ name: "search_page", title: "Search workspace", readOnly: true }],
  }).tools;

  assert.equal(sameToolPresentation(initial, unchanged), true);
  assert.equal(sameToolPresentation(initial, changed), false);
  assert.equal(sameToolPresentation(initial, []), false);
});

test("only ordinary web pages are inspectable", () => {
  assert.equal(isInspectableUrl("https://example.com/path"), true);
  assert.equal(isInspectableUrl("http://127.0.0.1:4173/"), true);
  assert.equal(isInspectableUrl("chrome://extensions"), false);
  assert.equal(isInspectableUrl("file:///C:/private.txt"), false);
  assert.equal(isInspectableUrl("not a url"), false);
});

test("current-page discovery runs in the page MAIN execution world", () => {
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  const popupSource = readFileSync(path.resolve(baseDir, "../extension/popup.js"), "utf8");

  assert.match(popupSource, /chrome\.scripting\.executeScript\s*\(/);
  assert.match(popupSource, /world\s*:\s*["']MAIN["']/);
  assert.match(popupSource, /document\.modelContext/);
});

test("current-tab presentation keeps only bounded display metadata", () => {
  const tab = presentTab({
    id: 17,
    title: "  Collaborative\nresearch  ",
    url: "https://workspace.example/research?private=value",
    favIconUrl: "https://workspace.example/icon.png",
  });

  assert.deepEqual(tab, {
    id: 17,
    title: "Collaborative research",
    origin: "https://workspace.example",
    inspectable: true,
  });
  assert.equal("favIconUrl" in tab, false);
  assert.equal("url" in tab, false);

  assert.deepEqual(presentTab({ id: 18, title: "Browser settings", url: "chrome://extensions/" }), {
    id: 18,
    title: "Browser settings",
    origin: "Browser page",
    inspectable: false,
  });
});

test("same-origin navigation suppresses a deferred page inspection", async () => {
  const requestedTab = { id: 17, url: "https://workspace.example/route-a" };
  let currentTab = requestedTab;
  let resolveInspection;
  const firstInspection = new Promise((resolve) => {
    resolveInspection = resolve;
  });

  const shouldRender = firstInspection.then(({ observedPageUrl, stale }) =>
    isCurrentInspection({
      generation: 1,
      latestGeneration: 1,
      requestedTab,
      currentTab,
      observedPageUrl,
      stale,
    }),
  );

  currentTab = { id: 17, url: "https://workspace.example/route-b" };
  resolveInspection({ observedPageUrl: requestedTab.url, stale: false });

  assert.equal(await shouldRender, false);
  assert.equal(
    isCurrentInspection({
      generation: 1,
      latestGeneration: 1,
      requestedTab,
      currentTab: requestedTab,
      observedPageUrl: requestedTab.url,
    }),
    true,
  );
});

test("tool metadata is normalized for safe text rendering", () => {
  assert.deepEqual(
    normalizeTool({
      name: "read_context",
      title: "  Read\ncontext ",
      description: "  Reads   the current page context. ",
      readOnly: true,
      inputSchema: { secret: true },
    }),
    {
      name: "read_context",
      title: "Read context",
      description: "Reads the current page context.",
      kind: "read",
      origin: "",
      untrusted: false,
    },
  );

  const hostile = normalizeTool({
    name: "html_like",
    title: '<img src=x onerror="alert(1)">',
    description: "<script>throw new Error('not markup')</script>",
  });
  assert.equal(hostile.title, '<img src=x onerror="alert(1)">');
  assert.equal(hostile.description, "<script>throw new Error('not markup')</script>");
  assert.equal(hostile.untrusted, false);

  const attributed = normalizeTool({
    name: "external_context",
    origin: "https://frame.example:8443",
    untrusted: true,
  });
  assert.equal(attributed.origin, "https://frame.example:8443");
  assert.equal(attributed.untrusted, true);
});

test("ready capabilities are sorted and empty readiness remains explicit", () => {
  const ready = normalizeInspection({
    kind: "ready",
    tools: [
      { name: "write_note", title: "Write note", description: "Writes a note.", readOnly: false },
      { name: "read_note", title: "Read note", description: "Reads a note.", readOnly: true },
    ],
  });
  assert.equal(ready.kind, "ready");
  assert.deepEqual(
    ready.tools.map((tool) => tool.title),
    ["Read note", "Write note"],
  );

  const empty = normalizeInspection({ kind: "ready", tools: [] });
  assert.equal(empty.kind, "empty");
  assert.deepEqual(empty.tools, []);
});

test("unsupported and error states never retain supplied tool metadata", () => {
  for (const kind of ["restricted", "unsupported", "listing_unavailable", "error"]) {
    const inspection = normalizeInspection({ kind, tools: [{ name: "should_not_render" }] });
    assert.equal(inspection.kind, kind);
    assert.deepEqual(inspection.tools, []);
    assert.ok(viewCopy(inspection).title.length > 0);
    assert.ok(viewCopy(inspection).detail.length > 0);
  }
});

test("ready copy reports exactly the current capability count", () => {
  const one = normalizeInspection({ kind: "ready", tools: [{ name: "read", title: "Read" }] });
  const two = normalizeInspection({
    kind: "ready",
    tools: [
      { name: "read", title: "Read" },
      { name: "write", title: "Write", readOnly: false },
    ],
  });

  assert.equal(viewCopy(one).detail, "1 current-page capability available.");
  assert.equal(viewCopy(two).detail, "2 current-page capabilities available.");
  assert.equal(viewCopy(one).title, "Tools available");
});

test("malformed inspection payloads stay deterministic during tab churn", () => {
  const cases = [
    {
      generation: 1,
      latestGeneration: 1,
      requestedTab: { id: 2, url: "https://workspace.example/route" },
      currentTab: { id: 2, url: "http://workspace.example/route" },
      observedPageUrl: "https://workspace.example/route",
      stale: false,
    },
    {
      generation: 1,
      latestGeneration: 1,
      requestedTab: { id: 2, url: "https://workspace.example/route" },
      currentTab: { id: 3, url: "https://workspace.example/route" },
      observedPageUrl: "https://workspace.example/route",
      stale: false,
    },
    {
      generation: 2,
      latestGeneration: 3,
      requestedTab: { id: 2, url: "https://workspace.example/route" },
      currentTab: { id: 2, url: "https://workspace.example/route" },
      observedPageUrl: "https://workspace.example/route",
      stale: false,
    },
    {
      generation: 1,
      latestGeneration: 1,
      requestedTab: { id: 2, url: "https://workspace.example/route" },
      currentTab: { id: 2, url: "https://workspace.example/other" },
      observedPageUrl: "https://workspace.example/route",
      stale: false,
    },
  ];

  for (const caseRecord of cases) {
    assert.equal(isCurrentInspection(caseRecord), false);
  }
});

test("normalize functions cap UI fields for compact rendering and ignore malformed shapes", () => {
  const hostile = {
    name: null,
    title: `${"T".repeat(300)}\nwith\twhitespace`,
    description: `${"D".repeat(500)}\nline 2`,
    readOnly: 17,
    origin: `${"https://workspace.example/"}${"a".repeat(400)}`,
    untrusted: true,
    extra: "should not affect normalization",
  };

  const normalized = normalizeTool(hostile);
  assert.equal(normalized.name, "unnamed_tool");
  assert.equal(normalized.title.length, 120);
  assert.equal(normalized.description.length, 240);
  assert.equal(normalized.kind, "unspecified");
  assert.equal(normalized.untrusted, true);

  const normalizedInspection = normalizeInspection({ kind: "ready", tools: hostile });
  assert.equal(normalizedInspection.kind, "empty");
  assert.deepEqual(normalizedInspection.tools, []);

  const malformedInspection = normalizeInspection({ kind: "ready", tools: [{ title: "Only title" }] });
  assert.equal(malformedInspection.kind, "ready");
  assert.equal(malformedInspection.tools[0].name, "unnamed_tool");
  assert.equal(malformedInspection.tools[0].title, "Only title");
});

test("legacy insurance-like domain language is rejected from current-page and app-facing source", () => {
  const forbiddenTerms = [
    /\binsurance\b/i,
    /\bcoverage\b/i,
    /\bpremium\b/i,
    /\bdeductible\b/i,
    /\brenewal\b/i,
    /\binbox\b/i,
    /\bpayment instrument\b/i,
  ];

  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  const sources = [
    "../extension/popup.js",
    "../extension/popup.html",
    "../extension/manifest.json",
    "../app/app.js",
    "../app/receipt.js",
    "../app/domain.js",
  ];

  for (const relativePath of sources) {
    const source = readFileSync(path.resolve(baseDir, relativePath), "utf8");
    for (const term of forbiddenTerms) {
      assert.equal(term.test(source), false, `${relativePath} contains forbidden legacy term ${term}`);
    }
  }
});
