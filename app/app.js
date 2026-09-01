import { ResearchBriefEngine, createAgentToolDefinitions, format } from "./domain.js";
import { BoundedToolRegistry, WebMcpBridge } from "./webmcp.js";
import { receiptOutcomeCopy, redactReceipt } from "./receipt.js";

const origin = window.location.origin === "null" ? "https://bounded-demo.local" : window.location.origin;
const engine = new ResearchBriefEngine({ origin });
const registry = new BoundedToolRegistry();
const bridge = new WebMcpBridge();

const byId = (id) => document.getElementById(id);
const dialog = byId("handoff-dialog");
const reviewView = byId("review-view");
const processingView = byId("processing-view");
const receiptView = byId("receipt-view");
const runAgentButton = byId("run-agent");
const sharingConfirmation = byId("sharing-confirmation");
const authorizeButton = byId("authorize");
const lengthSelect = byId("review-length");
const audienceSelect = byId("review-audience");
const divergenceToggle = byId("simulate-divergence");
const viewReceiptButton = byId("view-receipt");

let demoRunning = false;
let bridgeTimer = null;
let lastBridgeStatus = null;

const taskLabels = {
  preparing: "Agent preparing",
  awaiting_human: "Waiting for you",
  authorized: "Authorized",
  executing: "Executing",
  verifying: "Verifying",
  completed: "Completed",
  blocked: "Blocked",
  cancelled: "Cancelled",
  failed: "Needs attention",
};

const toolLabels = {
  read_research_sources: ["Read scoped sources", "Only this task's source set"],
  compose_research_brief: ["Compose bounded brief", "Use the required citation style"],
  prepare_brief_share: ["Prepare authority docket", "No authorization or execution"],
  read_task_status: ["Read task status", "No wider page access"],
  read_receipt: ["Read redacted receipt", "Human-only inputs omitted"],
};

const activityLabels = {
  task_started: "Bounded local task created",
  sources_read: "Scoped research sources read",
  brief_composed: "Source-backed brief composed",
  brief_prepared: "Preparation complete; agent capabilities revoked",
  proposal_reviewed: "Prepared values reviewed",
  authorization_granted: "Exact, single-use authorization granted",
  authorization_denied: "Decision recorded; no execution attempted",
  authorization_expired: "Execution blocked before authorization could be used",
  brief_expired: "Execution blocked because the prepared brief expired",
  authorization_consumed: "Single-use authority consumed for the local attempt",
  execution_blocked: "Candidate mismatch detected before execution",
  execution_verified: "Committed state exactly matched authorization",
  execution_divergent: "A mismatch was recorded in local readback",
  execution_failed: "Execution result could not be verified",
};

function pause(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function showToast(message) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => {
    toast.hidden = true;
  }, 3500);
}

function setText(id, value) {
  byId(id).textContent = value;
}

function syncDefinitions() {
  const definitions = createAgentToolDefinitions(engine);
  registry.setDefinitions(definitions);

  window.clearTimeout(bridgeTimer);
  bridgeTimer = window.setTimeout(async () => {
    lastBridgeStatus = await bridge.sync(definitions);
    renderBridgeStatus();
  }, 0);
}

function renderBridgeStatus() {
  const node = byId("webmcp-status");
  if (!bridge.supported) {
    node.textContent = "Local simulator";
    node.dataset.tone = "neutral";
    return;
  }
  if (lastBridgeStatus?.error) {
    node.textContent = "Registration error";
    node.dataset.tone = "warning";
    return;
  }
  const toolCount = lastBridgeStatus?.registered?.length ?? registry.list().length;
  node.textContent = `${toolCount} ${toolCount === 1 ? "tool" : "tools"} live`;
  node.dataset.tone = "success";
}

function renderTools() {
  const tools = registry.list();
  setText("tool-count", String(tools.length));
  const list = byId("tool-list");
  list.replaceChildren();

  if (!tools.length) {
    const item = document.createElement("li");
    item.className = "no-tools";
    item.innerHTML = '<span class="tool-lock" aria-hidden="true">×</span><div><strong>Agent access paused</strong><small>Human or site action in progress</small></div>';
    list.append(item);
    return;
  }

  for (const tool of tools) {
    const [label, detail] = toolLabels[tool.name] ?? [tool.title || tool.name, "Scoped to this task"];
    const item = document.createElement("li");
    item.innerHTML = `<span class="tool-check" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m3 8 3 3 7-7" /></svg></span><div><strong>${label}</strong><small>${detail}</small></div>`;
    list.append(item);
  }
}

