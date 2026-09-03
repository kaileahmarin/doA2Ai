const count = document.querySelector("#rule-count");
const list = document.querySelector("#rule-list");
const starterList = document.querySelector("#starter-rule-list");
const message = document.querySelector("#message");
const target = document.querySelector("#rule-target");
const toolSelect = document.querySelector("#rule-tool");
const toolDetail = document.querySelector("#rule-tool-detail");
const schemaDetails = document.querySelector("#rule-schema-details");
const schema = document.querySelector("#rule-schema");
const argumentsInput = document.querySelector("#rule-arguments");
const confirmInput = document.querySelector("#rule-confirm");
const createButton = document.querySelector("#create-rule");
const refreshButton = document.querySelector("#refresh-rule-target");
const setupMessage = document.querySelector("#setup-message");
const requestedTabId = new URLSearchParams(window.location.search).get("tab");

let currentPage = null;

function send(payload) {
  return chrome.runtime.sendMessage(payload).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "Rules unavailable");
    return response;
  });
}

function showSetupMessage(text = "", tone = "neutral") {
  setupMessage.textContent = text;
  setupMessage.dataset.tone = tone;
}

function displayPageUrl(value) {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "Current HTTPS page";
  }
}

function selectedTool() {
  return currentPage?.tools?.find((tool) => tool.name === toolSelect.value) || null;
}

function setFormEnabled(enabled) {
  toolSelect.disabled = !enabled;
  argumentsInput.disabled = !enabled;
  confirmInput.disabled = !enabled;
  createButton.disabled = !enabled;
  refreshButton.disabled = false;
}

function renderSelectedTool({ resetArguments = false } = {}) {
  const tool = selectedTool();
  if (resetArguments) argumentsInput.value = "{}";
  schemaDetails.hidden = !tool;
  schema.textContent = tool ? JSON.stringify(tool.inputSchema, null, 2) : "{}";
  if (!tool) {
    toolDetail.textContent = "Select a tool exposed by the current page.";
    setFormEnabled(false);
    return;
  }
  const impact = tool.impact || {};
  const impactSummary = [impact.effect, impact.recipient, impact.reversible === true ? "reversible" : null].filter(Boolean).join(" · ");
  toolDetail.textContent = [tool.description, `Impact: ${impactSummary || "unknown"}`, tool.eligible ? "Eligible for an exact reusable rule." : `Review required: ${tool.eligibilityReason || "impact is not eligible."}`].filter(Boolean).join(" ");
  setFormEnabled(tool.eligible === true);
}

function renderToolOptions(page) {
  toolSelect.replaceChildren();
  const tools = Array.isArray(page?.tools) ? page.tools : [];
  for (const tool of tools) {
    const option = document.createElement("option");
    option.value = tool.name;
    option.textContent = tool.eligible ? `${tool.title || tool.name} · ${tool.name}` : `${tool.title || tool.name} · review required`;
    option.disabled = tool.eligible !== true;
    toolSelect.append(option);
  }
  const firstEligible = tools.find((tool) => tool.eligible === true);
  if (firstEligible) toolSelect.value = firstEligible.name;
  else if (tools[0]) toolSelect.value = tools[0].name;
  else {
    const option = document.createElement("option");
    option.textContent = "No WebMCP tools exposed";
    option.value = "";
    toolSelect.append(option);
  }
  renderSelectedTool({ resetArguments: true });
}

async function refreshSetup() {
  currentPage = null;
  setFormEnabled(false);
  toolSelect.replaceChildren();
  const loading = document.createElement("option");
  loading.textContent = "Loading available tools…";
  loading.value = "";
  toolSelect.append(loading);
  target.textContent = "Loading the current protected page…";
  showSetupMessage("");
  try {
    const response = await send({ type: "rules.current", tabId: requestedTabId });
    currentPage = response.page;
    target.textContent = `${currentPage.title} · ${currentPage.origin} · ${displayPageUrl(currentPage.pageUrl)}`;
    renderToolOptions(currentPage);
    if (!currentPage.tools.some((tool) => tool.eligible === true)) {
      showSetupMessage("No current tool is eligible for pre-agent setup. Sensitive, external, destructive, and uncertain actions stay review-only.", "warning");
    }
  } catch (error) {
    target.textContent = "No current protected HTTPS page is available.";
    showSetupMessage("Open an enabled WebMCP page, then refresh this view to set up an exact rule.", "warning");
    schemaDetails.hidden = true;
    schema.textContent = "{}";
    toolSelect.replaceChildren();
    const unavailable = document.createElement("option");
    unavailable.textContent = "No protected page available";
    unavailable.value = "";
    toolSelect.append(unavailable);
    toolDetail.textContent = error.message;
  }
}

