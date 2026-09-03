import { verifyLocalReceipt } from "./action-model.js";

const nodes = {
  title: document.querySelector("#title"),
  status: document.querySelector("#receipt-status"),
  summary: document.querySelector("#summary"),
  actionId: document.querySelector("#action-id"),
  requested: document.querySelector("#requested"),
  authority: document.querySelector("#authority"),
  execution: document.querySelector("#execution"),
  verification: document.querySelector("#verification"),
  digest: document.querySelector("#receipt-digest"),
  signature: document.querySelector("#signature-state"),
  binding: document.querySelector("#binding-state"),
  json: document.querySelector("#receipt-json"),
  copy: document.querySelector("#copy-button"),
  pin: document.querySelector("#pin-button"),
  message: document.querySelector("#message"),
};
const receiptId = new URL(location.href).searchParams.get("receipt") || "";
let currentReceipt = null;

function send(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "Request failed");
    return response;
  });
}

function human(value) {
  return typeof value === "string" ? value.replaceAll("_", " ") : "Unknown";
}

async function load() {
  if (!receiptId) throw new Error("Receipt ID is missing.");
  const response = await send({ type: "receipt.get", receiptId });
  const receipt = response.receipt;
  currentReceipt = receipt;
  const outcome = receipt.outcome || "unknown";
  nodes.title.textContent = receipt.tool?.title || receipt.tool?.name || "Action receipt";
  nodes.status.textContent = human(outcome);
  nodes.status.dataset.tone = outcome === "completed" ? "success" : ["blocked", "denied"].includes(outcome) ? "danger" : "neutral";
  nodes.summary.textContent = receipt.summary || "This receipt separates the request, authority decision, execution report, and available verification evidence.";
  nodes.actionId.textContent = receipt.actionId || "Unavailable";
  nodes.requested.textContent = receipt.requestedAt || "Unavailable";
  nodes.authority.textContent = human(receipt.authority?.decision || receipt.decision || "unknown");
  nodes.execution.textContent = human(receipt.execution?.status || outcome);
  nodes.verification.textContent = human(receipt.verification?.status || "unknown");
  nodes.digest.textContent = receipt.receiptDigest || "Unavailable";
  const signatureVerified = receipt.deviceSignature && receipt.signer
    ? await verifyLocalReceipt(receipt)
    : null;
  nodes.signature.textContent = signatureVerified === true ? "Verified" : signatureVerified === false ? "Invalid" : "Unavailable";
  nodes.binding.textContent = receipt.serviceBinding?.status ? human(receipt.serviceBinding.status) : "Not available";
  nodes.json.textContent = JSON.stringify(receipt, null, 2);
  nodes.copy.hidden = false;
  nodes.pin.hidden = false;
  nodes.pin.textContent = receipt.pinned ? "Unpin receipt" : "Pin receipt";
}

nodes.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(nodes.json.textContent);
    nodes.message.textContent = "Receipt JSON copied.";
    try {
      const response = await send({ type: "receipt.mark_exported", receiptId });
      currentReceipt = response.receipt;
    } catch {
      nodes.message.textContent = "Receipt JSON copied, but its retained-export marker could not be updated.";
    }
  } catch {
    nodes.message.textContent = "Copy was unavailable. Select the JSON directly.";
  }
});

nodes.pin.addEventListener("click", async () => {
  try {
    const response = await send({ type: "receipt.pin", receiptId, pinned: !currentReceipt?.pinned });
    currentReceipt = response.receipt;
    nodes.pin.textContent = currentReceipt.pinned ? "Unpin receipt" : "Pin receipt";
    nodes.message.textContent = currentReceipt.pinned ? "Receipt pinned on this device." : "Receipt unpinned.";
  } catch (error) {
    nodes.message.textContent = error.message;
  }
});

load().catch((error) => {
  nodes.title.textContent = "Receipt unavailable";
  nodes.status.textContent = "Unavailable";
  nodes.status.dataset.tone = "danger";
  nodes.summary.textContent = error.message;
});
