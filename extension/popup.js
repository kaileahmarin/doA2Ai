import {
  isCurrentInspection,
  normalizeInspection,
  presentTab,
  sameToolPresentation,
  setTextIfChanged,
  viewCopy,
} from "./view-model.js";

const panel = document.querySelector(".panel");
const pageTitle = document.querySelector("#panel-title");
const pageOrigin = document.querySelector("#page-origin");
const statusTitle = document.querySelector("#status-title");
const statusDetail = document.querySelector("#status-detail");
const statusCount = document.querySelector("#status-count");
const capabilityList = document.querySelector("#capability-list");
const emptyState = document.querySelector("#empty-state");
const emptyCopy = document.querySelector("#empty-copy");
const liveLabel = document.querySelector("#live-label");
const refreshButton = document.querySelector("#refresh-button");

let refreshInFlight = false;
let autoRefreshEnabled = true;
let refreshGeneration = 0;
let renderedTools = [];

function withTimeout(promise, timeoutMs) {
  let timeoutId;
  const race = Promise.race([
    promise,
    new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => reject(new Error("CAPABILITY_DISCOVERY_TIMEOUT")), timeoutMs);
    }),
  ]);
  return race.finally(() => window.clearTimeout(timeoutId));
}

function renderTool(tool) {
  const item = document.createElement("li");
  item.className = "tool-card";

  const glyph = document.createElement("span");
  glyph.className = "tool-glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = tool.kind === "read" ? "⌕" : tool.kind === "action" ? "↗" : "·";

  const copy = document.createElement("div");
  copy.className = "tool-copy";

  const title = document.createElement("p");
  title.className = "tool-title";
  title.textContent = tool.title;

  const description = document.createElement("p");
  description.className = "tool-description";
  description.textContent = tool.description;

  copy.append(title, description);
  if (tool.origin) {
    const origin = document.createElement("p");
    origin.className = "tool-origin";
    origin.textContent = tool.origin;
    copy.append(origin);
  }
  item.append(glyph, copy);

  const badges = document.createElement("div");
  badges.className = "tool-badges";
  if (tool.kind !== "unspecified") {
    const kind = document.createElement("span");
    kind.className = "tool-kind";
    kind.dataset.kind = tool.kind;
    kind.textContent = tool.kind;
    badges.append(kind);
  }
  if (tool.untrusted) {
    const untrusted = document.createElement("span");
    untrusted.className = "tool-kind";
    untrusted.dataset.kind = "untrusted";
    untrusted.textContent = "Untrusted";
    badges.append(untrusted);
  }
  item.append(badges);

  return item;
}

function render(tab, inspection) {
  const copy = viewCopy(inspection);
  panel.dataset.state = inspection.kind;
  setTextIfChanged(pageTitle, tab.title);
  setTextIfChanged(pageOrigin, tab.origin);
  setTextIfChanged(statusTitle, copy.title);
  setTextIfChanged(statusDetail, copy.detail);
  setTextIfChanged(emptyCopy, copy.empty);

  if (!sameToolPresentation(renderedTools, inspection.tools)) {
    capabilityList.replaceChildren(...inspection.tools.map(renderTool));
    renderedTools = inspection.tools;
  }
  const hasTools = inspection.tools.length > 0;
  capabilityList.hidden = !hasTools;
  emptyState.hidden = hasTools;
  liveLabel.hidden = inspection.kind !== "ready" && inspection.kind !== "empty";
  statusCount.hidden = !hasTools;
  setTextIfChanged(statusCount, hasTools ? inspection.tools.length : "");
}

async function inspectPage(tabId) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async () => {
      const pageUrl = location.href;
      const documentTimeOrigin = performance.timeOrigin;
      const result = (inspection) => ({ pageUrl, stale: false, inspection });
      const context = document.modelContext;
      if (!context) return result({ kind: "unsupported", tools: [] });
      if (typeof context.getTools !== "function") return result({ kind: "listing_unavailable", tools: [] });

      try {
        const tools = await context.getTools();
        if (location.href !== pageUrl || performance.timeOrigin !== documentTimeOrigin) return { stale: true };
        return result({
          kind: tools.length > 0 ? "ready" : "empty",
          tools: tools.map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            origin: tool.origin,
            readOnly:
              typeof tool.annotations?.readOnlyHint === "boolean"
                ? tool.annotations.readOnlyHint
                : undefined,
            untrusted: tool.annotations?.untrustedContentHint === true,
          })),
        });
      } catch {
        return result({ kind: "error", tools: [] });
      }
    },
  });
  const result = injection?.result;
  if (!result?.inspection) return { stale: true, observedPageUrl: "", inspection: normalizeInspection({ kind: "error" }) };
  return {
    stale: result.stale === true,
    observedPageUrl: typeof result.pageUrl === "string" ? result.pageUrl : "",
    inspection: normalizeInspection(result.inspection),
  };
}

async function currentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? {};
}

async function refresh({ manual = false } = {}) {
  if (refreshInFlight) return;
  if (manual) autoRefreshEnabled = true;
  refreshInFlight = true;
  const generation = ++refreshGeneration;
  let inspectedTab = null;
  let inspectedSourceTab = null;
  refreshButton.setAttribute("aria-busy", "true");

  try {
    if (!globalThis.chrome?.tabs || !globalThis.chrome?.scripting) {
      render(presentTab(), normalizeInspection({ kind: "error" }));
      return;
    }

    inspectedSourceTab = await currentTab();
    inspectedTab = presentTab(inspectedSourceTab);
    if (!inspectedTab.inspectable || inspectedTab.id === null) {
      render(inspectedTab, normalizeInspection({ kind: "restricted" }));
      return;
    }
    const discovery = await withTimeout(inspectPage(inspectedTab.id), 1200);
    const currentSourceTab = await currentTab();
    if (
      !isCurrentInspection({
        generation,
        latestGeneration: refreshGeneration,
        requestedTab: inspectedSourceTab,
        currentTab: currentSourceTab,
        observedPageUrl: discovery.observedPageUrl,
        stale: discovery.stale,
      })
    ) return;
    render(presentTab(currentSourceTab), discovery.inspection);
  } catch {
    autoRefreshEnabled = false;
    const sourceTab = await currentTab().catch(() => ({}));
    const tab = presentTab(sourceTab);
    const stillCurrent = !inspectedSourceTab || isCurrentInspection({
      generation,
      latestGeneration: refreshGeneration,
      requestedTab: inspectedSourceTab,
      currentTab: sourceTab,
      observedPageUrl: inspectedSourceTab.url,
    });
    if (generation === refreshGeneration && stillCurrent) {
      render(tab, normalizeInspection({ kind: "error" }));
    }
  } finally {
    if (generation === refreshGeneration) {
      refreshButton.setAttribute("aria-busy", "false");
      refreshInFlight = false;
    }
  }
}

refreshButton.addEventListener("click", () => refresh({ manual: true }));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});

await refresh();
const liveRefresh = window.setInterval(() => {
  if (autoRefreshEnabled) refresh();
}, 1500);
window.addEventListener("unload", () => window.clearInterval(liveRefresh), { once: true });
