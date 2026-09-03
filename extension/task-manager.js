export const TASK_REGISTRY_VERSION = "doa2ai.task-registry.v1";
export const DEFAULT_TASK_INACTIVITY_MS = 30 * 60 * 1_000;
export const MAX_TASK_CLOCK_SKEW_MS = 5 * 60 * 1_000;

const TASK_ID = /^task_[a-f0-9]{32}$/;

export class TaskRegistryError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "TaskRegistryError";
    this.code = code;
  }
}

function cleanText(value, maximum = 500) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}

function cloneJson(value) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("not JSON");
    return JSON.parse(encoded);
  } catch {
    throw new TaskRegistryError("NON_JSON_VALUE");
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function exactOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.origin !== url.href.replace(/\/$/, "")) {
      throw new Error("not an HTTPS origin");
    }
    return url.origin;
  } catch {
    throw new TaskRegistryError("INVALID_PAGE_ORIGIN");
  }
}

function readNow(clock) {
  const raw = clock();
  const value = raw instanceof Date ? raw.getTime() : typeof raw === "number" ? raw : Date.parse(raw);
  if (!Number.isFinite(value)) throw new TaskRegistryError("INVALID_CLOCK");
  return value;
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function normalizeExpiry(value, field) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    throw new TaskRegistryError("INVALID_TIMESTAMP", field);
  }
  return value;
}

function uuidFromCrypto(cryptoImpl) {
  if (typeof cryptoImpl?.randomUUID === "function") return cryptoImpl.randomUUID();
  if (typeof cryptoImpl?.getRandomValues !== "function") throw new TaskRegistryError("SECURE_RANDOM_UNAVAILABLE");
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Generates an opaque task identifier without encoding page, agent, or user data. */
export function createOpaqueTaskId(cryptoImpl = globalThis.crypto) {
  return `task_${uuidFromCrypto(cryptoImpl).replace(/-/g, "").toLowerCase()}`;
}

function publicTask(task) {
  return deepFreeze(cloneJson(task));
}

function validateWindowId(value) {
  if (!Number.isInteger(value) || value < 0) throw new TaskRegistryError("INVALID_WINDOW_ID");
  return value;
}

function validateTabId(value) {
  if (!Number.isInteger(value) || value < 0) throw new TaskRegistryError("INVALID_TAB_ID");
  return value;
}

function validateConnectionId(value) {
  const connectionId = cleanText(value, 160);
  if (!connectionId) throw new TaskRegistryError("CONNECTION_ID_REQUIRED");
  return connectionId;
}

function normalizeStoredTask(raw, inactivityMs, currentTime) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !TASK_ID.test(raw.taskId)) {
    throw new TaskRegistryError("INVALID_STORED_TASK");
  }
  validateWindowId(raw.windowId);
  if (!["active", "revoked", "ended", "expired"].includes(raw.status)) throw new TaskRegistryError("INVALID_TASK_STATUS");
  const requiredTimes = {};
  for (const field of ["createdAt", "lastGatedAt", "expiresAt"]) {
    requiredTimes[field] = normalizeExpiry(raw[field], field);
    if (!requiredTimes[field]) throw new TaskRegistryError("TASK_TIMESTAMP_REQUIRED", field);
  }
  const createdMilliseconds = Date.parse(requiredTimes.createdAt);
  const lastGatedMilliseconds = Date.parse(requiredTimes.lastGatedAt);
  const expiresMilliseconds = Date.parse(requiredTimes.expiresAt);
  if (createdMilliseconds > lastGatedMilliseconds || expiresMilliseconds !== lastGatedMilliseconds + inactivityMs) {
    throw new TaskRegistryError("INVALID_TASK_INACTIVITY_LEASE");
  }
  // A small skew allowance accommodates clock adjustment without allowing a
  // coordinated future-shifted snapshot to manufacture a multi-year lease.
  if (createdMilliseconds > currentTime + MAX_TASK_CLOCK_SKEW_MS
    || lastGatedMilliseconds > currentTime + MAX_TASK_CLOCK_SKEW_MS) {
    throw new TaskRegistryError("TASK_LEASE_FROM_FUTURE");
  }
  if (!Array.isArray(raw.connections) || !Array.isArray(raw.pageBindings) || !Array.isArray(raw.externalRefs) || !Array.isArray(raw.labels)) {
    throw new TaskRegistryError("INVALID_STORED_TASK_COLLECTION");
  }
  const connections = raw.connections.map((entry) => {
    const connectionId = validateConnectionId(entry?.connectionId);
    if (!["active", "revoked", "expired"].includes(entry.status)) throw new TaskRegistryError("INVALID_CONNECTION_STATUS");
    const attachedAt = normalizeExpiry(entry.attachedAt, "attachedAt");
    if (!attachedAt) throw new TaskRegistryError("CONNECTION_ATTACHED_AT_REQUIRED");
    return {
      connectionId,
      status: entry.status,
      attachedAt,
      expiresAt: normalizeExpiry(entry.expiresAt, "expiresAt"),
      revokedAt: normalizeExpiry(entry.revokedAt, "revokedAt"),
    };
  });
  if (new Set(connections.map((entry) => entry.connectionId)).size !== connections.length) {
    throw new TaskRegistryError("DUPLICATE_CONNECTION");
  }
  const pageBindings = raw.pageBindings.map((entry) => {
    const binding = {
      tabId: validateTabId(entry?.tabId),
      origin: exactOrigin(entry?.origin),
      documentKey: cleanText(entry?.documentKey, 500),
      boundAt: normalizeExpiry(entry?.boundAt, "boundAt"),
      lastSeenAt: normalizeExpiry(entry?.lastSeenAt, "lastSeenAt"),
    };
    if (!binding.documentKey || !binding.boundAt || !binding.lastSeenAt) throw new TaskRegistryError("INVALID_PAGE_BINDING");
    return binding;
  });
  if (new Set(pageBindings.map((entry) => entry.tabId)).size !== pageBindings.length) {
    throw new TaskRegistryError("DUPLICATE_PAGE_BINDING");
  }
  const externalRefs = raw.externalRefs.map((entry) => {
    const value = cleanText(entry?.value, 500);
    const observedAt = normalizeExpiry(entry?.observedAt, "observedAt");
    if (!value || !observedAt || entry.authority !== false) throw new TaskRegistryError("INVALID_EXTERNAL_REFERENCE");
    return { value, observedAt, authority: false };
  });
  const labels = raw.labels.map((entry) => {
    const value = cleanText(entry?.value, 200);
    const observedAt = normalizeExpiry(entry?.observedAt, "observedAt");
    if (!value || !observedAt || entry.authority !== false || !["heuristic", "agent_claimed", "human"].includes(entry.source)) {
      throw new TaskRegistryError("INVALID_TASK_LABEL");
    }
    return { value, source: entry.source, observedAt, authority: false };
  });
  return cloneJson({
    taskId: raw.taskId,
    windowId: raw.windowId,
    status: raw.status,
    createdAt: requiredTimes.createdAt,
    lastGatedAt: requiredTimes.lastGatedAt,
    expiresAt: requiredTimes.expiresAt,
    revokedAt: normalizeExpiry(raw.revokedAt, "revokedAt"),
    endedAt: normalizeExpiry(raw.endedAt, "endedAt"),
    connections,
    pageBindings,
    externalRefs,
    labels,
  });
}

