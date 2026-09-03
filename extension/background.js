import {
  brokerResult,
  canonicalJson,
  catalogRevision,
  cleanText,
  normalizeCatalog,
  normalizeServiceUrl,
  safePageResult,
  serviceOrigin,
  sha256Hex,
} from "./protocol.js";
import {
  attestImpact,
  compileRuleDraft,
  confirmRuleCandidate,
  createStarterPolicy,
  evaluateAuthority,
  normalizePolicy,
  starterRuleCatalog,
} from "./policy.js";
import { TaskRegistry } from "./task-manager.js";
import {
  createBrowserAuthorityStore,
  LOCAL_STATE_VERSION,
} from "./local-store.js";
import {
  createIndexedDbDeviceKeyStore,
  DeviceIdentity,
} from "./device-identity.js";
import {
  AuthorityServiceClient,
} from "./v2-client.js";
import {
  bindToolDefinition,
  classifyToolImpact,
  containsPrivateFields,
  containsSensitiveFields,
  computeActionDigest,
  computeArgumentsDigest,
  exactImpactRule,
  finalizeLocalReceipt,
  redactSensitiveFields,
  verifyDeviceStatement,
  verifyLocalReceipt,
} from "./action-model.js";
import {
  ACTION_STATUS_TOOL,
  installProtectedToolsInMainWorld,
  protectedToolName,
  PROTECTED_TOOL_PREFIX,
} from "./protected-tools.js";

const ACTIONS_KEY = "doa2ai.pending-and-recent-actions.v1";
const PAGE_RUNTIME_KEY = "doa2ai.page-runtime.v1";
const SERVICE_SETTINGS_KEY = "doa2ai.service-settings.v1";
const CONTENT_SCRIPT_ID = "doa2ai-page-bridge-v1";
const MAINTENANCE_ALARM = "doa2ai-local-maintenance-v1";
const MAX_ACTIONS = 120;
const MAX_ARGUMENT_BYTES = 262_144;
const PENDING_CANCEL_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_CANCELS = 256;
const TERMINAL_STATUSES = new Set(["completed", "denied", "blocked", "failed", "unknown"]);
const RETRYABLE_PRIVATE_NO_DISPATCH_CODES = new Set([
  "PRIVATE_INPUT_REENTRY_REQUIRED",
  "PRE_DISPATCH_PERSISTENCE_FAILED",
]);
const BUILT_IN_SERVICE_URL = "https://doa2ai-broker.cooing-cupcake.workers.dev";

