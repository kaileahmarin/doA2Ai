const MAX_TEXT_LENGTH = 240;
const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);

function cleanText(value, fallback = "", maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== "string") return fallback;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return fallback;
  return compact.slice(0, maxLength);
}

export function setTextIfChanged(node, value) {
  const nextValue = String(value);
  if (node.textContent === nextValue) return false;
  node.textContent = nextValue;
  return true;
}

export function sameToolPresentation(left = [], right = []) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const fields = ["name", "title", "description", "kind", "origin", "untrusted"];
  return left.every((tool, index) => fields.every((field) => tool[field] === right[index]?.[field]));
}

export function isInspectableUrl(value) {
  try {
    return SUPPORTED_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function presentTab(tab = {}) {
  const url = cleanText(tab.url, "");
  let origin = "Current tab";
  let inspectable = false;
  try {
    const parsed = new URL(url);
    inspectable = SUPPORTED_PROTOCOLS.has(parsed.protocol);
    origin = inspectable ? parsed.origin : "Browser page";
  } catch {
    // The restricted state supplies the visible explanation.
  }

  return Object.freeze({
    id: Number.isInteger(tab.id) ? tab.id : null,
    title: cleanText(tab.title, "Current page", 120),
    origin: cleanText(origin, "Current tab", 120),
    inspectable,
  });
}

export function isCurrentInspection({
  generation,
  latestGeneration,
  requestedTab = {},
  currentTab = {},
  observedPageUrl = "",
  stale = false,
} = {}) {
  if (stale || generation !== latestGeneration) return false;
  if (!Number.isInteger(requestedTab.id) || requestedTab.id !== currentTab.id) return false;
  if (typeof requestedTab.url !== "string" || !requestedTab.url) return false;
  return requestedTab.url === currentTab.url && observedPageUrl === requestedTab.url;
}

export function normalizeTool(tool = {}) {
  const name = cleanText(tool.name, "unnamed_tool", 128);
  const title = cleanText(tool.title, name.replaceAll("_", " "), 120);
  return Object.freeze({
    name,
    title,
    description: cleanText(tool.description, "Available to the agent on this page."),
    kind: tool.readOnly === true ? "read" : tool.readOnly === false ? "action" : "unspecified",
    origin: cleanText(tool.origin, "", 160),
    untrusted: tool.untrusted === true,
  });
}

export function normalizeInspection(value = {}) {
  const allowedKinds = new Set([
    "checking",
    "restricted",
    "unsupported",
    "listing_unavailable",
    "ready",
    "empty",
    "error",
  ]);
  const kind = allowedKinds.has(value.kind) ? value.kind : "error";
  const tools = Array.isArray(value.tools)
    ? value.tools.map(normalizeTool).sort((left, right) => left.title.localeCompare(right.title))
    : [];

  if (kind === "ready" && tools.length === 0) return Object.freeze({ kind: "empty", tools });
  if (kind !== "ready" && kind !== "empty") return Object.freeze({ kind, tools: [] });
  return Object.freeze({ kind, tools });
}

export function viewCopy(inspection) {
  const count = inspection.tools.length;
  const copy = {
    checking: {
      title: "Checking WebMCP",
      detail: "Reading the capabilities exposed by this page.",
      empty: "Capabilities will appear here when the page exposes them.",
    },
    restricted: {
      title: "Unavailable on this page",
      detail: "The browser does not allow extension access to this address.",
      empty: "Open an ordinary website, then use Current page again.",
    },
    unsupported: {
      title: "No WebMCP tools",
      detail: "This page has not exposed capabilities to the browser.",
      empty: "Nothing has been added or inferred for this page.",
    },
    listing_unavailable: {
      title: "WebMCP detected",
      detail: "This browser build cannot list the page's current tools.",
      empty: "Capability discovery is unavailable in this browser build.",
    },
    empty: {
      title: "No tools exposed",
      detail: "WebMCP is available, but this page returned an empty tool registry.",
      empty: "The page must register a WebMCP tool before this extension can list or enable it.",
    },
    ready: {
      title: "Tools available",
      detail: `${count} current-page ${count === 1 ? "capability" : "capabilities"} available.`,
      empty: "",
    },
    error: {
      title: "Could not read this page",
      detail: "Capability discovery failed without changing the page.",
      empty: "Refresh the page, then try again.",
    },
  };
  return Object.freeze(copy[inspection.kind] ?? copy.error);
}