function renderActivity(state) {
  const list = byId("activity-list");
  list.replaceChildren();
  for (const event of state.event_log.slice(-4).reverse()) {
    const item = document.createElement("li");
    const time = new Intl.DateTimeFormat("en-CA", { hour: "numeric", minute: "2-digit" }).format(new Date(event.at));
    const detail = activityLabels[event.type] ?? event.detail;
    item.innerHTML = `<i aria-hidden="true"></i><div><strong>${detail}</strong><small>${event.actor} · ${time}</small></div>`;
    list.append(item);
  }
}

function renderWorkspace(state) {
  const briefDraft = state.brief_draft;
  const draft = state.human_draft;
  const stateNode = byId("preparation-state");

  if (!briefDraft) {
    setText("brief-word-count", "—");
    setText("brief-draft-status", state.task.step === "draft" ? "Reading scoped sources…" : "Agent will inspect the bounded sources");
    setText("brief-source-scope", state.task.step === "sources" ? "Awaiting scoped read" : "Source scope loaded");
    setText("brief-share-audience", state.task.step === "sources" ? "—" : "Reviewable audience available");
  } else {
    setText("brief-word-count", format.words(draft?.word_count ?? briefDraft.word_count));
    setText("brief-draft-status", `${briefDraft.source_count} scoped sources · citation style matched`);
    setText("brief-source-scope", `${briefDraft.source_count} scoped sources · ${briefDraft.citation_style.replaceAll("_", " ")}`);
    setText("brief-share-audience", draft ? format.audience(draft.audience) : "Prepared audience ready");
  }

  const preparationCopy = {
    sources: "Waiting to prepare",
    draft: "Scoped sources loaded",
    prepare: "Brief draft composed",
    handoff: "Focused docket ready",
    authorized: "Exact state authorized",
    executing: "Recording authorized state",
    verifying: "Verifying result",
    receipt: "Local result recorded",
    divergent: state.receipt?.outcome === "executed_divergent" ? "Recorded result diverged" : "Execution blocked",
    denied: "Authorization denied",
    expired: "Authorization expired",
    failed: "Execution outcome needs review",
  }[state.task.step] ?? "Task updated";
  stateNode.querySelector("span:last-child").textContent = preparationCopy;
  stateNode.dataset.tone = state.task.state;
}

function briefFixtureLabel(briefId) {
  const raw = String(briefId ?? "BRF-4821");
  return raw.startsWith("BRF-") ? `Brief ${raw.slice(4)} (fixture)` : `${raw} (fixture)`;
}

function requestedIntentValue(intent) {
  const sourceIds = Array.isArray(intent?.constraints?.required_source_ids) ? intent.constraints.required_source_ids : [];
  const citationStyle = String(intent?.constraints?.required_citation_style ?? "required citation style").replaceAll("_", " ");
  const sourceLabel = sourceIds.length === 1 ? "1 scoped source" : `${sourceIds.length} scoped sources`;
  return `Share source-backed research brief · ${sourceLabel} · ${citationStyle}`;
}

function sourceSummary(payload) {
  const sourceIds = Array.isArray(payload?.source_ids) ? payload.source_ids : [];
  const citationStyle = String(payload?.citation_style ?? "citation style unavailable").replaceAll("_", " ");
  const sourceLabel = sourceIds.length === 1 ? "1 scoped source" : `${sourceIds.length} scoped sources`;
  return `${sourceLabel} · ${citationStyle}`;
}