let runtimePromise = null;
const executionLocks = new Map();
const dispatchQueues = new Map();
const requestToAction = new Map();
const pendingCancels = new Map();
// Private transaction/contact inputs live only for the current service-worker
// lifetime. Durable actions and receipts retain redacted projections plus exact
// digests, never the submitted values.
const transientActionArguments = new Map();

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function opaqueId(prefix, byteLength = 24) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return `${prefix}_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function exactHttpsUrl(value) {
  const normalized = normalizeServiceUrl(value);
  return normalized;
}

function boundedError(error) {
  return cleanText(error?.code || error?.message, 160) || "DOA2AI_REQUEST_FAILED";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInspectableUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function connectionIdForWindow(windowId) {
  return `browser:window-${Number.isInteger(windowId) ? windowId : 0}`;
}

function pendingCancelKey(requestId, tabId) {
  return `${tabId}\n${requestId}`;
}

function rememberPendingCancel(requestId, tabId) {
  const now = Date.now();
  for (const [key, recordedAt] of pendingCancels) {
    if (recordedAt + PENDING_CANCEL_TTL_MS <= now) pendingCancels.delete(key);
  }
  pendingCancels.set(pendingCancelKey(requestId, tabId), now);
  while (pendingCancels.size > MAX_PENDING_CANCELS) pendingCancels.delete(pendingCancels.keys().next().value);
}

function consumePendingCancel(requestId, tabId) {
  const key = pendingCancelKey(requestId, tabId);
  const recordedAt = pendingCancels.get(key);
  pendingCancels.delete(key);
  return Number.isFinite(recordedAt) && recordedAt + PENDING_CANCEL_TTL_MS > Date.now();
}

function actionStatusResult(action, { deduplicated = false } = {}) {
  if (!action) return { status: "not_found" };
  if (action.status === "pending_review") {
    return {
      status: "authority_required",
      action_id: action.actionId,
      ...(deduplicated ? { deduplicated: true } : {}),
      message: "This action is waiting for a focused human decision in doA2Ai.",
    };
  }
  if (["evaluating", "authorized", "dispatching"].includes(action.status)) {
    return { status: "in_progress", action_id: action.actionId, ...(deduplicated ? { deduplicated: true } : {}) };
  }
  return {
    status: action.status,
    action_id: action.actionId,
    receipt_id: action.receiptId || undefined,
    ...(deduplicated ? { deduplicated: true } : {}),
    ...(action.execution?.result === undefined ? {} : { result: action.execution.result }),
    ...(action.execution?.error === undefined ? {} : { error: action.execution.error }),
  };
}

function retryablePrivateNoDispatch(record) {
  return record?.execution?.dispatched === false
    && RETRYABLE_PRIVATE_NO_DISPATCH_CODES.has(record?.execution?.error?.code);
}

function publicReviewAction(runtime, action) {
  if (!action) return null;
  const ruleCandidate = reviewRuleCandidate(runtime, action);
  return {
    actionId: action.actionId,
    actionDigest: action.actionDigest,
    reusableAllowEligible: reusableAllowEligible(action),
    ruleCandidate,
    humanPresenceRequired: action.impact?.human_presence === true,
    privateInputsRedacted: action.privateArgumentsRequired === true,
    privateInputsAvailable: !action.privateArgumentsRequired || transientActionArguments.has(action.actionId),
    status: action.status,
    requestedAt: action.requestedAt,
    updatedAt: action.updatedAt,
    receiptId: action.receiptId || null,
    task: {
      taskId: action.taskId,
      label: action.taskLabel || null,
    },
    page: {
      title: action.page.title,
      origin: action.page.origin,
      url: action.page.url,
    },
    tool: {
      name: action.tool.name,
      title: action.tool.title || action.tool.name,
      description: action.tool.description,
      digest: action.tool.toolDigest,
    },
    arguments: redactSensitiveFields(cloneJson(action.arguments), {
      allValues: action.impact?.credential === true || action.impact?.security === true,
    }),
    impact: cloneJson(action.impact),
    authority: cloneJson(action.authority),
  };
}

async function loadActions() {
  const stored = await chrome.storage.local.get(ACTIONS_KEY);
  const rows = Array.isArray(stored[ACTIONS_KEY]) ? stored[ACTIONS_KEY] : [];
  return new Map(rows
    .filter((row) => isRecord(row) && typeof row.actionId === "string")
    .slice(-MAX_ACTIONS)
    .map((row) => [row.actionId, row]));
}

async function loadPageRuntime() {
  const stored = await chrome.storage.session.get(PAGE_RUNTIME_KEY);
  const rows = Array.isArray(stored[PAGE_RUNTIME_KEY]?.pages) ? stored[PAGE_RUNTIME_KEY].pages : [];
  return new Map(rows
    .filter((row) => Number.isInteger(row?.tabId) && isInspectableUrl(row?.pageUrl))
    .map((row) => [row.tabId, row]));
}

async function loadServiceUrl() {
  const stored = await chrome.storage.local.get(SERVICE_SETTINGS_KEY);
  try {
    return stored[SERVICE_SETTINGS_KEY]?.serviceUrl
      ? exactHttpsUrl(stored[SERVICE_SETTINGS_KEY].serviceUrl)
      : BUILT_IN_SERVICE_URL;
  } catch {
    return BUILT_IN_SERVICE_URL;
  }
}

function taskRegistryFromSnapshot(snapshot) {
  try {
    return snapshot ? new TaskRegistry({ snapshot }) : new TaskRegistry();
  } catch {
    return new TaskRegistry();
  }
}

function policyFromState(raw) {
  try {
    return raw ? normalizePolicy(raw) : createStarterPolicy({ confirmed: false });
  } catch {
    return createStarterPolicy({ confirmed: false, revision: "recovery-required" });
  }
}

async function createRuntime() {
  const store = createBrowserAuthorityStore();
  const loaded = await store.loadState();
  const local = loaded.state;
  const identity = new DeviceIdentity({ keyStore: createIndexedDbDeviceKeyStore(indexedDB) });
  const tasks = taskRegistryFromSnapshot(local.tasks);
  tasks.setGlobalPaused(local.settings.globalPaused);
  const runtime = {
    store,
    identity,
    policy: policyFromState(local.policy),
    tasks,
    actions: await loadActions(),
    pages: await loadPageRuntime(),
    serviceUrl: await loadServiceUrl(),
    enabled: loaded.ok && local.settings.enabled,
    paused: !loaded.ok || local.settings.globalPaused,
    blockedCount: local.index.blockedCount,
    receiptRetentionDays: local.settings.receiptRetentionDays,
    stateRevision: local.stateRevision,
    authorityMutationTail: Promise.resolve(),
    connection: {
      status: "not_connected",
      detail: loaded.ok ? "Connect this device to the built-in service." : "Local authority state could not be read safely.",
      checkedAt: null,
    },
    controlDisclosure: null,
    recovered: false,
  };
  return runtime;
}

async function authorityRuntime() {
  runtimePromise ??= createRuntime().catch((error) => {
    runtimePromise = null;
    throw error;
  });
  const runtime = await runtimePromise;
  if (!runtime.recovered) {
    runtime.recovered = true;
    for (const action of runtime.actions.values()) {
      if (["authorized", "dispatching", "evaluating"].includes(action.status)) {
        await terminalize(runtime, action, {
          outcome: "unknown",
          execution: {
            status: "unknown",
            dispatched: action.status === "dispatching",
            error: { code: "WORKER_SUSPENDED", message: "The browser could not prove the interrupted action outcome." },
          },
          verification: { status: "unknown", evidence: "worker_recovery" },
        });
      } else if (action.status === "pending_review" && action.privateArgumentsRequired) {
        await terminalize(runtime, action, {
          outcome: "blocked",
          execution: {
            status: "not_dispatched",
            dispatched: false,
            error: { code: "PRIVATE_INPUT_REENTRY_REQUIRED", message: "Private inputs were intentionally not restored after browser-worker suspension." },
          },
          verification: { status: "blocked", evidence: "transient_input_recovery" },
        });
      }
    }
  }
  return runtime;
}

async function saveActions(runtime) {
  const ordered = [...runtime.actions.values()].sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
  const pending = ordered.filter((action) => !TERMINAL_STATUSES.has(action.status));
  const terminal = ordered.filter((action) => TERMINAL_STATUSES.has(action.status)).slice(-(MAX_ACTIONS - pending.length));
  const retained = [...pending, ...terminal].slice(-MAX_ACTIONS);
  runtime.actions = new Map(retained.map((action) => [action.actionId, action]));
  await chrome.storage.local.set({ [ACTIONS_KEY]: retained });
}

async function savePageRuntime(runtime) {
  await chrome.storage.session.set({
    [PAGE_RUNTIME_KEY]: {
      pages: [...runtime.pages.values()].map((page) => cloneJson(page)),
    },
  });
}

async function saveAuthorityStateNow(runtime) {
  const saved = await runtime.store.saveState({
    version: LOCAL_STATE_VERSION,
    stateRevision: runtime.stateRevision,
    settings: {
      enabled: runtime.enabled,
      globalPaused: runtime.paused,
      receiptRetentionDays: runtime.receiptRetentionDays,
    },
    policy: runtime.policy,
    tasks: runtime.tasks.snapshot(),
    index: {
      pendingActionIds: [...runtime.actions.values()]
        .filter((action) => action.status === "pending_review")
        .map((action) => action.actionId)
        .sort(),
      blockedCount: runtime.blockedCount,
    },
  }, { expectedRevision: runtime.stateRevision });
  runtime.stateRevision = saved.stateRevision;
  return saved;
}

async function saveAuthorityState(runtime) {
  const operation = runtime.authorityMutationTail.then(() => saveAuthorityStateNow(runtime));
  runtime.authorityMutationTail = operation.catch(() => {});
  return operation;
}

async function consumeApprovalImmediatelyBeforeDispatch(runtime, action) {
  if (!action.approvalId) return;
  const operation = runtime.authorityMutationTail.then(async () => {
    const saved = await runtime.store.consumeTransactionApproval({
      approvalId: action.approvalId,
      actionDigest: action.actionDigest,
      expectedRevision: runtime.stateRevision,
    });
    runtime.stateRevision = saved.stateRevision;
    runtime.policy = normalizePolicy(saved.policy);
    action.approvalConsumedAt = saved.policy.transactionApprovals
      .find((approval) => approval.id === action.approvalId)?.consumedAt || null;
    if (!action.approvalConsumedAt) throw new Error("APPROVAL_CONSUMPTION_NOT_PROVEN");
    return saved;
  });
  runtime.authorityMutationTail = operation.catch(() => {});
  return operation;
}

async function persistRuntime(runtime) {
  await Promise.all([saveActions(runtime), saveAuthorityState(runtime), savePageRuntime(runtime)]);
}

async function abandonPrivateActionAfterPersistenceFailure(runtime, action, { restorePolicy = null } = {}) {
  // Drop private values synchronously before any best-effort cleanup awaits.
  transientActionArguments.delete(action.actionId);
  requestToAction.delete(action.requestId);
  runtime.actions.delete(action.actionId);
  if (restorePolicy) runtime.policy = restorePolicy;
  try {
    // A concurrent persistence branch may already have written a safe redacted
    // action or authority snapshot. Queue a compensating snapshot after it.
    await Promise.all([saveActions(runtime), saveAuthorityState(runtime)]);
  } catch {
    // The raw inputs and live mapping are already gone. Recovery remains
    // fail-closed even when the browser storage failure continues.
  }
}

async function registerPageBridge() {
  const granted = await chrome.permissions.contains({ origins: ["https://*/*"] });
  if (!granted) throw new Error("HTTPS_PERMISSION_REQUIRED");
  const existing = typeof chrome.scripting.getRegisteredContentScripts === "function"
    ? await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] })
    : [];
  if (existing.length > 0) return;
  await chrome.scripting.registerContentScripts([{
    id: CONTENT_SCRIPT_ID,
    matches: ["https://*/*"],
    js: ["page-bridge.js"],
    runAt: "document_idle",
    allFrames: false,
    persistAcrossSessions: true,
  }]);
}

async function injectPageBridge(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    files: ["page-bridge.js"],
  });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? {};
}

async function discoverPage(tabId) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async () => {
      if (!document.modelContext?.getTools) throw new Error("WEBMCP_UNAVAILABLE");
      const pageUrl = location.href;
      const documentTimeOrigin = performance.timeOrigin;
      const tools = await document.modelContext.getTools();
      if (location.href !== pageUrl || performance.timeOrigin !== documentTimeOrigin) throw new Error("DOCUMENT_CHANGED");
      return {
        pageUrl,
        title: document.title,
        documentKey: `${pageUrl}|${documentTimeOrigin}`,
        tools: tools
          .filter((tool) => typeof tool?.name === "string" && !tool.name.startsWith("doa2ai__") && tool.name !== "doa2ai_action_status")
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            annotations: tool.annotations,
            origin: tool.origin,
          })),
      };
    },
  });
  const result = injection?.result;
  if (!result?.pageUrl || !result?.documentKey) throw new Error("INVALID_PAGE_IDENTITY");
  const pageUrl = new URL(result.pageUrl);
  if (pageUrl.protocol !== "https:") throw new Error("HTTPS_PAGE_REQUIRED");
  const catalog = normalizeCatalog(result.tools ?? [], pageUrl.origin);
  return {
    pageUrl: pageUrl.href,
    origin: pageUrl.origin,
    title: cleanText(result.title, 240) || pageUrl.hostname,
    documentKey: result.documentKey,
    catalog,
    revision: await catalogRevision(catalog),
  };
}

async function boundPageTools(discovery) {
  return Promise.all(discovery.catalog.map(async (tool) => {
    const bound = await bindToolDefinition(tool, discovery);
    return {
      ...bound,
      title: tool.name,
      protectedName: protectedToolName(tool.name, bound.toolDigest),
    };
  }));
}

async function installPageProtection(runtime, tabId, suppliedDiscovery = null) {
  const discovery = suppliedDiscovery || await discoverPage(tabId);
  if (serviceOrigin(runtime.serviceUrl) === discovery.origin && new URL(discovery.pageUrl).pathname === "/") {
    throw new Error("CONTROL_PAGE_NOT_A_TARGET");
  }
  const tools = await boundPageTools(discovery);
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [{ documentKey: discovery.documentKey, tools }],
    func: installProtectedToolsInMainWorld,
  });
  if (!injection?.result?.installed) throw new Error(injection?.result?.code || "PROTECTED_TOOL_INSTALL_FAILED");
  const page = {
    tabId,
    title: discovery.title,
    pageUrl: discovery.pageUrl,
    origin: discovery.origin,
    documentKey: discovery.documentKey,
    catalogRevision: discovery.revision,
    tools,
    protectedToolCount: tools.length,
    installedAt: new Date().toISOString(),
  };
  runtime.pages.set(tabId, page);
  await savePageRuntime(runtime);
  return page;
}

function parseTabId(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  if (typeof value !== "string" || !/^\d{1,10}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function setupPageCandidate(page) {
  return page
    && Number.isInteger(page.tabId)
    && !page.error
    && isInspectableUrl(page.pageUrl)
    && Array.isArray(page.tools);
}

/**
 * Re-discovers the target before a rule is shown or created. A rule is never
 * authored against a stale page record or an arbitrary origin typed by a UI.
 */
async function ruleSetupPage(runtime, requestedTabId = null) {
  if (!runtime.enabled) throw new Error("DOA2AI_NOT_ENABLED");
  const explicitTabId = parseTabId(requestedTabId);
  let tabId = explicitTabId;
  if (tabId === null) {
    const tab = await activeTab();
    if (Number.isInteger(tab.id) && isInspectableUrl(tab.url)) tabId = tab.id;
  }
  if (tabId === null) {
    const candidates = [...runtime.pages.values()]
      .filter(setupPageCandidate)
      .sort((left, right) => String(right.installedAt || "").localeCompare(String(left.installedAt || "")));
    tabId = candidates[0]?.tabId ?? null;
  }
  if (!Number.isInteger(tabId)) throw new Error("RULE_TARGET_UNAVAILABLE");
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error("RULE_TARGET_UNAVAILABLE");
  }
  if (!isInspectableUrl(tab?.url)) throw new Error("RULE_TARGET_UNAVAILABLE");
  try {
    const discovery = await discoverPage(tabId);
    if (serviceOrigin(runtime.serviceUrl) === discovery.origin && new URL(discovery.pageUrl).pathname === "/") {
      throw new Error("CONTROL_PAGE_NOT_A_TARGET");
    }
    const existing = runtime.pages.get(tabId);
    const sameCurrentPage = setupPageCandidate(existing)
      && existing.pageUrl === discovery.pageUrl
      && existing.documentKey === discovery.documentKey
      && existing.catalogRevision === discovery.revision;
    const page = sameCurrentPage ? existing : await installPageProtection(runtime, tabId, discovery);
    if (!setupPageCandidate(page)) throw new Error("RULE_TARGET_UNAVAILABLE");
    return page;
  } catch (error) {
    throw new Error(boundedError(error));
  }
}

function publicRuleSetupPage(page) {
  const tools = page.tools.map((tool) => {
    const impact = attestImpact(classifyToolImpact(tool));
    const eligibility = reusableImpactEligibilityReason(impact);
    return {
      name: tool.name,
      title: tool.title || tool.name,
      description: tool.description || "",
      inputSchema: cloneJson(tool.inputSchema),
      annotations: cloneJson(tool.annotations),
      toolDigest: tool.toolDigest,
      impact: cloneJson(impact),
      eligible: eligibility === null,
      eligibilityReason: eligibility,
    };
  });
  return {
    tabId: page.tabId,
    title: page.title,
    pageUrl: page.pageUrl,
    origin: page.origin,
    documentKey: page.documentKey,
    catalogRevision: page.catalogRevision,
    tools,
  };
}

async function ensureCurrentPageProtection(runtime) {
  const tab = await activeTab();
  if (!runtime.enabled || !Number.isInteger(tab.id) || !isInspectableUrl(tab.url)) return null;
  const pageUrl = new URL(tab.url);
  if (pageUrl.origin === serviceOrigin(runtime.serviceUrl) && pageUrl.pathname === "/") return null;
  const existing = runtime.pages.get(tab.id);
  if (existing?.pageUrl === tab.url && existing.error && Date.parse(existing.retryAt || 0) > Date.now()) return existing;
  try {
    await injectPageBridge(tab.id);
    return await installPageProtection(runtime, tab.id);
  } catch (error) {
    const unavailable = {
      error: boundedError(error),
      retryAt: new Date(Date.now() + 10_000).toISOString(),
      tabId: tab.id,
      title: cleanText(tab.title, 240),
      pageUrl: tab.url,
      origin: pageUrl.origin,
      protectedToolCount: 0,
    };
    runtime.pages.set(tab.id, unavailable);
    await savePageRuntime(runtime);
    return unavailable;
  }
}

function serviceClient(runtime, deviceId = "", signRequest = null) {
  return new AuthorityServiceClient({
    baseUrl: runtime.serviceUrl,
    deviceId,
    signRequest,
  });
}

async function connectDevice(runtime) {
  const checkedAt = new Date().toISOString();
  try {
    const unsigned = serviceClient(runtime);
    const readiness = await unsigned.readiness();
    if (readiness.contract_revision !== "doa2ai.v2" || readiness.authority_owner !== "installed_extension") {
      throw new Error("INCOMPATIBLE_SERVICE");
    }
    const origin = serviceOrigin(runtime.serviceUrl);
    const pairing = await runtime.identity.getPairingState();
    const currentDeviceId = await runtime.identity.getDeviceId();
    const signRequest = (request) => runtime.identity.signRequest(request);
    if (pairing?.serviceOrigin === origin && /^dev_[a-f0-9]{48}$/.test(currentDeviceId)) {
      try {
        const status = await serviceClient(runtime, currentDeviceId, signRequest).deviceStatus();
        runtime.connection = {
          status: "connected",
          detail: "The device signature is accepted by the service.",
          deviceId: currentDeviceId,
          registeredAt: status.registered_at,
          checkedAt,
        };
        return runtime.connection;
      } catch (error) {
        if (!["DEVICE_UNKNOWN", "DEVICE_REVOKED"].includes(error?.code)) throw error;
        await runtime.identity.clearPairingState();
      }
    }
    const publicJwk = await runtime.identity.publicJwk();
    const challenge = await unsigned.createDeviceChallenge(publicJwk);
    const signature = await runtime.identity.signChallenge(challenge.challenge);
    const registration = await unsigned.registerDevice(challenge.challenge_id, signature);
    await runtime.identity.completePairing({
      deviceId: registration.device_id,
      serviceOrigin: origin,
      pairedAt: registration.registered_at,
    });
    runtime.connection = {
      status: "connected",
      detail: "This browser is paired by proof of possession.",
      deviceId: registration.device_id,
      registeredAt: registration.registered_at,
      checkedAt,
    };
    return runtime.connection;
  } catch (error) {
    runtime.connection = {
      status: "degraded",
      detail: boundedError(error),
      checkedAt,
    };
    return runtime.connection;
  }
}

async function signedServiceClient(runtime) {
  const deviceId = await runtime.identity.getDeviceId();
  if (!/^dev_[a-f0-9]{48}$/.test(deviceId)) throw new Error("DEVICE_NOT_PAIRED");
  return serviceClient(runtime, deviceId, (request) => runtime.identity.signRequest(request));
}

async function rotateDevice(runtime) {
  if (runtime.connection.status === "connected") {
    try {
      const client = await signedServiceClient(runtime);
      await client.revokeDevice();
    } catch {
      // Rotation is also the recovery path when the old device is already
      // revoked or unreachable; inability to revoke it must not dead-end setup.
    }
  }
  await runtime.identity.rotate();
  runtime.connection = { status: "not_connected", detail: "A new local device key is ready to pair.", checkedAt: null };
  return connectDevice(runtime);
}

function policyRevision(prefix) {
  return `${prefix}-${Date.now()}-${opaqueId("r", 4).slice(2)}`;
}

function replacePolicy(runtime, changes) {
  runtime.policy = normalizePolicy({
    ...cloneJson(runtime.policy),
    ...changes,
    revision: policyRevision("policy"),
  });
}

function actionRule(action, { id, scope, decision, expiresAt = null, confirmed = true }) {
  const base = {
    id,
    scope,
    decision,
    confirmed,
    impact: exactImpactRule(action.impact),
    expiresAt,
    revokedAt: null,
  };
  if (scope === "task") {
    base.taskId = action.taskId;
    base.connectionId = action.connectionId;
  }
  if (scope === "site_tool" || decision === "allow") {
    base.origin = action.page.origin;
    base.toolName = action.tool.name;
    base.toolDigest = action.tool.toolDigest;
  }
  if (decision === "allow") base.argumentDigest = action.argumentDigest;
  return base;
}

function compileActionRuleCandidate(action, { scope, expiresAt = null }) {
  return compileRuleDraft(
    `Save only the exact ${action.tool.name} boundary on ${action.page.origin}.`,
    actionRule(action, {
      id: `rule_${action.actionId}_${scope}`,
      scope,
      decision: "allow",
      expiresAt,
      confirmed: false,
    }),
  );
}

function reviewRuleCandidate(runtime, action) {
  if (!reusableAllowEligible(action)) return null;
  const observedCount = [...runtime.actions.values()].filter((entry) => (
    entry.page?.origin === action.page.origin
    && entry.tool?.toolDigest === action.tool.toolDigest
    && entry.argumentDigest === action.argumentDigest
  )).length;
  const candidate = compileActionRuleCandidate(action, { scope: "universal" });
  return {
    version: candidate.version,
    candidateId: candidate.candidateId,
    status: candidate.status,
    confirmed: false,
    source: observedCount > 1 ? "repeated_exact_action" : "observed_exact_action",
    observedCount,
    origin: action.page.origin,
    toolName: action.tool.name,
    toolDefinitionDigest: action.tool.toolDigest,
    argumentDigest: action.argumentDigest,
    scopes: ["task", "universal"],
  };
}

function reusableImpactEligibilityReason(impact) {
  if (!impact || !Array.isArray(impact.issues) || impact.issues.length !== 0) return "Impact evidence is incomplete.";
  if (impact.sensitive_data || impact.credential || impact.security || impact.destructive || impact.financial !== null || impact.human_presence) {
    return "Sensitive, credential, security, destructive, financial, or human-presence actions require review.";
  }
  if (!["none", "self"].includes(impact.recipient)) return "Actions with an external or unknown recipient require review.";
  if (impact.effect === "read") return null;
  if (impact.effect === "change" && impact.reversible === true) return null;
  return "Only low-sensitivity reads or reversible self changes are eligible for pre-agent setup.";
}

function reusableAllowEligible(action) {
  return reusableImpactEligibilityReason(action?.impact) === null;
}

async function refreshBadge(runtime, tabId) {
  if (!Number.isInteger(tabId)) return;
  const pending = [...runtime.actions.values()].some((action) => action.tabId === tabId && action.status === "pending_review");
  await chrome.action.setBadgeText({ tabId, text: pending ? "!" : "" });
  if (pending) await chrome.action.setBadgeBackgroundColor({ tabId, color: "#6652a6" });
}

async function notifyReview(action) {
  if (!chrome.notifications?.create) return;
  await chrome.notifications.create(`review:${action.actionId}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("mark.svg"),
    title: "Action needs your authority",
    message: `${action.tool.title || action.tool.name} on ${new URL(action.page.origin).hostname}`.slice(0, 240),
    contextMessage: "Open doA2Ai to review the exact action.",
    priority: 1,
    requireInteraction: true,
  });
}

