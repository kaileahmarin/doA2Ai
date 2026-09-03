(() => {
  if (globalThis.__doa2aiPageBridgeV1) return;
  globalThis.__doa2aiPageBridgeV1 = true;

  const MAIN_SOURCE = "doa2ai-protected-page";
  const EXTENSION_SOURCE = "doa2ai-protected-extension";
  const CONTROL_SOURCE = "doa2ai-control-page";
  const CONTROL_EXTENSION_SOURCE = "doa2ai-control-extension";
  const REQUEST_TYPES = new Set(["invoke", "status", "cancel", "catalog_changed"]);
  const cleanId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{8,160}$/.test(value) ? value : "";

  const respond = (requestId, response) => {
    window.postMessage({ source: EXTENSION_SOURCE, type: "response", requestId, response }, location.origin);
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;

    if (message.source === MAIN_SOURCE && REQUEST_TYPES.has(message.type)) {
      const requestId = cleanId(message.requestId);
      if (!requestId) return;
      void chrome.runtime.sendMessage({
        type: `protected.${message.type}`,
        requestId,
        payload: message.payload ?? null,
        pageUrl: location.href,
      }).then(
        (response) => respond(requestId, response?.ok ? response : { ok: false, error: response?.error || "EXTENSION_REQUEST_FAILED" }),
        (error) => respond(requestId, { ok: false, error: String(error?.message || "EXTENSION_REQUEST_FAILED").slice(0, 160) }),
      );
      return;
    }

    if (message.source === CONTROL_SOURCE && message.type === "request") {
      const id = cleanId(message.id);
      if (!id) return;
      void chrome.runtime.sendMessage({ type: "control.bridge", request: message.request, pageUrl: location.href }).then(
        (response) => window.postMessage({ source: CONTROL_EXTENSION_SOURCE, type: "response", id, response }, location.origin),
        (error) => window.postMessage({ source: CONTROL_EXTENSION_SOURCE, type: "response", id, response: { ok: false, error: String(error?.message || "EXTENSION_BRIDGE_FAILED").slice(0, 160) } }, location.origin),
      );
    }
  });

  void chrome.runtime.sendMessage({ type: "protected.page_ready", pageUrl: location.href }).catch(() => {});
  window.postMessage({ source: CONTROL_EXTENSION_SOURCE, type: "ready" }, location.origin);
})();
