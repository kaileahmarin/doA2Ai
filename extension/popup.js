const elements = {
  appState: document.querySelector("#app-state"),
  pageStatus: document.querySelector("#page-status"),
  pageTitle: document.querySelector("#page-title"),
  pageOrigin: document.querySelector("#page-origin"),
  capabilityState: document.querySelector("#capability-state"),
  enablePanel: document.querySelector("#enable-panel"),
  activePanel: document.querySelector("#active-panel"),
  enableButton: document.querySelector("#enable-button"),
  policyConfirm: document.querySelector("#policy-confirm"),
  pauseButton: document.querySelector("#pause-button"),
  revokeButton: document.querySelector("#revoke-button"),
  taskCount: document.querySelector("#task-count"),
  reviewCount: document.querySelector("#review-count"),
  blockedCount: document.querySelector("#blocked-count"),
  tasksButton: document.querySelector("#tasks-button"),
  reviewsButton: document.querySelector("#reviews-button"),
  activityButton: document.querySelector("#activity-button"),
  rulesButton: document.querySelector("#rules-button"),
  controlButton: document.querySelector("#control-button"),
  setupButton: document.querySelector("#setup-button"),
  message: document.querySelector("#message"),
};

let refreshing = false;

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function setTone(element, tone) {
  element.dataset.tone = tone;
}

function setMessage(text = "", tone = "neutral") {
  elements.message.textContent = text;
  setTone(elements.message, tone);
}

function render(state) {
  const enabled = Boolean(state?.enabled);
  const paused = Boolean(state?.paused);
  const page = state?.currentPage ?? {};
  const counts = state?.counts ?? {};

  elements.enablePanel.hidden = enabled;
  elements.activePanel.hidden = !enabled;
  elements.taskCount.textContent = String(counts.tasks ?? 0);
  elements.reviewCount.textContent = String(counts.pendingReviews ?? 0);
  elements.blockedCount.textContent = String(counts.blocked ?? 0);

  if (!enabled) {
    elements.appState.textContent = "Not enabled";
    setTone(elements.appState, "neutral");
  } else if (paused) {
    elements.appState.textContent = "Paused";
    setTone(elements.appState, "warning");
  } else if (state?.connection?.status === "degraded") {
    elements.appState.textContent = "Limited";
    setTone(elements.appState, "warning");
  } else {
    elements.appState.textContent = "Active";
    setTone(elements.appState, "success");
  }

  elements.pauseButton.textContent = paused ? "Resume" : "Pause";
  elements.pauseButton.disabled = !enabled;
  elements.revokeButton.disabled = !page.taskId;

  elements.pageTitle.textContent = page.title || "Current page";
  elements.pageOrigin.textContent = page.origin || "Open an HTTPS page";

  if (!page.inspectable) {
    elements.capabilityState.textContent = page.detail || "This page cannot be inspected by the extension.";
    setTone(elements.pageStatus, "neutral");
  } else if (page.protected && Number(page.protectedToolCount) > 0) {
    const count = Number(page.protectedToolCount);
    elements.capabilityState.textContent = `${count} protected WebMCP ${count === 1 ? "tool" : "tools"} available to agents.`;
    setTone(elements.pageStatus, "success");
  } else if (page.detail) {
    elements.capabilityState.textContent = page.detail;
    setTone(elements.pageStatus, enabled ? "warning" : "neutral");
  } else {
    elements.capabilityState.textContent = "No WebMCP tools detected on this page.";
    setTone(elements.pageStatus, "neutral");
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await sendMessage({ type: "product.state" });
    if (!response?.ok) throw new Error(response?.error || "State unavailable");
    render(response.state);
  } catch (error) {
    setMessage(error.message, "danger");
  } finally {
    refreshing = false;
  }
}

async function runAction(action, busyText) {
  setMessage(busyText);
  try {
    const response = await action();
    if (!response?.ok) throw new Error(response?.error || "Action failed");
    setMessage("");
    await refresh();
  } catch (error) {
    setMessage(error.message, "danger");
  }
}

elements.policyConfirm.addEventListener("change", () => {
  elements.enableButton.disabled = !elements.policyConfirm.checked;
});

elements.enableButton.addEventListener("click", () => runAction(async () => {
  if (!elements.policyConfirm.checked) throw new Error("Confirm the starter policy first.");
  const granted = await chrome.permissions.request({ origins: ["https://*/*"] });
  if (!granted) throw new Error("Permission was not granted.");
  return sendMessage({ type: "product.enable", confirmStarterPolicy: true });
}, "Enabling…"));

elements.pauseButton.addEventListener("click", () => runAction(
  () => sendMessage({ type: "product.pause" }),
  "Updating…",
));

elements.revokeButton.addEventListener("click", () => runAction(
  () => sendMessage({ type: "task.revoke" }),
  "Ending task…",
));

elements.tasksButton.addEventListener("click", () => sendMessage({ type: "page.open_tasks" }));
elements.activityButton.addEventListener("click", () => sendMessage({ type: "page.open_activity" }));
elements.rulesButton.addEventListener("click", () => sendMessage({ type: "page.open_rules" }));
elements.controlButton.addEventListener("click", () => sendMessage({ type: "page.open_control", view: "overview" }));
elements.reviewsButton.addEventListener("click", () => sendMessage({ type: "page.open_review" }));
elements.setupButton.addEventListener("click", () => sendMessage({ type: "page.open_setup" }));

refresh();
setInterval(refresh, 1500);