function receiptSummary(outcome) {
  if (outcome === "completed") return "The page reported completion for the exact authorized action.";
  if (outcome === "denied") return "The person denied this exact action. It was not dispatched.";
  if (outcome === "blocked") return "Policy blocked this action before dispatch.";
  if (outcome === "failed") return "The protected page action failed.";
  return "The final consequence could not be proven. The action was not retried.";
}

function receiptExecutionProjection(action, execution) {
  const projected = redactSensitiveFields(cloneJson(execution));
  if (!action.privateArgumentsRequired) return projected;
  if (Object.hasOwn(projected, "result")) {
    projected.result = { redacted: true, reason: "private_action_result" };
  }
  if (isRecord(projected.error)) {
    projected.error = {
      code: cleanText(projected.error.code, 160) || "PRIVATE_ACTION_ERROR",
      message: "Private action error details were redacted.",
    };
  }
  return projected;
}

async function currentDeviceSigner(runtime) {
  const [deviceId, publicJwk] = await Promise.all([
    runtime.identity.getDeviceId(),
    runtime.identity.publicJwk(),
  ]);
  return {
    algorithm: "ECDSA_P256_SHA256",
    deviceId,
    keyThumbprint: await sha256Hex({ version: "doa2ai.device-key.v1", publicJwk }),
    publicJwk,
  };
}

async function signDeviceStatement(runtime, domain, input) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const signer = await currentDeviceSigner(runtime);
    const signature = await runtime.identity.signStatement({ domain, input });
    const envelope = { version: "doa2ai.signed-statement.v1", domain, input, signature, signer };
    if (await verifyDeviceStatement(envelope)) return envelope;
  }
  throw new Error("DEVICE_STATEMENT_VERIFICATION_FAILED");
}