function renderRail(state) {
  const pill = byId("task-state-pill");
  pill.querySelector("span").textContent = taskLabels[state.task.state] ?? state.task.state;
  pill.dataset.state = state.task.state;
  setText("lease-status", state.task.lease.status.replaceAll("_", " "));
  renderTools();
  renderActivity(state);

  const canSimulate = state.task.state === "preparing";
  const canResumeReview = state.task.state === "awaiting_human";
  runAgentButton.disabled = demoRunning || (!canSimulate && !canResumeReview);
  if (demoRunning) {
    runAgentButton.querySelector("strong").textContent = "Agent is preparing…";
    runAgentButton.querySelector("small").textContent = "Calling only the action shown above";
  } else if (canResumeReview) {
    runAgentButton.querySelector("strong").textContent = "Review focused docket";
    runAgentButton.querySelector("small").textContent = "Agent access remains paused";
  } else if (!canSimulate) {
    runAgentButton.querySelector("strong").textContent = "Task is complete";
    runAgentButton.querySelector("small").textContent = "See the task receipt below";
  } else {
    runAgentButton.querySelector("strong").textContent = "Preview bounded preparation";
    runAgentButton.querySelector("small").textContent = "Runs only the listed capabilities";
  }

  const hasReceipt = Boolean(state.receipt);
  viewReceiptButton.disabled = !hasReceipt;
  viewReceiptButton.querySelector("small").textContent = hasReceipt ? "Open the redacted local receipt" : "Available after the task ends";
}

function renderReview(state) {
  if (!state.human_draft) return;
  const draft = state.human_draft;
  setText("review-operation", "Share research brief");
  setText("review-target", briefFixtureLabel(draft.brief_id));
  setText("review-effective", format.date(draft.share_date));
  setText("review-requested-intent", requestedIntentValue(state.task.intent));
  setText("review-source-summary", sourceSummary(draft));
  lengthSelect.value = String(draft.word_count);
  audienceSelect.value = draft.audience;
  setText("review-word-count", format.words(draft.word_count));
  setText("review-change", "Prepared from the scoped source set");

  const changes = state.authority.grant?.human_modifications ?? [];
  const currentChanges = state.prepared
    ? [
        state.prepared.word_count !== state.human_draft.word_count,
        state.prepared.audience !== state.human_draft.audience,
      ].filter(Boolean).length
    : changes.length;
  const note = byId("modification-note");
  note.hidden = currentChanges === 0;
  note.textContent = currentChanges ? `${currentChanges} change${currentChanges === 1 ? "" : "s"} will be bound to your authorization.` : "";
}

function render(state) {
  document.body.dataset.taskState = state.task.state;
  renderWorkspace(state);
  renderRail(state);
  renderReview(state);

  if (state.task.state === "awaiting_human" && !dialog.open) {
    dialog.setAttribute("aria-labelledby", "handoff-title");
    reviewView.hidden = false;
    processingView.hidden = true;
    receiptView.hidden = true;
    sharingConfirmation.checked = false;
    authorizeButton.disabled = true;
    byId("form-error").hidden = true;
    dialog.showModal();
    window.setTimeout(() => lengthSelect.focus(), 80);
  }
}

async function simulatePreparation() {
  if (demoRunning || engine.snapshot().task.state !== "preparing") return;
  demoRunning = true;
  render(engine.snapshot());
  const handles = engine.handles();

  try {
    if (engine.snapshot().task.step === "sources") {
      await registry.invoke("read_research_sources", handles);
      await pause(650);
    }
    if (engine.snapshot().task.step === "draft") {
      await registry.invoke("compose_research_brief", { ...handles, citation_style: "linked_endnotes" });
      await pause(750);
    }
    if (engine.snapshot().task.step === "prepare") {
      await registry.invoke("prepare_brief_share", {
        ...handles,
        draft_id: engine.snapshot().brief_draft.draft_id,
      });
    }
  } catch (error) {
    showToast(error.message);
  } finally {
    demoRunning = false;
    render(engine.snapshot());
  }
}

function openOrSimulate() {
  if (engine.snapshot().task.state === "awaiting_human") {
    dialog.setAttribute("aria-labelledby", "handoff-title");
    dialog.showModal();
    window.setTimeout(() => lengthSelect.focus(), 80);
    return;
  }
  simulatePreparation();
}

function updateHumanDraft() {
  try {
    engine.updateHumanDraft({
      word_count: Number(lengthSelect.value),
      audience: audienceSelect.value,
    });
    byId("form-error").hidden = true;
  } catch (error) {
    const node = byId("form-error");
    node.textContent = error.message;
    node.hidden = false;
  }
}

