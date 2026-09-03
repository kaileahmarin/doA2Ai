const nodes = {
  connectionDetail: document.querySelector("#connection-detail"),
  connectionStatus: document.querySelector("#connection-status"),
  serviceOrigin: document.querySelector("#service-origin"),
  deviceState: document.querySelector("#device-state"),
  policyStatus: document.querySelector("#policy-status"),
  connectButton: document.querySelector("#connect-button"),
  controlButton: document.querySelector("#control-button"),
  rotateButton: document.querySelector("#rotate-button"),
  pauseButton: document.querySelector("#pause-button"),
  rulesButton: document.querySelector("#rules-button"),
  serviceForm: document.querySelector("#service-form"),
  serviceUrl: document.querySelector("#service-url"),
  restoreButton: document.querySelector("#restore-button"),
  message: document.querySelector("#message"),
};

function send(message) {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "Request failed");
    return response;
  });
}

function status(node, label, tone = "neutral") {
  node.textContent = label;
  node.dataset.tone = tone;
}

function showMessage(text = "", tone = "neutral") {
  nodes.message.textContent = text;
  nodes.message.dataset.tone = tone;
}

function render(state) {
  const connection = state?.connection ?? {};
  const device = state?.device ?? {};
  const connected = connection.status === "connected";
  const degraded = connection.status === "degraded";
  status(nodes.connectionStatus, connected ? "Connected" : degraded ? "Limited" : "Not connected", connected ? "success" : degraded ? "warning" : "neutral");
  nodes.connectionDetail.textContent = connected
    ? "The device is paired and coordination is available."
    : degraded
      ? connection.detail || "The service is unavailable. State-changing actions remain stopped."
      : connection.detail || "Connect this browser to begin protected actions.";
  nodes.serviceOrigin.textContent = connection.serviceOrigin || "Built in";
  nodes.serviceUrl.value = connection.serviceUrl || "";
  nodes.deviceState.textContent = device.registered ? `Paired · ${device.deviceId || "local device"}` : "Not paired";
  nodes.connectButton.textContent = connected ? "Reconnect" : "Connect";

  const confirmed = state?.policy?.starterConfirmed === true;
  status(nodes.policyStatus, confirmed ? "Confirmed" : "Needs confirmation", confirmed ? "success" : "warning");
  nodes.pauseButton.textContent = state?.paused ? "Resume protected actions" : "Pause protected actions";
  nodes.pauseButton.disabled = !state?.enabled;
}

async function refresh() {
  const response = await send({ type: "product.state" });
  render(response.state);
}

async function action(callback, busy) {
  showMessage(busy);
  try {
    await callback();
    showMessage("");
    await refresh();
  } catch (error) {
    showMessage(error.message, "danger");
  }
}

nodes.connectButton.addEventListener("click", () => action(
  () => send({ type: "product.connect" }),
  "Connecting this device…",
));
nodes.controlButton.addEventListener("click", () => send({ type: "page.open_control", view: "overview" }));
nodes.rotateButton.addEventListener("click", () => {
  if (!window.confirm("Replace this browser's device key? Use this only when the current registration is revoked or cannot reconnect. Existing local receipts remain.")) return;
  void action(
    () => send({ type: "product.rotate_device", confirmDeviceRotation: true }),
    "Replacing and pairing the device key…",
  );
});
nodes.pauseButton.addEventListener("click", () => action(
  () => send({ type: "product.pause" }),
  "Updating protection state…",
));
nodes.rulesButton.addEventListener("click", () => send({ type: "page.open_rules" }));
nodes.serviceForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void action(
    () => send({ type: "settings.service", serviceUrl: nodes.serviceUrl.value }),
    "Saving the service and reconnecting…",
  );
});
nodes.restoreButton.addEventListener("click", () => action(
  () => send({ type: "settings.service", serviceUrl: null }),
  "Restoring the built-in service…",
));

refresh().catch((error) => showMessage(error.message, "danger"));