async function buildSignedReceipt(runtime, action, { outcome, execution, verification }) {
  const terminalAt = action.terminalAt || new Date().toISOString();
  const draft = {
    version: "doa2ai.receipt.v1",
    receiptId: action.receiptId || opaqueId("receipt"),
    actionId: action.actionId,
    createdAt: action.requestedAt,
    requestedAt: action.requestedAt,
    terminalAt,
    outcome,
    summary: receiptSummary(outcome),
    task: { taskId: action.taskId, connectionId: action.connectionId },
    page: { title: action.page.title, origin: action.page.origin, url: action.page.url, documentKey: action.page.documentKey },
    tool: {
      name: action.tool.name,
      title: action.tool.title || action.tool.name,
      description: action.tool.description,
      toolDigest: action.tool.toolDigest,
    },
    arguments: redactSensitiveFields(cloneJson(action.arguments), {
      allValues: action.impact?.credential === true || action.impact?.security === true,
    }),
    actionDigest: action.actionDigest,
    argumentDigest: action.argumentDigest,
    impact: cloneJson(action.impact),
    authority: cloneJson(action.authority),
    authorityProof: action.authorityProof || null,
    execution: receiptExecutionProjection(action, execution),
    verification: cloneJson(verification),
    provenance: {
      authorityOwner: "installed_extension",
      agentAttribution: "browser_agent_unattributed",
      targetEvidence: verification.status,
    },
    serviceBinding: { status: "not_attempted" },
  };
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const signer = await currentDeviceSigner(runtime);
      const receipt = await finalizeLocalReceipt({ ...draft, signer }, (input) => runtime.identity.signStatement({
        domain: "doa2ai.receipt-signature.v1",
        input,
      }));
      if (await verifyLocalReceipt(receipt)) return receipt;
    }
    throw new Error("RECEIPT_SIGNATURE_VERIFICATION_FAILED");
  } catch {
    return finalizeLocalReceipt({
      ...draft,
      signer: null,
      outcome: execution.dispatched ? "unknown" : outcome,
      summary: execution.dispatched ? receiptSummary("unknown") : receiptSummary(outcome),
      verification: execution.dispatched ? { status: "unknown", evidence: "device_signature_unavailable" } : verification,
    }, null);
  }
}

async function terminalize(runtime, action, { outcome, execution, verification }) {
  transientActionArguments.delete(action.actionId);
  action.receiptId ||= opaqueId("receipt");
  action.terminalAt ||= new Date().toISOString();
  const candidate = await buildSignedReceipt(runtime, action, { outcome, execution, verification });
  const stateChanging = action.impact.effect !== "read";
  const bindingRequiredForOutcome = stateChanging && execution.dispatched;
  let receipt = bindingRequiredForOutcome
    ? await buildSignedReceipt(runtime, action, {
      outcome: "unknown",
      execution: { ...execution, reportedStatus: execution.status, status: "unknown" },
      verification: { status: "unknown", evidence: "service_binding_pending" },
    })
    : candidate;
  receipt = {
    ...receipt,
    serviceBinding: runtime.connection.status === "connected"
      ? { status: "pending", candidateReceiptDigest: candidate.receiptDigest }
      : { status: bindingRequiredForOutcome ? "unknown" : "unavailable", code: runtime.connection.detail || "SERVICE_NOT_CONNECTED" },
  };

  const persistTerminal = async () => {
    action.status = receipt.outcome;
    action.updatedAt = receipt.terminalAt;
    action.receiptId = receipt.receiptId;
    action.execution = receipt.execution;
    action.verification = receipt.verification;
    runtime.actions.set(action.actionId, action);
    await runtime.store.putReceipt(receipt);
    await persistRuntime(runtime);
  };

  // A crash or MV3 suspension during broker binding now recovers a durable
  // terminal record. State-changing success remains unknown until bound.
  await persistTerminal();

  if (runtime.connection.status === "connected") {
    try {
      const client = await signedServiceClient(runtime);
      const binding = await client.bindReceipt({
        actionId: action.actionId,
        taskId: action.taskId,
        receiptDigest: candidate.receiptDigest,
      });
      receipt = {
        ...candidate,
        serviceBinding: {
          status: "bound",
          boundAt: binding.bound_at,
          receiptDigest: binding.receipt_digest,
        },
      };
    } catch (error) {
      receipt = {
        ...(bindingRequiredForOutcome ? receipt : candidate),
        serviceBinding: {
          status: execution.dispatched ? "unknown" : "unavailable",
          code: boundedError(error),
          attemptedReceiptDigest: candidate.receiptDigest,
        },
      };
    }
    await persistTerminal();
  }

  await refreshBadge(runtime, action.tabId);
  if (chrome.notifications?.clear) await chrome.notifications.clear(`review:${action.actionId}`).catch(() => {});
  requestToAction.delete(action.requestId);
  return actionStatusResult(action);
}

async function freshActionBinding(runtime, action) {
  const tab = await chrome.tabs.get(action.tabId);
  if (tab.url !== action.page.url) throw new Error("DOCUMENT_IDENTITY_CHANGED");
  const discovery = await discoverPage(action.tabId);
  if (discovery.documentKey !== action.page.documentKey || discovery.revision !== action.page.catalogRevision) {
    try { await installPageProtection(runtime, action.tabId); } catch {}
    throw new Error("TOOL_CATALOG_CHANGED");
  }
  const expected = discovery.catalog.find((tool) => tool.name === action.tool.name);
  if (!expected) throw new Error("SOURCE_TOOL_UNAVAILABLE");
  const bound = await bindToolDefinition(expected, discovery);
  if (bound.toolDigest !== action.tool.toolDigest) throw new Error("TOOL_DEFINITION_CHANGED");
  return expected;
}

function authorityBinding(authority, policyRevision = authority?.policyRevision) {
  return {
    decision: authority?.decision ?? null,
    authorityMode: authority?.authorityMode ?? null,
    source: authority?.source ?? null,
    ruleId: authority?.ruleId ?? null,
    approvalId: authority?.approvalId ?? null,
    policyRevision: policyRevision ?? null,
  };
}

function evaluateBoundActionAuthority(runtime, action, { reopenConsumedApproval = false } = {}) {
  const classifiedImpact = classifyToolImpact(action.tool);
  const impact = attestImpact(action.privateArgumentShape ? {
    ...classifiedImpact,
    sensitive_data: true,
    source: "tool_definition_and_private_argument_shape",
    confidence: "high",
  } : classifiedImpact);
  if (canonicalJson(impact) !== canonicalJson(action.impact)) throw new Error("ACTION_IMPACT_CHANGED");
  const policy = cloneJson(runtime.policy);
  if (reopenConsumedApproval && action.approvalId) {
    const approval = policy.transactionApprovals.find((entry) => entry.id === action.approvalId);
    if (!approval || approval.actionDigest !== action.actionDigest || !action.approvalConsumedAt) {
      throw new Error("APPROVAL_CONSUMPTION_NOT_PROVEN");
    }
    approval.consumedAt = null;
  }
  const authority = evaluateAuthority(policy, {
    ...runtime.tasks.authorityContext(action.taskId, action.connectionId),
    origin: action.page.origin,
    toolName: action.tool.name,
    toolDigest: action.tool.toolDigest,
    actionDigest: action.actionDigest,
    argumentDigest: action.argumentDigest,
    impact,
  });
  return authority;
}

function assertCurrentDispatchAuthority(runtime, action) {
  if (action.cancelRequestedAt) throw new Error("ACTION_CANCELLED_BEFORE_DISPATCH");
  const authority = evaluateBoundActionAuthority(runtime, action, { reopenConsumedApproval: true });
  if (authority.decision !== "allow") throw new Error(`DISPATCH_AUTHORITY_${authority.reason || "NOT_CURRENT"}`);
  if (action.approvalId && authority.approvalId !== action.approvalId) throw new Error("APPROVAL_BINDING_MISMATCH");
  if (canonicalJson(authorityBinding(authority, runtime.policy.revision)) !== canonicalJson(authorityBinding(action.authority))) {
    throw new Error("AUTHORITY_BINDING_CHANGED");
  }
  return authority;
}

function dispatchArgumentsForAction(action) {
  if (!action.privateArgumentsRequired) return action.arguments;
  const transient = transientActionArguments.get(action.actionId);
  if (!transient || transient.argumentDigest !== action.argumentDigest) {
    throw new Error("PRIVATE_INPUT_REENTRY_REQUIRED");
  }
  return transient.arguments;
}

async function executeAuthorizedAction(runtime, action) {
  if (executionLocks.has(action.actionId)) return executionLocks.get(action.actionId);
  const stateChanging = action.impact.effect !== "read";
  const queueKey = stateChanging ? `${action.taskId}\n${action.page.origin}` : null;
  const run = async () => {
    if (action.privateArgumentsRequired && !transientActionArguments.has(action.actionId)) {
      return terminalize(runtime, action, {
        outcome: "blocked",
        execution: { status: "not_dispatched", dispatched: false, error: { code: "PRIVATE_INPUT_REENTRY_REQUIRED", message: "Private inputs were not persisted. Retry the exact action to authorize it again." } },
        verification: { status: "blocked", evidence: "transient_input_unavailable" },
      });
    }
    if (stateChanging) {
      const connection = await connectDevice(runtime);
      if (connection.status !== "connected") {
        return terminalize(runtime, action, {
          outcome: "blocked",
          execution: { status: "not_dispatched", dispatched: false, error: { code: "SERVICE_UNAVAILABLE", message: "State-changing actions stop while coordination is unavailable." } },
          verification: { status: "blocked", evidence: "pre_dispatch_service_check" },
        });
      }
    }

    let expectedTool;
    try {
      expectedTool = await freshActionBinding(runtime, action);
      const authorityStatement = canonicalJson({
        version: "doa2ai.authority-proof.v1",
        actionDigest: action.actionDigest,
        decision: action.authority.decision,
        mode: action.authority.authorityMode,
        source: action.authority.source,
        ruleId: action.authority.ruleId || null,
        approvalId: action.authority.approvalId || null,
        policyRevision: action.authority.policyRevision,
        decidedAt: action.authority.decidedAt || action.requestedAt,
      });
      action.authorityProof = await signDeviceStatement(runtime, "doa2ai.authority-proof.v1", authorityStatement);
    } catch (error) {
      return terminalize(runtime, action, {
        outcome: "blocked",
        execution: { status: "not_dispatched", dispatched: false, error: { code: boundedError(error), message: "The exact page or authority binding is no longer current." } },
        verification: { status: "blocked", evidence: "pre_dispatch_binding" },
      });
    }

    try {
      await consumeApprovalImmediatelyBeforeDispatch(runtime, action);
    } catch (error) {
      return terminalize(runtime, action, {
        outcome: "blocked",
        execution: { status: "not_dispatched", dispatched: false, error: { code: boundedError(error), message: "The exact one-time approval could not be consumed safely." } },
        verification: { status: "blocked", evidence: "approval_consumption" },
      });
    }

    action.status = "dispatching";
    action.updatedAt = new Date().toISOString();
    action.dispatchStartedAt = action.updatedAt;
    runtime.actions.set(action.actionId, action);
    try {
      await persistRuntime(runtime);
    } catch (error) {
      if (action.privateArgumentsRequired) {
        try {
          return await terminalize(runtime, action, {
            outcome: "blocked",
            execution: {
              status: "not_dispatched",
              dispatched: false,
              error: {
                code: "PRE_DISPATCH_PERSISTENCE_FAILED",
                message: "The private action stopped because its redacted pre-dispatch state could not be stored safely.",
              },
            },
            verification: { status: "blocked", evidence: "pre_dispatch_persistence" },
          });
        } catch {
          await abandonPrivateActionAfterPersistenceFailure(runtime, action);
        }
      }
      throw error;
    }

    let dispatch;
    try {
      assertCurrentDispatchAuthority(runtime, action);
      const dispatchArguments = dispatchArgumentsForAction(action);
      // No await is permitted between this final authority check and initiating
      // the page call: pause/revoke/policy messages cannot interleave here.
      dispatch = executePageTool(
        action.tabId,
        { documentKey: action.page.documentKey },
        { tool: { name: action.tool.name }, arguments: dispatchArguments, actionHash: action.actionDigest },
        expectedTool,
      );
    } catch (error) {
      return terminalize(runtime, action, {
        outcome: "blocked",
        execution: { status: "not_dispatched", dispatched: false, error: { code: boundedError(error), message: "Authority changed before the exact page action could be dispatched." } },
        verification: { status: "blocked", evidence: "final_dispatch_authority_check" },
      });
    }
    const envelope = await dispatch;
    if (envelope.status === "completed") {
      return terminalize(runtime, action, {
        outcome: "completed",
        execution: { status: "completed", dispatched: true, result: envelope.result, reportedAt: new Date().toISOString() },
        verification: { status: "tool_reported", evidence: "webmcp_return_value" },
      });
    }
    return terminalize(runtime, action, {
      outcome: envelope.status === "failed" ? "failed" : "unknown",
      execution: { status: envelope.status, dispatched: true, error: envelope.error, reportedAt: new Date().toISOString() },
      verification: { status: envelope.status === "failed" ? "failed" : "unknown", evidence: "webmcp_error" },
    });
  };
  const prior = queueKey ? dispatchQueues.get(queueKey) : null;
  const operation = (prior ? prior.catch(() => {}).then(run) : run()).finally(() => {
    executionLocks.delete(action.actionId);
    if (queueKey && dispatchQueues.get(queueKey) === operation) dispatchQueues.delete(queueKey);
  });
  executionLocks.set(action.actionId, operation);
  if (queueKey) dispatchQueues.set(queueKey, operation);
  return operation;
}