async function authorizeAndExecute() {
  if (!sharingConfirmation.checked) return;
  authorizeButton.disabled = true;
  byId("form-error").hidden = true;

  try {
    await engine.grantAuthorization({
      sharing_confirmation: true,
      collaborator_note_id: document.querySelector('input[name="collaborator-note"]:checked')?.value ?? null,
    });
    reviewView.hidden = true;
    processingView.hidden = false;
    receiptView.hidden = true;
    dialog.setAttribute("aria-labelledby", "processing-title");
    byId("processing-title").focus();
    await pause(700);
    byId("execution-step").classList.add("active");
    await engine.executeAuthorized({ simulate_divergence: divergenceToggle.checked });
    byId("execution-step").classList.remove("active");
    byId("execution-step").classList.add(["blocked", "failed"].includes(engine.snapshot().task.state) ? "blocked" : "done");
    byId("receipt-step").classList.add("done");
    await pause(650);
    showReceipt(engine.snapshot());
  } catch (error) {
    const failedState = engine.snapshot();
    if (failedState.receipt) {
      byId("execution-step").classList.remove("active");
      byId("execution-step").classList.add("blocked");
      byId("receipt-step").classList.add("done");
      showReceipt(failedState);
      return;
    }
    processingView.hidden = true;
    reviewView.hidden = false;
    const node = byId("form-error");
    node.textContent = error.message;
    node.hidden = false;
    authorizeButton.disabled = !sharingConfirmation.checked;
  }
}

function receiptValue(payload) {
  if (!payload) return "Not executed";
  const operation = payload.operation === "share_research_brief" ? "Share research brief" : String(payload.operation ?? "Local operation");
  const draftVersion = Number.isFinite(payload.draft_version) ? `draft v${payload.draft_version}` : "draft version unavailable";
  return `${operation} · ${briefFixtureLabel(payload.brief_id)} · ${format.date(payload.share_date)} · ${sourceSummary(payload)} · ${format.words(payload.word_count)} · ${format.audience(payload.audience)} · ${draftVersion}`;
}

function showReceipt(state) {
  const receipt = state.receipt;
  const presentation = receiptOutcomeCopy(receipt.outcome);
  reviewView.hidden = true;
  processingView.hidden = true;
  receiptView.hidden = false;
  dialog.setAttribute("aria-labelledby", "receipt-title");

  receiptView.dataset.outcome = receipt.outcome;
  receiptView.dataset.tone = presentation.tone;
  setText("receipt-eyebrow", `${presentation.eyebrow} · source-backed brief fixture`);
  setText("receipt-title", presentation.title);
  setText("receipt-subtitle", presentation.subtitle);

  const authorized = receipt.authorized_state;
  const executed = receipt.executed_state;
  const attempted = receipt.attempted_state;
  const consequenceState =
    presentation.consequenceKind === "executed" ? executed : presentation.consequenceKind === "authorized" ? authorized : null;
  const consequenceValue =
    presentation.consequenceKind === "zero"
      ? "No share"
      : presentation.consequenceKind === "unknown"
        ? "Unknown"
        : consequenceState
          ? format.words(consequenceState.word_count)
          : "Unavailable";
  setText("receipt-consequence-label", presentation.consequenceLabel);
  setText("receipt-consequence-value", consequenceValue);
  setText("receipt-effective", presentation.consequenceDetail);
  setText("receipt-prepared", receiptValue(receipt.prepared_state));
  setText("receipt-requested", requestedIntentValue(receipt.requested_intent));
  setText("authorized-label", receipt.outcome === "denied" ? "Human decision" : "You authorized");
  setText("receipt-authorized", receiptValue(authorized));
  setText("authorization-badge", receipt.outcome === "denied" ? "Denied" : authorized ? "Exact grant" : "No grant");
  byId("authorization-badge").className = receipt.outcome === "denied" || !authorized ? "match-badge divergence-badge" : "match-badge";
  const comparedState = presentation.comparedState ? receipt[presentation.comparedState] : null;
  setText("receipt-executed", comparedState ? receiptValue(comparedState) : presentation.comparedEmptyLabel ?? "Not executed");
  setText("executed-label", presentation.executedLabel);
  setText("execution-badge", presentation.badge);
  byId("execution-badge").className = presentation.tone === "success" ? "match-badge" : "match-badge divergence-badge";
  setText("receipt-id", receipt.receipt_id);
  setText(
    "receipt-digest",
    receipt.authorization?.payload_digest ? `${receipt.authorization.payload_digest.slice(0, 16)}…` : "No grant created",
  );

  const consequence = byId("receipt-consequence");
  consequence.dataset.outcome = receipt.outcome;
  consequence.dataset.tone = presentation.tone;
  byId("receipt-glyph").dataset.outcome = receipt.outcome;
  byId("receipt-glyph").dataset.tone = presentation.tone;
  byId("receipt-glyph-path").setAttribute(
    "d",
    presentation.tone === "success" ? "m6 12 4 4 8-9" : "M7 7l10 10M17 7 7 17",
  );
  const detail = byId("divergence-detail");
  detail.hidden = !presentation.divergence;
  if (presentation.divergence) {
    const difference = receipt.comparison.differences.find((item) => item.field === "word_count");
    const observed = receipt.outcome === "executed_divergent" ? executed : attempted;
    setText("divergence-title", receipt.outcome === "executed_divergent" ? "Executed state differed" : "State changed before execution");
    setText(
      "divergence-copy",
      receipt.outcome === "executed_divergent"
        ? `You authorized ${format.words(difference?.authorized ?? authorized.word_count)}. The recorded local fixture result is ${format.words(difference?.candidate ?? observed.word_count)}. The receipt preserves the mismatch for reconciliation.`
        : `You authorized ${format.words(difference?.authorized ?? authorized.word_count)}. The local candidate is ${format.words(difference?.candidate ?? observed.word_count)}. A new authorization is required.`,
    );
  }
  prepareReceiptDownload();
  window.setTimeout(() => byId("receipt-title").focus(), 50);
}

