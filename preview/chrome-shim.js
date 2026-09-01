const parameters = new URLSearchParams(window.location.search);
const requestedState = parameters.get("state") ?? "ready";

const sampleTools = [
  {
    name: "search_page",
    title: "Search page",
    description: "Find relevant passages in the current workspace.",
    origin: "https://research.example",
    readOnly: true,
    untrusted: false,
  },
  {
    name: "outline_topics",
    title: "Outline topics",
    description: "Organize the page into a concise working outline.",
    origin: "https://research.example",
    readOnly: true,
    untrusted: false,
  },
  {
    name: "draft_note",
    title: "Draft note",
    description: "Prepare a note inside the page-owned workspace.",
    origin: "https://research.example",
    readOnly: false,
    untrusted: false,
  },
];

function sampleInspection() {
  if (requestedState === "empty") return { kind: "empty", tools: [] };
  if (requestedState === "unsupported") return { kind: "unsupported", tools: [] };
  if (requestedState === "listing_unavailable") return { kind: "listing_unavailable", tools: [] };
  if (requestedState === "error") return { kind: "error", tools: [] };
  return { kind: "ready", tools: sampleTools, omitted: 0 };
}

function sampleTab() {
  return requestedState === "restricted"
    ? { id: 1, title: "Browser settings", url: "chrome://extensions/" }
    : {
        id: 1,
        title: "Collaborative Research",
        url: "https://research.example/workspace",
      };
}

const previewChrome = {
  tabs: {
    async query() {
      return [sampleTab()];
    },
  },
  scripting: {
    async executeScript() {
      return [
        {
          result: {
            pageUrl: sampleTab().url,
            stale: false,
            inspection: sampleInspection(),
          },
        },
      ];
    },
  },
};

try {
  Object.defineProperty(window, "chrome", {
    configurable: true,
    value: previewChrome,
  });
} catch {
  window.chrome.tabs = previewChrome.tabs;
  window.chrome.scripting = previewChrome.scripting;
}