async function prepareAction(runtime, message, sender) {
  if (!runtime.enabled) throw new Error("DOA2AI_NOT_ENABLED");
  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;
  if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) throw new Error("PAGE_SENDER_REQUIRED");
  const requestId = cleanText(message.requestId, 160);
  if (!requestId) throw new Error("REQUEST_ID_REQUIRED");
  const pageUrl = sender.url || sender.tab.url || message.pageUrl;
  if (!isInspectableUrl(pageUrl) || message.pageUrl !== pageUrl) throw new Error("PAGE_IDENTITY_MISMATCH");
  let page = runtime.pages.get(tabId);
  if (!page || page.pageUrl !== pageUrl) page = await installPageProtection(runtime, tabId);
  const payload = message.payload;
  if (!isRecord(payload) || payload.documentKey !== page.documentKey) throw new Error("DOCUMENT_IDENTITY_CHANGED");
  const tool = page.tools.find((entry) => entry.protectedName === payload.protectedName && entry.name === payload.sourceName);
  if (!tool || tool.toolDigest !== payload.toolDigest) throw new Error("PROTECTED_TOOL_BINDING_MISMATCH");
  if (!isRecord(payload.arguments)) throw new Error("INVALID_TOOL_ARGUMENTS");
  const args = cloneJson(payload.arguments);
  if (new TextEncoder().encode(canonicalJson(args)).byteLength > MAX_ARGUMENT_BYTES) throw new Error("TOOL_ARGUMENTS_TOO_LARGE");

  const connectionId = connectionIdForWindow(windowId);
  let task = runtime.tasks.getOrCreate({ windowId, connectionId });
  task = runtime.tasks.bindPage(task.taskId, { tabId, origin: page.origin, documentKey: page.documentKey });
  const classifiedImpact = classifyToolImpact(tool);
  const secretShapedArguments = containsSensitiveFields(args);
  const privateShapedArguments = containsPrivateFields(args);
  const impact = attestImpact(secretShapedArguments ? {
    ...classifiedImpact,
    effect: classifiedImpact.destructive ? "change" : "external",
    reversible: false,
    sensitive_data: true,
    credential: true,
    security: true,
    recipient: "external",
    source: "tool_definition_and_argument_shape",
    confidence: "high",
  } : privateShapedArguments ? {
    ...classifiedImpact,
    sensitive_data: true,
    source: "tool_definition_and_private_argument_shape",
    confidence: "high",
  } : classifiedImpact);
  const privateArgumentsRequired = !secretShapedArguments
    && (privateShapedArguments || impact.sensitive_data === true);
  const durableArguments = redactSensitiveFields(args, {
    allValues: impact.credential === true || impact.security === true || privateArgumentsRequired,
  });
  const bindingArguments = privateArgumentsRequired ? args : durableArguments;
  const actionDigest = await computeActionDigest({
    taskId: task.taskId,
    connectionId,
    origin: page.origin,
    documentKey: page.documentKey,
    tool,
    arguments: bindingArguments,
  });
  const argumentDigest = await computeArgumentsDigest(bindingArguments);
  if (impact.effect !== "read") {
    const current = [...runtime.actions.values()].find((entry) => entry.actionDigest === actionDigest && !retryablePrivateNoDispatch(entry));
    if (current) {
      consumePendingCancel(requestId, tabId);
      return { result: actionStatusResult(current, { deduplicated: true }) };
    }
    const priorReceipt = (await runtime.store.listReceipts({ limit: 10_000 }))
      .find((receipt) => receipt.actionDigest === actionDigest && !retryablePrivateNoDispatch(receipt));
    if (priorReceipt) {
      consumePendingCancel(requestId, tabId);
      return {
        result: {
          status: priorReceipt.outcome,
          action_id: priorReceipt.actionId,
          receipt_id: priorReceipt.receiptId,
          deduplicated: true,
          ...(priorReceipt.execution?.result === undefined ? {} : { result: priorReceipt.execution.result }),
          ...(priorReceipt.execution?.error === undefined ? {} : { error: priorReceipt.execution.error }),
        },
      };
    }
    // Another identical invocation may have progressed while IndexedDB was
    // consulted. Recheck the in-memory lineage synchronously before creation.
    const raced = [...runtime.actions.values()].find((entry) => entry.actionDigest === actionDigest && !retryablePrivateNoDispatch(entry));
    if (raced) {
      consumePendingCancel(requestId, tabId);
      return { result: actionStatusResult(raced, { deduplicated: true }) };
    }
  }
  runtime.tasks.touch(task.taskId, { connectionId, tabId });
  const taskContext = runtime.tasks.authorityContext(task.taskId, connectionId);
  const authority = evaluateAuthority(runtime.policy, {
    ...taskContext,
    origin: page.origin,
    toolName: tool.name,
    toolDigest: tool.toolDigest,
    actionDigest,
    argumentDigest,
    impact,
  });
  const requestedAt = new Date().toISOString();
  const action = {
    actionId: opaqueId("act"),
    requestId,
    status: "evaluating",
    requestedAt,
    updatedAt: requestedAt,
    tabId,
    windowId,
    taskId: task.taskId,
    connectionId,
    page: {
      title: page.title,
      origin: page.origin,
      url: page.pageUrl,
      documentKey: page.documentKey,
      catalogRevision: page.catalogRevision,
    },
    tool: {
      name: tool.name,
      title: tool.title || tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      toolDigest: tool.toolDigest,
      protectedName: tool.protectedName,
    },
    arguments: durableArguments,
    privateArgumentsRequired,
    privateArgumentShape: privateShapedArguments,
    impact: authority.impact,
    actionDigest,
    argumentDigest,
    authority: { ...authority, policyRevision: runtime.policy.revision, decidedAt: requestedAt },
    receiptId: null,
  };
  if (privateArgumentsRequired) {
    transientActionArguments.set(action.actionId, { arguments: args, argumentDigest });
  }
  runtime.actions.set(action.actionId, action);
  requestToAction.set(action.requestId, action.actionId);
  if (consumePendingCancel(action.requestId, action.tabId)) action.cancelRequestedAt = new Date().toISOString();
  try {
    await persistRuntime(runtime);
  } catch (error) {
    if (action.privateArgumentsRequired) {
      await abandonPrivateActionAfterPersistenceFailure(runtime, action);
    }
    throw error;
  }
  return { action };
}

async function invokeProtected(message, sender) {
  const runtime = await authorityRuntime();
  const prepared = await prepareAction(runtime, message, sender);
  if (prepared.result) return prepared.result;
  const action = prepared.action;
  if (action.cancelRequestedAt) {
    return terminalize(runtime, action, {
      outcome: "blocked",
      execution: { status: "not_dispatched", dispatched: false, error: { code: "ACTION_CANCELLED_BEFORE_DISPATCH", message: "The page cancelled this protected action before dispatch." } },
      verification: { status: "blocked", evidence: "page_cancellation" },
    });
  }
  if (runtime.paused || action.authority.decision === "block") {
    runtime.blockedCount += 1;
    return terminalize(runtime, action, {
      outcome: "blocked",
      execution: { status: "not_dispatched", dispatched: false, error: { code: action.authority.reason || "POLICY_BLOCKED", message: "Policy blocked the exact action before dispatch." } },
      verification: { status: "blocked", evidence: "local_policy" },
    });
  }
  if (action.authority.decision === "ask") {
    action.status = "pending_review";
    action.updatedAt = new Date().toISOString();
    runtime.actions.set(action.actionId, action);
    try {
      await persistRuntime(runtime);
    } catch (error) {
      if (action.privateArgumentsRequired) {
        await abandonPrivateActionAfterPersistenceFailure(runtime, action);
      }
      throw error;
    }
    if (action.cancelRequestedAt) {
      return terminalize(runtime, action, {
        outcome: "blocked",
        execution: { status: "not_dispatched", dispatched: false, error: { code: "ACTION_CANCELLED_BEFORE_DISPATCH", message: "The page cancelled this protected action before review." } },
        verification: { status: "blocked", evidence: "page_cancellation" },
      });
    }
    await refreshBadge(runtime, action.tabId);
    await notifyReview(action).catch(() => {});
    return actionStatusResult(action);
  }
  action.status = "authorized";
  runtime.actions.set(action.actionId, action);
  try {
    await persistRuntime(runtime);
  } catch (error) {
    if (action.privateArgumentsRequired) {
      await abandonPrivateActionAfterPersistenceFailure(runtime, action);
    }
    throw error;
  }
  return executeAuthorizedAction(runtime, action);
}