function deny() {
  const receipt = engine.denyAuthorization();
  showReceipt({ ...engine.snapshot(), receipt: engine.internalReceipt() });
  showToast(`Decision recorded: ${receipt.receipt_id}`);
}

function prepareReceiptDownload() {
  const receipt = engine.readReceipt(engine.handles());
  if (!receipt) return;
  const safeReceipt = redactReceipt(receipt);
  const link = byId("download-receipt");
  link.href = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(safeReceipt, null, 2))}`;
  link.download = `${receipt.receipt_id}.json`;
}

function finishDemo() {
  dialog.close();
  const taskState = engine.snapshot().task.state;
  showToast(
    taskState === "blocked"
      ? "Execution remained blocked."
      : taskState === "failed"
        ? "The receipt records an outcome that needs review."
        : "Receipt saved in this task.",
  );
}

function deferReview() {
  dialog.close();
  showToast("Nothing was authorized. The task is still waiting for your review.");
  runAgentButton.focus();
}

function openReceipt() {
  const state = engine.snapshot();
  if (!state.receipt) {
    showToast("A receipt is available after this local task ends.");
    return;
  }
  if (!dialog.open) dialog.showModal();
  showReceipt(state);
}

runAgentButton.addEventListener("click", openOrSimulate);
lengthSelect.addEventListener("change", updateHumanDraft);
audienceSelect.addEventListener("change", updateHumanDraft);
sharingConfirmation.addEventListener("change", () => {
  authorizeButton.disabled = !sharingConfirmation.checked;
});
authorizeButton.addEventListener("click", authorizeAndExecute);
byId("deny-authorization").addEventListener("click", deny);
byId("defer-review").addEventListener("click", deferReview);
byId("finish-demo").addEventListener("click", finishDemo);
viewReceiptButton.addEventListener("click", openReceipt);
dialog.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && engine.snapshot().task.state === "awaiting_human") {
    event.preventDefault();
    deferReview();
  }
});
dialog.addEventListener("cancel", (event) => {
  const taskState = engine.snapshot().task.state;
  if (!["awaiting_human", "completed", "blocked", "cancelled", "failed"].includes(taskState)) {
    event.preventDefault();
    return;
  }
  if (taskState === "awaiting_human") {
    window.setTimeout(() => {
      showToast("Nothing was authorized. The task is still waiting for your review.");
      runAgentButton.focus();
    }, 0);
  }
});
window.addEventListener("pagehide", () => bridge.dispose());

engine.subscribe(() => {
  syncDefinitions();
  render(engine.snapshot());
});

syncDefinitions();
renderBridgeStatus();
render(engine.snapshot());
