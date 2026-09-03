const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

export const PROTECTED_TOOL_PREFIX = "doa2ai__";
export const ACTION_STATUS_TOOL = "doa2ai_action_status";

export function protectedToolName(sourceName, toolDigest) {
  const cleanName = typeof sourceName === "string"
    ? sourceName.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 96)
    : "tool";
  const suffix = typeof toolDigest === "string" && /^[a-f0-9]{64}$/.test(toolDigest)
    ? toolDigest.slice(0, 10)
    : "unbound";
  const name = `${PROTECTED_TOOL_PREFIX}${cleanName || "tool"}__${suffix}`.slice(0, 128);
  if (!TOOL_NAME.test(name)) throw new Error("INVALID_PROTECTED_TOOL_NAME");
  return name;
}
// This function is intentionally self-contained. Chrome serializes it into the
// page's MAIN world through chrome.scripting.executeScript.
export async function installProtectedToolsInMainWorld(configuration) {
  const STATE_KEY = "__doa2aiProtectedToolStateV1";
  const MAIN_SOURCE = "doa2ai-protected-page";
  const EXTENSION_SOURCE = "doa2ai-protected-extension";
  const PREFIX = "doa2ai__";
  const STATUS_TOOL = "doa2ai_action_status";
  const responseTimeoutMs = 10 * 60 * 1000;
  const clean = (value, max) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
  const decodeSchema = (value) => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return null; }
  };
  const requestId = () => {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  };
  const documentKey = `${location.href}|${performance.timeOrigin}`;
  if (!configuration || configuration.documentKey !== documentKey) {
    return { installed: false, code: "DOCUMENT_IDENTITY_CHANGED", protectedTools: [] };
  }
  const context = document.modelContext;
  if (!context?.registerTool || !context?.getTools) {
    return { installed: false, code: "WEBMCP_REGISTRATION_UNAVAILABLE", protectedTools: [] };
  }

  const previous = globalThis[STATE_KEY];
  for (const controller of previous?.controllers ?? []) controller.abort();
  const state = previous ?? { controllers: [], sourceSignature: "", timer: null, listenerInstalled: false };
  state.controllers = [];
  globalThis[STATE_KEY] = state;

  const callBridge = (type, payload, signal) => new Promise((resolve, reject) => {
    const id = requestId();
    let settled = false;
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      signal?.removeEventListener?.("abort", onAbort);
      clearTimeout(timer);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onMessage = (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const message = event.data;
      if (!message || message.source !== EXTENSION_SOURCE || message.type !== "response" || message.requestId !== id) return;
      if (message.response?.ok) finish(resolve, message.response.result);
      else finish(reject, new Error(clean(message.response?.error, 160) || "DOA2AI_REQUEST_FAILED"));
    };
    const onAbort = () => {
      window.postMessage({ source: MAIN_SOURCE, type: "cancel", requestId: id }, location.origin);
      finish(reject, new DOMException("The protected action was cancelled.", "AbortError"));
    };
    const timer = setTimeout(() => finish(reject, new Error("DOA2AI_RESPONSE_TIMEOUT")), responseTimeoutMs);
    window.addEventListener("message", onMessage);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    window.postMessage({ source: MAIN_SOURCE, type, requestId: id, payload }, location.origin);
  });

  const definitions = Array.isArray(configuration.tools) ? configuration.tools : [];
  for (const definition of definitions) {
    const sourceName = clean(definition?.name, 128);
    const name = clean(definition?.protectedName, 128);
    const inputSchema = decodeSchema(definition?.inputSchema);
    if (!sourceName || !name.startsWith(PREFIX) || !inputSchema || typeof inputSchema !== "object") continue;
    const controller = new AbortController();
    const registered = {
      name,
      title: `Protected · ${clean(definition?.title, 100) || sourceName}`,
      description: `[Protected by doA2Ai; source tool: ${sourceName}] ${clean(definition?.description, 3_800)}`.trim(),
      inputSchema,
      annotations: {
        readOnlyHint: definition?.annotations?.readOnlyHint === true,
        untrustedContentHint: definition?.annotations?.untrustedContentHint === true,
        destructiveHint: definition?.annotations?.destructiveHint === true,
        idempotentHint: definition?.annotations?.idempotentHint === true,
        openWorldHint: definition?.annotations?.openWorldHint === true,
      },
      execute: async (args, options = {}) => callBridge("invoke", {
        protectedName: name,
        sourceName,
        toolDigest: clean(definition?.toolDigest, 64),
        documentKey,
        arguments: args ?? {},
      }, options.signal),
    };
    await context.registerTool(registered, { signal: controller.signal });
    state.controllers.push(controller);
  }

  const statusController = new AbortController();
  await context.registerTool({
    name: STATUS_TOOL,
    title: "Check protected action",
    description: "Read the current status or terminal result for one pending doA2Ai action. This never repeats the requested side effect.",
    inputSchema: {
      type: "object",
      properties: { action_id: { type: "string", minLength: 8, maxLength: 160 } },
      required: ["action_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    execute: async ({ action_id: actionId }, options = {}) => callBridge("status", {
      actionId: clean(actionId, 160),
      documentKey,
    }, options.signal),
  }, { signal: statusController.signal });
  state.controllers.push(statusController);

  const sourceSnapshot = async () => {
    const tools = await context.getTools();
    return JSON.stringify(tools
      .filter((tool) => typeof tool?.name === "string" && !tool.name.startsWith(PREFIX) && tool.name !== STATUS_TOOL)
      .map((tool) => ({
        name: clean(tool.name, 128),
        description: clean(tool.description, 4_096),
        inputSchema: decodeSchema(tool.inputSchema),
        outputSchema: decodeSchema(tool.outputSchema),
        annotations: tool.annotations ?? {},
        origin: tool.origin || location.origin,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)));
  };
  state.sourceSignature = await sourceSnapshot();
  if (!state.listenerInstalled && typeof context.addEventListener === "function") {
    state.listenerInstalled = true;
    context.addEventListener("toolchange", () => {
      clearTimeout(state.timer);
      state.timer = setTimeout(async () => {
        try {
          const next = await sourceSnapshot();
          if (next === state.sourceSignature) return;
          state.sourceSignature = next;
          window.postMessage({ source: MAIN_SOURCE, type: "catalog_changed", requestId: requestId() }, location.origin);
        } catch {
          window.postMessage({ source: MAIN_SOURCE, type: "catalog_changed", requestId: requestId() }, location.origin);
        }
      }, 100);
    });
  }

  return {
    installed: true,
    protectedTools: definitions.map((entry) => entry.protectedName).filter((name) => typeof name === "string"),
    statusTool: STATUS_TOOL,
  };
}