async function protectedStatus(message, sender) {
  const runtime = await authorityRuntime();
  const tabId = sender.tab?.id;
  const payload = message.payload;
  if (!Number.isInteger(tabId) || !isRecord(payload)) throw new Error("PAGE_SENDER_REQUIRED");
  const page = runtime.pages.get(tabId);
  if (!page || payload.documentKey !== page.documentKey) throw new Error("DOCUMENT_IDENTITY_CHANGED");
  const actionId = cleanText(payload.actionId, 160);
  const action = runtime.actions.get(actionId);
  if (!action || action.tabId !== tabId) return { status: "not_found", action_id: actionId };
  return actionStatusResult(action);
}

async function cancelProtected(message, sender) {
  const runtime = await authorityRuntime();
  const requestId = cleanText(message.requestId, 160);
  const tabId = sender.tab?.id;
  if (!requestId || !Number.isInteger(tabId)) throw new Error("PAGE_SENDER_REQUIRED");
  const actionId = requestToAction.get(requestId);
  const action = actionId ? runtime.actions.get(actionId) : null;
  if (!action || action.tabId !== tabId) {
    rememberPendingCancel(requestId, tabId);
    return { cancellation: "pending_mapping" };
  }
  action.cancelRequestedAt = new Date().toISOString();
  runtime.actions.set(action.actionId, action);
  await saveActions(runtime);
  if (action.status === "pending_review") {
    await terminalize(runtime, action, {
      outcome: "blocked",
      execution: { status: "not_dispatched", dispatched: false, error: { code: "ACTION_CANCELLED_BEFORE_DISPATCH", message: "The page cancelled this protected action before review." } },
      verification: { status: "blocked", evidence: "page_cancellation" },
    });
    return { cancellation: "recorded", action_id: action.actionId };
  }
  return { cancellation: action.status === "dispatching" ? "outcome_not_inferred" : "recorded", action_id: action.actionId };
}

async function decideReview(runtime, actionId, decision, { confirmReusable = false } = {}) {
  const id = cleanText(actionId, 160);
  const action = runtime.actions.get(id);
  if (!action) throw new Error("ACTION_NOT_FOUND");
  if (action.status !== "pending_review") return action;
  const decidedAt = new Date().toISOString();
  if (decision === "deny") {
    action.authority = {
      ...action.authority,
      decision: "deny",
      authorityMode: "transaction_authorization",
      source: "human_decision",
      policyRevision: runtime.policy.revision,
      decidedAt,
    };
    await terminalize(runtime, action, {
      outcome: "denied",
      execution: { status: "not_dispatched", dispatched: false },
      verification: { status: "blocked", evidence: "human_denial" },
    });
    return action;
  }

  if (action.privateArgumentsRequired && !transientActionArguments.has(action.actionId)) {
    throw new Error("PRIVATE_INPUT_REENTRY_REQUIRED");
  }

  const policy = cloneJson(runtime.policy);
  if (decision === "approve_once") {
    const approvalId = opaqueId("approval", 12);
    policy.transactionApprovals.push({
      id: approvalId,
      actionDigest: action.actionDigest,
      decision: "allow",
      confirmed: true,
      taskId: action.taskId,
      connectionId: action.connectionId,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      consumedAt: null,
    });
    action.approvalId = approvalId;
  } else if (decision === "allow_task") {
    if (confirmReusable !== true) throw new Error("REUSABLE_RULE_CONFIRMATION_REQUIRED");
    if (!reusableAllowEligible(action)) throw new Error("REUSABLE_ALLOW_UNAVAILABLE_FOR_IMPACT");
    const task = runtime.tasks.get(action.taskId);
    const candidate = compileActionRuleCandidate(action, { scope: "task", expiresAt: task?.expiresAt || null });
    policy.rules.push(confirmRuleCandidate(candidate, { confirmed: true }));
  } else if (decision === "allow_universal") {
    if (confirmReusable !== true) throw new Error("REUSABLE_RULE_CONFIRMATION_REQUIRED");
    if (!reusableAllowEligible(action)) throw new Error("REUSABLE_ALLOW_UNAVAILABLE_FOR_IMPACT");
    const candidate = compileActionRuleCandidate(action, { scope: "universal" });
    policy.rules.push(confirmRuleCandidate(candidate, { confirmed: true }));
  } else if (decision === "block") {
    const blockRule = actionRule(action, { id: opaqueId("block", 12), scope: "site_tool", decision: "block" });
    policy.hardBlocks.push(blockRule);
    runtime.policy = normalizePolicy({ ...policy, revision: policyRevision("decision") });
    action.authority = {
      decision: "block",
      authorityMode: null,
      source: "human_block_rule",
      reason: "site_tool_block_confirmed",
      ruleId: blockRule.id,
      policyRevision: runtime.policy.revision,
      impact: action.impact,
      decidedAt,
    };
    runtime.blockedCount += 1;
    await terminalize(runtime, action, {
      outcome: "blocked",
      execution: { status: "not_dispatched", dispatched: false },
      verification: { status: "blocked", evidence: "human_block_rule" },
    });
    return action;
  } else {
    throw new Error("INVALID_REVIEW_DECISION");
  }
  const previousPolicy = runtime.policy;
  runtime.policy = normalizePolicy({ ...policy, revision: policyRevision("decision") });
  let currentAuthority;
  try {
    currentAuthority = evaluateBoundActionAuthority(runtime, action);
    if (currentAuthority.decision !== "allow") throw new Error("REVIEW_AUTHORITY_NOT_CURRENT");
  } catch (error) {
    runtime.policy = previousPolicy;
    if (decision === "approve_once") {
      delete action.approvalId;
      delete action.approvalConsumedAt;
    }
    throw error;
  }
  action.authority = {
    ...currentAuthority,
    policyRevision: runtime.policy.revision,
    decidedAt,
  };
  action.status = "authorized";
  action.updatedAt = decidedAt;
  runtime.actions.set(action.actionId, action);
  try {
    await persistRuntime(runtime);
  } catch (error) {
    if (action.privateArgumentsRequired) {
      await abandonPrivateActionAfterPersistenceFailure(runtime, action, { restorePolicy: previousPolicy });
    }
    throw error;
  }
  await executeAuthorizedAction(runtime, action);
  return action;
}

async function revokeTask(runtime, taskId) {
  const task = runtime.tasks.revoke(taskId);
  for (const action of runtime.actions.values()) {
    if (action.taskId === taskId && action.status === "pending_review") {
      action.authority = { ...action.authority, decision: "block", source: "task_revoked", reason: "task:revoked", decidedAt: new Date().toISOString() };
      runtime.blockedCount += 1;
      await terminalize(runtime, action, {
        outcome: "blocked",
        execution: { status: "not_dispatched", dispatched: false },
        verification: { status: "blocked", evidence: "task_revocation" },
      });
    }
  }
  await persistRuntime(runtime);
  return task;
}

async function setPaused(runtime, paused = !runtime.paused) {
  runtime.paused = Boolean(paused);
  runtime.tasks.setGlobalPaused(runtime.paused);
  replacePolicy(runtime, { globalPaused: runtime.paused });
  await saveAuthorityState(runtime);
  return runtime.paused;
}

async function revokeRule(runtime, ruleId) {
  const id = cleanText(ruleId, 160);
  if (!id) throw new Error("RULE_ID_REQUIRED");
  const policy = cloneJson(runtime.policy);
  let found = false;
  const revokedAt = new Date().toISOString();
  for (const collectionName of ["rules", "hardBlocks"]) {
    policy[collectionName] = policy[collectionName].map((rule) => {
      if (rule.id !== id) return rule;
      found = true;
      return { ...rule, revokedAt: rule.revokedAt || revokedAt };
    });
  }
  if (!found) throw new Error("RULE_NOT_FOUND");
  runtime.policy = normalizePolicy({ ...policy, revision: policyRevision("revoke") });
  await saveAuthorityState(runtime);
  return id;
}

function exactUniversalAllow(rule, { origin, toolName, toolDigest, argumentDigest }) {
  return !rule.revokedAt
    && rule.scope === "universal"
    && rule.decision === "allow"
    && rule.origin === origin
    && rule.toolName === toolName
    && rule.toolDigest === toolDigest
    && rule.argumentDigest === argumentDigest;
}

/**
 * Creates one explicit, exact universal allow before an agent asks to use a
 * page tool. The page, definition, and argument digest are all revalidated
 * immediately before the policy mutation.
 */
