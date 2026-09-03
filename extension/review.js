const nodes = {
  title: document.querySelector("#title"),
  status: document.querySelector("#action-status"),
  summary: document.querySelector("#summary"),
  reason: document.querySelector("#reason"),
  impact: document.querySelector("#impact"),
  task: document.querySelector("#task"),
  pageTitle: document.querySelector("#page-title"),
  pageOrigin: document.querySelector("#page-origin"),
  toolName: document.querySelector("#tool-name"),
  toolDescription: document.querySelector("#tool-description"),
  actionId: document.querySelector("#action-id"),
  actionDigest: document.querySelector("#action-digest"),
  arguments: document.querySelector("#arguments"),
  decisionBar: document.querySelector("#decision-bar"),
  approveButton: document.querySelector("#approve-button"),
  denyButton: document.querySelector("#deny-button"),
  moreOptions: document.querySelector("#more-options"),
  ruleCandidateSummary: document.querySelector("#rule-candidate-summary"),
  receiptButton: document.querySelector("#receipt-button"),
  message: document.querySelector("#message"),
};

const requestedActionId = new URL(location.href).searchParams.get("action") || "";
let currentActionId = requestedActionId;
let receiptId = "";
let polling = true;

function send(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "Request failed");
    return response;
  });
}

function impactCopy(impact = {}) {
  const pieces = [];
  if (impact.effect && impact.effect !== "unknown") pieces.push(impact.effect);
  if (impact.recipient === "external") pieces.push("external recipient");
  if (impact.sensitive_data) pieces.push("sensitive data");
  if (impact.financial?.amount > 0) pieces.push(`${impact.financial.amount} ${impact.financial.currency}`);
  if (impact.human_presence) pieces.push("human presence required");
  if (impact.reversible === false) pieces.push("not reversible");
  return pieces.length ? pieces.join(" · ") : "Impact information is incomplete";
}

function render(action) {
  currentActionId = action.actionId || currentActionId;
  receiptId = action.receiptId || "";
  const pending = action.status === "pending_review";
  nodes.title.textContent = action.tool?.title || action.tool?.name || "Proposed action";
  nodes.status.textContent = pending ? "Needs you" : action.status || "Unknown";
  nodes.status.dataset.tone = pending ? "warning" : action.status === "completed" ? "success" : "neutral";
  nodes.summary.textContent = pending
    ? action.humanPresenceRequired
      ? "The agent reached a final checkout, payment, purchase, or submit boundary. Nothing will be dispatched until you approve this exact transaction."
      : "The agent paused at the authority boundary. Nothing will be dispatched until you decide."
    : `This action is ${String(action.status || "unknown").replaceAll("_", " ")}.`;
  if (pending && action.privateInputsRedacted) {
    nodes.summary.textContent += action.privateInputsAvailable
      ? " Private values are held only in memory and appear redacted below; verify the target page before approving."
      : " Private values are no longer available; retry the action instead of approving it.";
  }
  nodes.reason.textContent = action.authority?.explanation || action.authority?.reason || "The action is outside currently confirmed authority.";
  nodes.impact.textContent = impactCopy(action.impact);
  nodes.task.textContent = action.task?.label || action.task?.taskId || "Current browser task";
  nodes.pageTitle.textContent = action.page?.title || "Current page";
  nodes.pageOrigin.textContent = action.page?.origin || "Unknown origin";
  nodes.toolName.textContent = action.tool?.name || "Unknown tool";
  nodes.toolDescription.textContent = action.tool?.description || "No description supplied by the page.";
  nodes.actionId.textContent = currentActionId || "Unavailable";
  nodes.actionDigest.textContent = action.actionDigest || "Unavailable";
  nodes.arguments.textContent = JSON.stringify(action.arguments ?? {}, null, 2);
  nodes.decisionBar.hidden = !pending;
  const candidate = action.ruleCandidate;
  nodes.moreOptions.hidden = !pending || !candidate;
  if (candidate) {
    const familiarity = candidate.observedCount > 1
      ? `This exact boundary has been observed ${candidate.observedCount} times.`
      : "This exact boundary was observed during the current agent task.";
    nodes.ruleCandidateSummary.textContent = `${familiarity} Saving it still requires your explicit confirmation and binds only ${candidate.origin}, ${candidate.toolName}, tool definition ${candidate.toolDefinitionDigest.slice(0, 16)}…, and arguments ${candidate.argumentDigest.slice(0, 16)}….`;
  }
  for (const button of document.querySelectorAll('[data-decision^="allow_"]')) {
    button.hidden = !pending || action.reusableAllowEligible !== true;
  }
  nodes.receiptButton.hidden = !receiptId;
  polling = pending;
}

async function refresh() {
  const response = await send({ type: "review.get", actionId: currentActionId || null });
  render(response.action);
}

async function decide(decision) {
  const reusable = decision === "allow_task" || decision === "allow_universal";
  const confirmReusable = reusable
    ? window.confirm(decision === "allow_task"
      ? "Confirm a temporary task rule for this exact site, tool definition, and arguments. This grants authority beyond this one action until the task ends or expires."
      : "Confirm a reusable rule for this exact site, tool definition, and arguments across tasks. You can review and revoke it from Rules.")
    : false;
  if (reusable && !confirmReusable) {
    nodes.message.textContent = "Reusable authority was not created.";
    return;
  }
  for (const button of document.querySelectorAll("button")) button.disabled = true;
  nodes.message.textContent = decision === "deny" || decision === "block" ? "Recording the block…" : "Recording your authority…";
  try {
    const response = await send({
      type: "review.decide",
      actionId: currentActionId,
      decision,
      confirmReusable,
    });
    render(response.action);
    nodes.message.textContent = response.action?.status === "pending_review"
      ? "The decision still needs confirmation."
      : "Decision recorded.";
  } catch (error) {
    nodes.message.textContent = error.message;
  } finally {
    for (const button of document.querySelectorAll("button")) button.disabled = false;
  }
}

nodes.approveButton.addEventListener("click", () => decide("approve_once"));
nodes.denyButton.addEventListener("click", () => decide("deny"));
for (const button of document.querySelectorAll("[data-decision]")) {
  button.addEventListener("click", () => decide(button.dataset.decision));
}
nodes.receiptButton.addEventListener("click", () => send({ type: "page.open_receipt", receiptId }));

refresh().catch((error) => {
  nodes.title.textContent = "Review unavailable";
  nodes.summary.textContent = error.message;
  nodes.status.textContent = "Unavailable";
  nodes.status.dataset.tone = "danger";
});

const timer = setInterval(() => {
  if (polling && !document.hidden) refresh().catch(() => {});
}, 1500);
addEventListener("unload", () => clearInterval(timer), { once: true });