async function refreshRules() {
  const { rules = [], starterRules = [] } = await send({ type: "rules.list" });
  list.replaceChildren();
  starterList.replaceChildren();
  const active = rules.filter((rule) => !rule.revokedAt);
  const activeStarter = starterRules.filter((rule) => rule.active === true);
  count.textContent = `${activeStarter.length + active.length} active`;
  for (const rule of starterRules) {
    const article = document.createElement("article");
    article.className = "receipt-row";
    const heading = document.createElement("h3");
    heading.textContent = rule.title;
    const detail = document.createElement("p");
    detail.textContent = `${rule.decision.toUpperCase()} · ${rule.description}`;
    const state = document.createElement("p");
    state.className = "field-help";
    state.textContent = rule.active ? "Active built-in rule" : "Activates after starter-policy confirmation";
    article.append(heading, detail, state);
    starterList.append(article);
  }
  if (rules.length === 0) {
    const empty = document.createElement("p");
    empty.className = "summary";
    empty.textContent = "No custom reusable rule has been confirmed yet. The built-in starter rules above remain active.";
    list.append(empty);
    return;
  }
  for (const rule of rules) {
    const article = document.createElement("article");
    article.className = "receipt-row";
    const heading = document.createElement("h3");
    heading.textContent = rule.decision === "block" ? "Always block" : rule.scope === "task" ? "Allow for task" : "Allow across tasks";
    const detail = document.createElement("p");
    detail.textContent = [
      rule.origin,
      rule.toolName,
      rule.scope,
      rule.argumentDigest ? `arguments ${rule.argumentDigest.slice(0, 16)}…` : null,
      rule.expiresAt ? `expires ${rule.expiresAt}` : null,
      rule.revokedAt ? `revoked ${rule.revokedAt}` : null,
    ].filter(Boolean).join(" · ");
    article.append(heading, detail);
    if (!rule.revokedAt) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary danger";
      button.textContent = "Revoke rule";
      button.addEventListener("click", async () => {
        if (!window.confirm("Revoke this exact rule now? Future matching actions will be evaluated without it.")) return;
        button.disabled = true;
        try { await send({ type: "rule.revoke", ruleId: rule.id }); await refreshRules(); }
        catch (error) { message.textContent = error.message; button.disabled = false; }
      });
      article.append(button);
    }
    list.append(article);
  }
}

toolSelect.addEventListener("change", () => renderSelectedTool({ resetArguments: true }));
refreshButton.addEventListener("click", () => {
  void refreshSetup().catch((error) => { showSetupMessage(error.message, "danger"); });
});
createButton.addEventListener("click", async () => {
  const tool = selectedTool();
  if (!currentPage || !tool || !tool.eligible) return;
  if (!confirmInput.checked) {
    showSetupMessage("Confirm the exact page, tool, and arguments first.", "warning");
    return;
  }
  let args;
  try {
    args = JSON.parse(argumentsInput.value);
  } catch {
    showSetupMessage("Arguments must be valid JSON.", "danger");
    return;
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    showSetupMessage("Arguments must be a JSON object.", "danger");
    return;
  }
  if (!window.confirm(`Create an exact reusable rule for ${tool.name} on ${currentPage.origin}? Only this JSON argument digest will run without another prompt.`)) return;
  createButton.disabled = true;
  refreshButton.disabled = true;
  showSetupMessage("Confirming the exact rule…");
  try {
    const result = await send({
      type: "rule.create",
      confirm: true,
      tabId: currentPage.tabId,
      pageUrl: currentPage.pageUrl,
      documentKey: currentPage.documentKey,
      catalogRevision: currentPage.catalogRevision,
      toolName: tool.name,
      toolDigest: tool.toolDigest,
      arguments: args,
    });
    const outcomeMessage = result.duplicate ? "That exact reusable rule is already confirmed." : "Exact reusable rule created. Matching actions can now proceed without another prompt.";
    confirmInput.checked = false;
    await Promise.all([refreshSetup(), refreshRules()]);
    showSetupMessage(outcomeMessage, "success");
  } catch (error) {
    showSetupMessage(error.message, "danger");
    renderSelectedTool();
  }
});

Promise.all([
  refreshSetup(),
  refreshRules(),
]).catch((error) => {
  message.textContent = error.message;
  count.textContent = "Unavailable";
  count.dataset.tone = "danger";
});