async function createPreAgentRule(runtime, message) {
  if (message.confirm !== true) throw new Error("RULE_CONFIRMATION_REQUIRED");
  if (!runtime.enabled) throw new Error("DOA2AI_NOT_ENABLED");
  if (!runtime.policy.starter.confirmed) throw new Error("STARTER_POLICY_CONFIRMATION_REQUIRED");

  const tabId = parseTabId(message.tabId);
  if (!Number.isInteger(tabId)) throw new Error("RULE_TARGET_REQUIRED");
  const page = await ruleSetupPage(runtime, tabId);
  if (
    message.pageUrl !== page.pageUrl
    || message.documentKey !== page.documentKey
    || message.catalogRevision !== page.catalogRevision
  ) {
    throw new Error("RULE_TARGET_CHANGED");
  }

  const toolName = cleanText(message.toolName, 128);
  const tool = page.tools.find((entry) => entry.name === toolName && entry.toolDigest === message.toolDigest);
  if (!tool) throw new Error("RULE_TOOL_CHANGED");
  if (!isRecord(message.arguments)) throw new Error("INVALID_RULE_ARGUMENTS");
  const args = cloneJson(message.arguments);
  if (new TextEncoder().encode(canonicalJson(args)).byteLength > MAX_ARGUMENT_BYTES) {
    throw new Error("RULE_ARGUMENTS_TOO_LARGE");
  }
  if (containsSensitiveFields(args)) throw new Error("RULE_ARGUMENTS_SENSITIVE");

  const impact = attestImpact(classifyToolImpact(tool));
  if (!reusableAllowEligible({ impact })) throw new Error("PREAGENT_RULE_IMPACT_NOT_ELIGIBLE");
  const argumentDigest = await computeArgumentsDigest(args);
  const candidate = compileRuleDraft(
    `Allow the exact arguments for ${tool.name} on ${page.origin}.`,
    {
      id: opaqueId("rule", 12),
      scope: "universal",
      decision: "allow",
      impact: exactImpactRule(impact),
      origin: page.origin,
      toolName: tool.name,
      toolDigest: tool.toolDigest,
      argumentDigest,
      expiresAt: null,
      revokedAt: null,
    },
  );
  const confirmedRule = confirmRuleCandidate(candidate, { confirmed: true });

  const operation = runtime.authorityMutationTail.then(async () => {
    const policy = cloneJson(runtime.policy);
    const hardBlock = policy.hardBlocks.find((rule) => (
      !rule.revokedAt
      && rule.origin === page.origin
      && rule.toolName === tool.name
      && rule.toolDigest === tool.toolDigest
    ));
    if (hardBlock) throw new Error("RULE_TARGET_BLOCKED");
    const duplicate = policy.rules.find((rule) => exactUniversalAllow(rule, {
      origin: page.origin,
      toolName: tool.name,
      toolDigest: tool.toolDigest,
      argumentDigest,
    }));
    if (duplicate) return { rule: duplicate, duplicate: true, revision: policy.revision };

    const previousPolicy = runtime.policy;
    const nextPolicy = normalizePolicy({
      ...policy,
      rules: [...policy.rules, confirmedRule],
      revision: policyRevision("preagent-rule"),
    });
    runtime.policy = nextPolicy;
    try {
      await saveAuthorityStateNow(runtime);
    } catch (error) {
      if (runtime.policy === nextPolicy) runtime.policy = previousPolicy;
      throw error;
    }
    return { rule: confirmedRule, duplicate: false, revision: nextPolicy.revision };
  });
  runtime.authorityMutationTail = operation.catch(() => {});
  const result = await operation;
  return {
    rule: cloneJson(result.rule),
    duplicate: result.duplicate,
    revision: result.revision,
  };
}

async function openRules(runtime) {
  let targetTabId = null;
  try {
    const tab = await activeTab();
    if (Number.isInteger(tab.id) && isInspectableUrl(tab.url)) targetTabId = tab.id;
  } catch {}
  if (targetTabId === null) {
    const candidates = [...runtime.pages.values()]
      .filter(setupPageCandidate)
      .sort((left, right) => String(right.installedAt || "").localeCompare(String(left.installedAt || "")));
    targetTabId = candidates[0]?.tabId ?? null;
  }
  return openPage("rules.html", targetTabId === null ? {} : { tab: String(targetTabId) });
}

async function openPage(path, params = {}) {
  const url = new URL(chrome.runtime.getURL(path));
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  return chrome.tabs.create({ url: url.href });
}

async function openControl(runtime, view = "overview") {
  const url = new URL(runtime.serviceUrl);
  url.pathname = "/";
  url.search = "";
  const disclosure = opaqueId("view", 18);
  runtime.controlDisclosure = {
    disclosure,
    expiresAt: Date.now() + 10 * 60 * 1000,
  };
  url.hash = new URLSearchParams({
    view: cleanText(view, 40) || "overview",
    disclosure,
  }).toString();
  return chrome.tabs.create({ url: url.href });
}

async function productState(runtime) {
  let tab = {};
  try { tab = await activeTab(); } catch {}
  let page = Number.isInteger(tab.id) ? runtime.pages.get(tab.id) : null;
  if (runtime.enabled && Number.isInteger(tab.id) && isInspectableUrl(tab.url) && !page) {
    page = await ensureCurrentPageProtection(runtime);
  }
  const inspectable = isInspectableUrl(tab.url);
  const currentPage = {
    title: cleanText(tab.title, 240) || page?.title || "Current page",
    origin: inspectable ? new URL(tab.url).origin : "Browser page",
    inspectable,
    protected: Boolean(page && !page.error),
    protectedToolCount: page?.protectedToolCount || 0,
    detail: page?.error === "WEBMCP_UNAVAILABLE"
      ? "This page does not expose WebMCP tools."
      : page?.error
        ? page.error
        : page?.protectedToolCount === 0 && inspectable
          ? "No page-owned WebMCP tools are currently exposed."
          : "",
    taskId: Number.isInteger(tab.id)
      ? runtime.tasks.list().find((task) => task.pageBindings.some((binding) => binding.tabId === tab.id) && task.status === "active")?.taskId || null
      : null,
  };
  const pending = [...runtime.actions.values()].filter((action) => action.status === "pending_review");
  const tasks = runtime.tasks.list().filter((task) => task.status === "active");
  let deviceId = "";
  let pairing = null;
  try {
    deviceId = await runtime.identity.getDeviceId();
    pairing = await runtime.identity.getPairingState();
  } catch {}
  return {
    enabled: runtime.enabled,
    paused: runtime.paused,
    connection: {
      ...runtime.connection,
      serviceUrl: runtime.serviceUrl,
      serviceOrigin: serviceOrigin(runtime.serviceUrl),
    },
    device: { registered: Boolean(pairing && /^dev_/.test(deviceId)), deviceId: /^dev_/.test(deviceId) ? deviceId : null },
    policy: { starterConfirmed: runtime.policy.starter.confirmed, revision: runtime.policy.revision },
    currentPage,
    counts: { tasks: tasks.length, pendingReviews: pending.length, blocked: runtime.blockedCount },
  };
}

async function controlSnapshot(runtime) {
  const receipts = await runtime.store.listReceipts({ limit: 50 });
  const pending = [...runtime.actions.values()]
    .filter((action) => action.status === "pending_review")
    .map((action) => ({
      actionId: action.actionId,
      taskId: action.taskId,
      summary: action.tool.title || action.tool.name,
      origin: action.page.origin,
      requestedAt: action.requestedAt,
    }));
  return {
    paired: runtime.connection.status === "connected",
    protection: { enabled: runtime.enabled, paused: runtime.paused },
    tasks: runtime.tasks.list().map((task) => ({
      taskId: task.taskId,
      label: task.labels.at(-1)?.value || task.pageBindings.at(-1)?.origin || "Browser task",
      status: task.status,
      expiresAt: task.expiresAt,
      pageBindings: task.pageBindings.map((binding) => ({ origin: binding.origin })),
    })),
    rules: [...runtime.policy.rules, ...runtime.policy.hardBlocks].map((rule) => ({
      id: rule.id,
      scope: rule.scope,
      decision: rule.decision,
      toolName: rule.toolName || null,
      origin: rule.origin || null,
      expiresAt: rule.expiresAt,
    })),
    activity: receipts.map((receipt) => ({
      receiptId: receipt.receiptId,
      actionId: receipt.actionId,
      outcome: receipt.outcome,
      label: receipt.tool?.title || receipt.tool?.name || "Protected action",
      origin: receipt.page?.origin || "",
      terminalAt: receipt.terminalAt,
      verification: receipt.verification?.status || "unknown",
    })),
    pending_reviews: pending,
    blocked_count: runtime.blockedCount,
    connection: {
      status: runtime.connection.status,
      service_origin: serviceOrigin(runtime.serviceUrl),
      checked_at: runtime.connection.checkedAt,
      detail: runtime.connection.detail,
    },
  };
}

async function handleControlBridge(runtime, message, sender) {
  const senderUrl = new URL(sender.url || sender.tab?.url || message.pageUrl || "about:blank");
  const expected = new URL(runtime.serviceUrl);
  if (senderUrl.origin !== expected.origin || senderUrl.pathname !== "/" || message.pageUrl !== senderUrl.href) {
    throw new Error("CONTROL_PAGE_ORIGIN_MISMATCH");
  }
  const disclosure = new URLSearchParams(senderUrl.hash.slice(1)).get("disclosure");
  if (!runtime.controlDisclosure
    || runtime.controlDisclosure.expiresAt <= Date.now()
    || disclosure !== runtime.controlDisclosure.disclosure) {
    throw new Error("CONTROL_DISCLOSURE_NOT_AUTHORIZED");
  }
  const request = message.request;
  if (!isRecord(request)) throw new Error("INVALID_CONTROL_REQUEST");
  if (Object.keys(request).length === 1 && request.operation === "control.snapshot") return controlSnapshot(runtime);
  throw new Error("CONTROL_OPERATION_NOT_ALLOWED");
}

async function enableProduct(runtime, message) {
  if (message.confirmStarterPolicy !== true) throw new Error("STARTER_POLICY_CONFIRMATION_REQUIRED");
  await registerPageBridge();
  runtime.enabled = true;
  runtime.paused = false;
  runtime.tasks.setGlobalPaused(false);
  const current = cloneJson(runtime.policy);
  runtime.policy = normalizePolicy({
    ...current,
    revision: policyRevision("starter"),
    globalPaused: false,
    starter: { version: "balanced-v1", confirmed: true },
  });
  await saveAuthorityState(runtime);
  await connectDevice(runtime);
  await ensureCurrentPageProtection(runtime);
  if (chrome.alarms?.create) await chrome.alarms.create(MAINTENANCE_ALARM, { periodInMinutes: 15 });
  return productState(runtime);
}