/**
 * Local task registry. Window grouping and labels organize work only; temporary
 * authority remains bound to both the opaque task ID and invoking connection.
 */
export class TaskRegistry {
  #clock;
  #idFactory;
  #inactivityMs;
  #tasks = new Map();
  #globalPaused = false;

  constructor({
    clock = () => Date.now(),
    idFactory = () => createOpaqueTaskId(),
    inactivityMs = DEFAULT_TASK_INACTIVITY_MS,
    snapshot = null,
  } = {}) {
    if (typeof clock !== "function" || typeof idFactory !== "function") throw new TaskRegistryError("INVALID_DEPENDENCY");
    if (!Number.isInteger(inactivityMs) || inactivityMs <= 0) throw new TaskRegistryError("INVALID_INACTIVITY_DURATION");
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#inactivityMs = inactivityMs;
    if (snapshot) this.hydrate(snapshot);
  }

  #now() {
    return readNow(this.#clock);
  }

  #refreshExpiry(task, currentTime = this.#now()) {
    if (task.status === "active" && Date.parse(task.expiresAt) <= currentTime) task.status = "expired";
    for (const connection of task.connections) {
      if (connection.status === "active" && connection.expiresAt && Date.parse(connection.expiresAt) <= currentTime) {
        connection.status = "expired";
      }
    }
    return task;
  }

  #require(taskId) {
    const task = this.#tasks.get(taskId);
    if (!task) throw new TaskRegistryError("TASK_NOT_FOUND", taskId);
    return this.#refreshExpiry(task);
  }

  getOrCreate({ windowId, connectionId, externalRef = null, label = null, labelSource = "heuristic", forceNew = false } = {}) {
    const normalizedWindowId = validateWindowId(windowId);
    const normalizedConnectionId = validateConnectionId(connectionId);
    const currentTime = this.#now();
    const windowTasks = [...this.#tasks.values()]
      .map((entry) => this.#refreshExpiry(entry, currentTime))
      .filter((entry) => entry.windowId === normalizedWindowId && entry.status === "active");
    let task = null;
    if (forceNew) {
      for (const prior of windowTasks) {
        prior.status = "ended";
        prior.endedAt = iso(currentTime);
      }
    } else {
      task = windowTasks[0] ?? null;
    }
    if (!task) {
      const taskId = cleanText(this.#idFactory(), 160);
      if (!TASK_ID.test(taskId) || this.#tasks.has(taskId)) throw new TaskRegistryError("INVALID_OR_DUPLICATE_TASK_ID");
      const createdAt = iso(currentTime);
      task = {
        taskId,
        windowId: normalizedWindowId,
        status: "active",
        createdAt,
        lastGatedAt: createdAt,
        expiresAt: iso(currentTime + this.#inactivityMs),
        revokedAt: null,
        endedAt: null,
        connections: [],
        pageBindings: [],
        externalRefs: [],
        labels: [],
      };
      this.#tasks.set(taskId, task);
    }
    this.attachConnection(task.taskId, { connectionId: normalizedConnectionId });
    this.#recordProvenance(task, { externalRef, label, labelSource }, currentTime);
    return publicTask(task);
  }

  #recordProvenance(task, { externalRef, label, labelSource }, currentTime) {
    const ref = cleanText(externalRef, 500);
    if (ref && !task.externalRefs.some((entry) => entry.value === ref)) {
      task.externalRefs.push({ value: ref, observedAt: iso(currentTime), authority: false });
    }
    const labelValue = cleanText(label, 200);
    if (labelValue && !task.labels.some((entry) => entry.value === labelValue)) {
      const source = ["heuristic", "agent_claimed", "human"].includes(labelSource) ? labelSource : "heuristic";
      task.labels.push({ value: labelValue, source, observedAt: iso(currentTime), authority: false });
    }
  }

  attachConnection(taskId, { connectionId, expiresAt = null } = {}) {
    const task = this.#require(taskId);
    if (task.status !== "active") throw new TaskRegistryError("TASK_NOT_ACTIVE", task.status);
    const normalizedConnectionId = validateConnectionId(connectionId);
    const existing = task.connections.find((entry) => entry.connectionId === normalizedConnectionId);
    if (existing) {
      if (existing.status !== "active") throw new TaskRegistryError("CONNECTION_NOT_ACTIVE", existing.status);
      return publicTask(task);
    }
    const attachedAt = iso(this.#now());
    task.connections.push({
      connectionId: normalizedConnectionId,
      status: "active",
      attachedAt,
      expiresAt: normalizeExpiry(expiresAt, "expiresAt"),
      revokedAt: null,
    });
    task.connections.sort((left, right) => left.connectionId.localeCompare(right.connectionId));
    return publicTask(task);
  }

  revokeConnection(taskId, connectionId) {
    const task = this.#require(taskId);
    const normalizedConnectionId = validateConnectionId(connectionId);
    const connection = task.connections.find((entry) => entry.connectionId === normalizedConnectionId);
    if (!connection) throw new TaskRegistryError("CONNECTION_NOT_FOUND", normalizedConnectionId);
    if (connection.status === "active") {
      connection.status = "revoked";
      connection.revokedAt = iso(this.#now());
    }
    return publicTask(task);
  }

  bindPage(taskId, { tabId, origin, documentKey } = {}) {
    const task = this.#require(taskId);
    if (task.status !== "active") throw new TaskRegistryError("TASK_NOT_ACTIVE", task.status);
    const normalizedTabId = validateTabId(tabId);
    const normalizedOrigin = exactOrigin(origin);
    const normalizedDocumentKey = cleanText(documentKey, 500);
    if (!normalizedDocumentKey) throw new TaskRegistryError("DOCUMENT_KEY_REQUIRED");
    const currentTime = iso(this.#now());
    const existing = task.pageBindings.find((entry) => entry.tabId === normalizedTabId);
    if (existing) {
      existing.origin = normalizedOrigin;
      existing.documentKey = normalizedDocumentKey;
      existing.boundAt = currentTime;
      existing.lastSeenAt = currentTime;
    } else {
      task.pageBindings.push({
        tabId: normalizedTabId,
        origin: normalizedOrigin,
        documentKey: normalizedDocumentKey,
        boundAt: currentTime,
        lastSeenAt: currentTime,
      });
      task.pageBindings.sort((left, right) => left.tabId - right.tabId);
    }
    return publicTask(task);
  }

  touch(taskId, { connectionId, tabId = null } = {}) {
    const task = this.#require(taskId);
    if (task.status !== "active") throw new TaskRegistryError("TASK_NOT_ACTIVE", task.status);
    const normalizedConnectionId = validateConnectionId(connectionId);
    const connection = task.connections.find((entry) => entry.connectionId === normalizedConnectionId);
    if (!connection || connection.status !== "active") throw new TaskRegistryError("CONNECTION_NOT_ACTIVE");
    if (tabId !== null) {
      const binding = task.pageBindings.find((entry) => entry.tabId === validateTabId(tabId));
      if (!binding) throw new TaskRegistryError("PAGE_NOT_BOUND");
      binding.lastSeenAt = iso(this.#now());
    }
    const currentTime = this.#now();
    task.lastGatedAt = iso(currentTime);
    task.expiresAt = iso(currentTime + this.#inactivityMs);
    return publicTask(task);
  }

  revoke(taskId) {
    const task = this.#require(taskId);
    if (task.status === "active") {
      task.status = "revoked";
      task.revokedAt = iso(this.#now());
    }
    return publicTask(task);
  }

  end(taskId) {
    const task = this.#require(taskId);
    if (task.status === "active") {
      task.status = "ended";
      task.endedAt = iso(this.#now());
    }
    return publicTask(task);
  }

  setGlobalPaused(paused) {
    if (typeof paused !== "boolean") throw new TaskRegistryError("INVALID_PAUSE_STATE");
    this.#globalPaused = paused;
    return this.#globalPaused;
  }

  get globalPaused() {
    return this.#globalPaused;
  }

  get(taskId) {
    const task = this.#tasks.get(taskId);
    return task ? publicTask(this.#refreshExpiry(task)) : null;
  }

  list() {
    const currentTime = this.#now();
    return deepFreeze([...this.#tasks.values()]
      .map((task) => publicTask(this.#refreshExpiry(task, currentTime)))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
  }

  authorityContext(taskId, connectionId) {
    const task = this.#require(taskId);
    const normalizedConnectionId = validateConnectionId(connectionId);
    const connection = task.connections.find((entry) => entry.connectionId === normalizedConnectionId);
    return deepFreeze({
      globalPaused: this.#globalPaused,
      task: {
        taskId: task.taskId,
        status: this.#globalPaused && task.status === "active" ? "paused" : task.status,
        expiresAt: task.expiresAt,
      },
      connection: connection
        ? { connectionId: connection.connectionId, status: connection.status, expiresAt: connection.expiresAt }
        : { connectionId: normalizedConnectionId, status: "unknown", expiresAt: null },
    });
  }

  snapshot() {
    return deepFreeze({
      version: TASK_REGISTRY_VERSION,
      globalPaused: this.#globalPaused,
      inactivityMs: this.#inactivityMs,
      tasks: this.list(),
    });
  }

  hydrate(raw) {
    if (!raw || typeof raw !== "object" || raw.version !== TASK_REGISTRY_VERSION || !Array.isArray(raw.tasks)) {
      throw new TaskRegistryError("INVALID_TASK_REGISTRY_SNAPSHOT");
    }
    if (typeof raw.globalPaused !== "boolean" || raw.inactivityMs !== this.#inactivityMs) {
      throw new TaskRegistryError("INCOMPATIBLE_TASK_REGISTRY_SNAPSHOT");
    }
    const currentTime = this.#now();
    const tasks = raw.tasks.map((task) => normalizeStoredTask(task, this.#inactivityMs, currentTime));
    if (new Set(tasks.map((task) => task.taskId)).size !== tasks.length) throw new TaskRegistryError("DUPLICATE_TASK_ID");
    const activeWindows = tasks.filter((task) => task.status === "active").map((task) => task.windowId);
    if (new Set(activeWindows).size !== activeWindows.length) throw new TaskRegistryError("MULTIPLE_ACTIVE_TASKS_PER_WINDOW");
    const replacement = new Map(tasks.map((task) => [task.taskId, task]));
    this.#tasks = replacement;
    this.#globalPaused = raw.globalPaused;
    return this.snapshot();
  }
}