async function handleMessage(message, sender = {}) {
  const runtime = await authorityRuntime();
  switch (message?.type) {
    case "product.state":
      return { state: await productState(runtime) };
    case "product.enable":
      return { state: await enableProduct(runtime, message) };
    case "product.connect":
      if (!runtime.enabled) throw new Error("ENABLE_EXTENSION_FIRST");
      await connectDevice(runtime);
      return { state: await productState(runtime) };
    case "product.rotate_device":
      if (message.confirmDeviceRotation !== true) throw new Error("DEVICE_ROTATION_CONFIRMATION_REQUIRED");
      await rotateDevice(runtime);
      return { state: await productState(runtime) };
    case "product.pause":
      await setPaused(runtime, typeof message.paused === "boolean" ? message.paused : !runtime.paused);
      return { state: await productState(runtime) };
    case "settings.service": {
      runtime.serviceUrl = message.serviceUrl ? exactHttpsUrl(message.serviceUrl) : BUILT_IN_SERVICE_URL;
      await chrome.storage.local.set({ [SERVICE_SETTINGS_KEY]: { serviceUrl: runtime.serviceUrl } });
      await runtime.identity.clearPairingState();
      runtime.connection = { status: "not_connected", detail: "Service changed; reconnect this device.", checkedAt: null };
      if (runtime.enabled) await connectDevice(runtime);
      return { state: await productState(runtime) };
    }
    case "protected.page_ready":
      if (!runtime.enabled || !Number.isInteger(sender.tab?.id)) return { ignored: true };
      if (new URL(message.pageUrl).origin === serviceOrigin(runtime.serviceUrl) && new URL(message.pageUrl).pathname === "/") {
        return { control: true };
      }
      try {
        return { page: await installPageProtection(runtime, sender.tab.id) };
      } catch (error) {
        const pageUrl = new URL(message.pageUrl);
        const unavailable = {
          error: boundedError(error), retryAt: new Date(Date.now() + 10_000).toISOString(),
          tabId: sender.tab.id, title: cleanText(sender.tab.title, 240), pageUrl: pageUrl.href,
          origin: pageUrl.origin, protectedToolCount: 0,
        };
        runtime.pages.set(sender.tab.id, unavailable);
        await savePageRuntime(runtime);
        return { page: unavailable };
      }
    case "protected.catalog_changed":
      return { page: await installPageProtection(runtime, sender.tab?.id) };
    case "protected.invoke":
      return invokeProtected(message, sender);
    case "protected.status":
      return protectedStatus(message, sender);
    case "protected.cancel":
      return cancelProtected(message, sender);
    case "review.get": {
      const action = message.actionId
        ? runtime.actions.get(cleanText(message.actionId, 160))
        : [...runtime.actions.values()].filter((entry) => entry.status === "pending_review").sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
      if (!action) throw new Error("NO_PENDING_REVIEW");
      return { action: publicReviewAction(runtime, action) };
    }
    case "review.decide": {
      const action = await decideReview(runtime, message.actionId, message.decision, {
        confirmReusable: message.confirmReusable === true,
      });
      return { action: publicReviewAction(runtime, action) };
    }
    case "receipt.get": {
      const receipt = await runtime.store.getReceipt(cleanText(message.receiptId, 160));
      if (!receipt) throw new Error("RECEIPT_NOT_FOUND");
      return { receipt };
    }
    case "receipt.pin": {
      const receipt = await runtime.store.pinReceipt(cleanText(message.receiptId, 160), message.pinned !== false);
      return { receipt };
    }
    case "receipt.mark_exported": {
      const receipt = await runtime.store.markReceiptExported(cleanText(message.receiptId, 160));
      return { receipt };
    }
    case "activity.list": {
      const receipts = await runtime.store.listReceipts({ limit: 100 });
      return {
        receipts: receipts.map((receipt) => ({
          receiptId: receipt.receiptId,
          title: receipt.tool?.title || receipt.tool?.name || "Protected action",
          outcome: receipt.outcome,
          origin: receipt.page?.origin || "",
          terminalAt: receipt.terminalAt,
        })),
      };
    }
    case "tasks.list":
      return {
        tasks: runtime.tasks.list().map((task) => ({
          taskId: task.taskId,
          label: task.labels.at(-1)?.value || task.pageBindings.at(-1)?.origin || "Browser task",
          status: task.status,
          pageCount: task.pageBindings.length,
          expiresAt: task.expiresAt,
        })),
      };
    case "rules.list":
      return {
        revision: runtime.policy.revision,
        starterRules: starterRuleCatalog({ confirmed: runtime.policy.starter.confirmed }),
        rules: [...runtime.policy.rules, ...runtime.policy.hardBlocks].map((rule) => ({
          id: rule.id,
          scope: rule.scope,
          decision: rule.decision,
          origin: rule.origin || null,
          toolName: rule.toolName || null,
          toolDigest: rule.toolDigest || null,
          argumentDigest: rule.argumentDigest || null,
          expiresAt: rule.expiresAt,
          revokedAt: rule.revokedAt,
        })),
      };
    case "rules.current": {
      const page = await ruleSetupPage(runtime, message.tabId);
      return { page: publicRuleSetupPage(page) };
    }
    case "rule.create":
      return await createPreAgentRule(runtime, message);
    case "rule.revoke":
      return { ruleId: await revokeRule(runtime, message.ruleId) };
    case "task.revoke": {
      let taskId = cleanText(message.taskId, 160);
      if (!taskId) {
        const tab = await activeTab();
        taskId = runtime.tasks.list().find((task) => task.status === "active" && task.pageBindings.some((binding) => binding.tabId === tab.id))?.taskId || "";
      }
      if (!taskId) throw new Error("ACTIVE_TASK_NOT_FOUND");
      return { task: await revokeTask(runtime, taskId) };
    }
    case "page.open_control":
      await openControl(runtime, message.view);
      return { opened: true };
    case "page.open_tasks":
      await openPage("tasks.html");
      return { opened: true };
    case "page.open_rules":
      await openRules(runtime);
      return { opened: true };
    case "page.open_review":
      await openPage("review.html", { action: message.actionId });
      return { opened: true };
    case "page.open_receipt":
      await openPage("receipt.html", { receipt: message.receiptId });
      return { opened: true };
    case "page.open_activity":
      await openPage("activity.html");
      return { opened: true };
    case "page.open_setup":
      await openPage("setup.html");
      return { opened: true };
    case "control.bridge":
      return handleControlBridge(runtime, message, sender);
    default:
      throw new Error("UNKNOWN_EXTENSION_REQUEST");
  }
}

export async function executeBoundPageToolInMainWorld(toolName, args, expectedDocumentKey, expectedDefinition) {
  const clean = (value, max) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
  const decodeSchema = (value) => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return null; }
  };
  // Keep execution-time rebinding aligned with protocol.normalizeSchema: the
  // current WebMCP examples often omit additionalProperties on object
  // schemas, so the protected definition canonicalizes that omission to a
  // closed object before comparing the live page tool digest.
  const canonicalizeSchema = (value, decode = true) => {
    const decoded = decode ? decodeSchema(value) : value;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return decoded;
    const schema = { ...decoded };
    if (schema.type === "object" && schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
      if (!Object.hasOwn(schema, "additionalProperties")) schema.additionalProperties = false;
      schema.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, canonicalizeSchema(child, false)]));
    } else if (schema.type === "array" && Object.hasOwn(schema, "items")) {
      schema.items = canonicalizeSchema(schema.items, false);
    }
    return schema;
  };
  const canonical = (value) => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  };
  const bind = (tool) => ({
    name: clean(tool.name, 128),
    description: clean(tool.description, 4_096),
    inputSchema: tool.inputSchema === undefined
      ? { type: "object", properties: {}, additionalProperties: false }
      : canonicalizeSchema(tool.inputSchema),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: canonicalizeSchema(tool.outputSchema) }),
    annotations: {
      readOnlyHint: tool.annotations?.readOnlyHint === true,
      untrustedContentHint: tool.annotations?.untrustedContentHint === true,
      destructiveHint: tool.annotations?.destructiveHint === true,
      idempotentHint: tool.annotations?.idempotentHint === true,
      openWorldHint: tool.annotations?.openWorldHint === true,
    },
    origin: tool.origin || location.origin,
  });
  const context = document.modelContext;
  if (!context?.getTools || !context?.executeTool) return { kind: "not_executed", code: "WEBMCP_EXECUTION_UNAVAILABLE" };
  if (`${location.href}|${performance.timeOrigin}` !== expectedDocumentKey) return { kind: "not_executed", code: "DOCUMENT_IDENTITY_CHANGED" };
  const tools = await context.getTools();
  const matches = tools.filter((tool) => tool.name === toolName);
  if (matches.length !== 1) return { kind: "not_executed", code: "TOOL_BINDING_NOT_UNIQUE" };
  const tool = matches[0];
  if (canonical(bind(tool)) !== canonical(expectedDefinition)) return { kind: "not_executed", code: "TOOL_DEFINITION_CHANGED" };
  try {
    const output = await context.executeTool(tool, canonical(args));
    return { kind: "completed", output };
  } catch (error) {
    return { kind: "unknown", code: "PAGE_TOOL_OUTCOME_UNKNOWN", message: typeof error?.message === "string" ? error.message.slice(0, 4_096) : "" };
  }
}

export async function executePageTool(tabId, session, command, expectedTool) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [command.tool.name, command.arguments, session.documentKey, expectedTool],
      func: executeBoundPageToolInMainWorld,
    });
    const result = injection?.result;
    if (result?.kind === "completed") return brokerResult(command.actionHash, "completed", safePageResult(result.output));
    if (result?.kind === "failed") return brokerResult(command.actionHash, "failed", result);
    if (result?.kind === "unknown") return brokerResult(command.actionHash, "unknown", result);
    return brokerResult(command.actionHash, "failed", { code: result?.code || "NO_PAGE_RESULT", message: "The exact page tool was not invoked." });
  } catch {
    return brokerResult(command.actionHash, "unknown", {
      code: "BROWSER_INJECTION_OUTCOME_UNKNOWN",
      message: "The browser could not prove whether the page invocation returned.",
    });
  }
}

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void handleMessage(message, sender).then(
      (result) => sendResponse({ ok: true, ...result, result }),
      (error) => sendResponse({ ok: false, error: boundedError(error) }),
    );
    return true;
  });
}

chrome?.tabs?.onRemoved?.addListener((tabId) => {
  void authorityRuntime().then(async (runtime) => {
    runtime.pages.delete(tabId);
    await savePageRuntime(runtime);
  }).catch(() => {});
});

chrome?.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
  if (!changeInfo.url && changeInfo.status !== "loading") return;
  void authorityRuntime().then(async (runtime) => {
    runtime.pages.delete(tabId);
    await savePageRuntime(runtime);
  }).catch(() => {});
});

chrome?.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name !== MAINTENANCE_ALARM) return;
  void authorityRuntime().then(async (runtime) => {
    await runtime.store.pruneReceipts({ retentionDays: runtime.receiptRetentionDays });
    runtime.tasks.list();
    await saveAuthorityState(runtime);
  }).catch(() => {});
});

chrome?.notifications?.onClicked?.addListener((notificationId) => {
  if (!notificationId.startsWith("review:")) return;
  void openPage("review.html", { action: notificationId.slice("review:".length) });
});
