export const LOCAL_STATE_VERSION = "doa2ai.local-state.v1";
export const LOCAL_STATE_KEY = "doa2ai.local-authority.v1";
export const DEFAULT_RECEIPT_RETENTION_DAYS = 30;

export class LocalStoreError extends Error {
  constructor(code, cause = null) {
    super(code, cause ? { cause } : undefined);
    this.name = "LocalStoreError";
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("not JSON");
    return JSON.parse(encoded);
  } catch (error) {
    throw new LocalStoreError("NON_JSON_VALUE", error);
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function exactIso(value, field) {
  if (typeof value !== "string") throw new LocalStoreError(`INVALID_${field.toUpperCase()}`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new LocalStoreError(`INVALID_${field.toUpperCase()}`);
  }
  return value;
}

function currentMilliseconds(clock) {
  const raw = clock();
  const milliseconds = raw instanceof Date ? raw.getTime() : typeof raw === "number" ? raw : Date.parse(raw);
  if (!Number.isFinite(milliseconds)) throw new LocalStoreError("INVALID_CLOCK");
  return milliseconds;
}

function failClosedState() {
  return {
    version: LOCAL_STATE_VERSION,
    stateRevision: 0,
    settings: {
      enabled: false,
      globalPaused: true,
      receiptRetentionDays: DEFAULT_RECEIPT_RETENTION_DAYS,
    },
    policy: null,
    tasks: null,
    index: {
      pendingActionIds: [],
      blockedCount: 0,
    },
  };
}

function normalizeState(raw) {
  if (!isRecord(raw) || raw.version !== LOCAL_STATE_VERSION) throw new LocalStoreError("INVALID_LOCAL_STATE");
  if (!Number.isSafeInteger(raw.stateRevision) || raw.stateRevision < 0) throw new LocalStoreError("INVALID_STATE_REVISION");
  if (!isRecord(raw.settings) || typeof raw.settings.enabled !== "boolean" || typeof raw.settings.globalPaused !== "boolean") {
    throw new LocalStoreError("INVALID_LOCAL_SETTINGS");
  }
  const receiptRetentionDays = raw.settings.receiptRetentionDays;
  if (!Number.isInteger(receiptRetentionDays) || receiptRetentionDays < 1 || receiptRetentionDays > 3_650) {
    throw new LocalStoreError("INVALID_RECEIPT_RETENTION");
  }
  if (!isRecord(raw.index) || !Array.isArray(raw.index.pendingActionIds) || !Number.isInteger(raw.index.blockedCount) || raw.index.blockedCount < 0) {
    throw new LocalStoreError("INVALID_LOCAL_INDEX");
  }
  if (raw.index.pendingActionIds.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 160)) {
    throw new LocalStoreError("INVALID_PENDING_ACTION_INDEX");
  }
  return deepFreeze(cloneJson({
    version: LOCAL_STATE_VERSION,
    stateRevision: raw.stateRevision,
    settings: raw.settings,
    policy: raw.policy ?? null,
    tasks: raw.tasks ?? null,
    index: raw.index,
  }));
}

/** Wraps one injected `chrome.storage.local` compatible storage area. */
export function createChromeStorageAdapter(storageArea) {
  if (!storageArea || typeof storageArea.get !== "function" || typeof storageArea.set !== "function") {
    throw new LocalStoreError("CHROME_LOCAL_STORAGE_UNAVAILABLE");
  }
  return Object.freeze({
    async get(key) {
      const result = await storageArea.get(key);
      return isRecord(result) ? result[key] : undefined;
    },
    async set(key, value) {
      await storageArea.set({ [key]: value });
    },
    async remove(key) {
      if (typeof storageArea.remove !== "function") throw new LocalStoreError("CHROME_LOCAL_REMOVE_UNAVAILABLE");
      await storageArea.remove(key);
    },
  });
}

function openReceiptDatabase(indexedDBImpl, { databaseName, storeName }) {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDBImpl.open(databaseName, 1);
    } catch (error) {
      reject(new LocalStoreError("RECEIPT_DATABASE_OPEN_FAILED", error));
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) {
        const store = database.createObjectStore(storeName, { keyPath: "receiptId" });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new LocalStoreError("RECEIPT_DATABASE_OPEN_FAILED", request.error));
    request.onblocked = () => reject(new LocalStoreError("RECEIPT_DATABASE_BLOCKED"));
  });
}

/** Creates a lazy IndexedDB adapter. Opening the database has no import-time side effect. */
export function createIndexedDbReceiptAdapter(indexedDBImpl, {
  databaseName = "doa2ai-receipts-v1",
  storeName = "receipts",
} = {}) {
  if (!indexedDBImpl || typeof indexedDBImpl.open !== "function") throw new LocalStoreError("INDEXED_DB_UNAVAILABLE");
  let databasePromise = null;
  const database = () => {
    databasePromise ??= openReceiptDatabase(indexedDBImpl, { databaseName, storeName });
    return databasePromise;
  };
  const run = async (mode, operation, errorCode) => {
    const db = await database();
    return new Promise((resolve, reject) => {
      let request;
      let result;
      let transaction;
      try {
        transaction = db.transaction(storeName, mode);
        request = operation(transaction.objectStore(storeName));
      } catch (error) {
        reject(new LocalStoreError(errorCode, error));
        return;
      }
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(new LocalStoreError(errorCode, request.error));
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(new LocalStoreError(errorCode, transaction.error));
      transaction.onabort = () => reject(new LocalStoreError(errorCode, transaction.error));
    });
  };
  const update = async (receiptId, updater, errorCode) => {
    const db = await database();
    return new Promise((resolve, reject) => {
      let transaction;
      let result = null;
      try {
        transaction = db.transaction(storeName, "readwrite");
        const store = transaction.objectStore(storeName);
        const getRequest = store.get(receiptId);
        getRequest.onsuccess = () => {
          try {
            const current = getRequest.result;
            if (!current) return;
            const operation = updater(current);
            if (!operation) return;
            result = operation.result;
            const writeRequest = operation.delete ? store.delete(receiptId) : store.put(operation.value);
            writeRequest.onerror = () => {
              try { transaction.abort(); } catch { /* transaction already closed */ }
            };
          } catch (error) {
            try { transaction.abort(); } catch { /* transaction already closed */ }
            reject(new LocalStoreError(errorCode, error));
          }
        };
        getRequest.onerror = () => reject(new LocalStoreError(errorCode, getRequest.error));
      } catch (error) {
        reject(new LocalStoreError(errorCode, error));
        return;
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(new LocalStoreError(errorCode, transaction.error));
      transaction.onabort = () => reject(new LocalStoreError(errorCode, transaction.error));
    });
  };
  return Object.freeze({
    put: (record) => run("readwrite", (store) => store.put(record), "RECEIPT_WRITE_FAILED"),
    get: (receiptId) => run("readonly", (store) => store.get(receiptId), "RECEIPT_READ_FAILED"),
    getAll: () => run("readonly", (store) => store.getAll(), "RECEIPT_LIST_FAILED"),
    delete: (receiptId) => run("readwrite", (store) => store.delete(receiptId), "RECEIPT_DELETE_FAILED"),
    updateRetention: (receiptId, changes) => update(receiptId, (current) => {
      const normalized = normalizeReceipt(current);
      const value = {
        ...normalized,
        ...(Object.hasOwn(changes, "pinned") ? { pinned: changes.pinned === true } : {}),
        ...(Object.hasOwn(changes, "exported") ? { exported: changes.exported === true } : {}),
      };
      return { value, result: value };
    }, "RECEIPT_RETENTION_UPDATE_FAILED"),
    deleteIfUnretained: (receiptId, cutoff) => update(receiptId, (current) => {
      const normalized = normalizeReceipt(current);
      if (normalized.pinned || normalized.exported || Date.parse(normalized.terminalAt) >= Date.parse(cutoff)) {
        return { value: normalized, result: false };
      }
      return { delete: true, result: true };
    }, "RECEIPT_DELETE_FAILED"),
    async close() {
      if (databasePromise) (await databasePromise).close();
      databasePromise = null;
    },
  });
}

function normalizeReceipt(raw) {
  if (!isRecord(raw)) throw new LocalStoreError("INVALID_RECEIPT");
  const receiptId = typeof raw.receiptId === "string" ? raw.receiptId.trim().slice(0, 160) : "";
  if (!receiptId) throw new LocalStoreError("RECEIPT_ID_REQUIRED");
  const createdAt = exactIso(raw.createdAt, "created_at");
  const terminalAt = raw.terminalAt === null || raw.terminalAt === undefined
    ? createdAt
    : exactIso(raw.terminalAt, "terminal_at");
  return deepFreeze(cloneJson({
    ...raw,
    receiptId,
    createdAt,
    terminalAt,
    pinned: raw.pinned === true,
    exported: raw.exported === true,
  }));
}

/**
 * Durable local authority state plus IndexedDB receipt history. Adapter errors
 * return or throw fail-closed results; they never silently enable execution.
 */
export class LocalAuthorityStore {
  #keyValue;
  #receipts;
  #clock;
  #stateKey;
  #mutationTail = Promise.resolve();

  constructor({ keyValueStore, receiptStore, clock = () => Date.now(), stateKey = LOCAL_STATE_KEY } = {}) {
    if (!keyValueStore || typeof keyValueStore.get !== "function" || typeof keyValueStore.set !== "function") {
      throw new LocalStoreError("KEY_VALUE_STORE_REQUIRED");
    }
    if (!receiptStore || typeof receiptStore.put !== "function" || typeof receiptStore.get !== "function"
      || typeof receiptStore.getAll !== "function" || typeof receiptStore.delete !== "function"
      || typeof receiptStore.updateRetention !== "function" || typeof receiptStore.deleteIfUnretained !== "function") {
      throw new LocalStoreError("RECEIPT_STORE_REQUIRED");
    }
    if (typeof clock !== "function") throw new LocalStoreError("CLOCK_REQUIRED");
    this.#keyValue = keyValueStore;
    this.#receipts = receiptStore;
    this.#clock = clock;
    this.#stateKey = stateKey;
  }

  static defaultState() {
    return deepFreeze(failClosedState());
  }

  async loadState() {
    try {
      const stored = await this.#keyValue.get(this.#stateKey);
      if (stored === undefined || stored === null) {
        return deepFreeze({ ok: true, state: failClosedState(), error: null });
      }
      return deepFreeze({ ok: true, state: normalizeState(stored), error: null });
    } catch (error) {
      return deepFreeze({
        ok: false,
        state: failClosedState(),
        error: error instanceof LocalStoreError ? error.code : "LOCAL_STATE_READ_FAILED",
      });
    }
  }

  #enqueueMutation(operation) {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.catch(() => {});
    return result;
  }

  async #writeState(state) {
    try {
      await this.#keyValue.set(this.#stateKey, state);
      return state;
    } catch (error) {
      throw new LocalStoreError("LOCAL_STATE_WRITE_FAILED", error);
    }
  }

  async saveState(state, { expectedRevision = state?.stateRevision } = {}) {
    const proposed = normalizeState(state);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new LocalStoreError("EXPECTED_REVISION_REQUIRED");
    return this.#enqueueMutation(async () => {
      const loaded = await this.loadState();
      if (!loaded.ok) throw new LocalStoreError("LOCAL_STATE_UNAVAILABLE");
      if (loaded.state.stateRevision !== expectedRevision) throw new LocalStoreError("STALE_STATE_REVISION");
      const next = normalizeState({ ...proposed, stateRevision: expectedRevision + 1 });
      return this.#writeState(next);
    });
  }

  async mutateState(mutator, { expectedRevision = null } = {}) {
    if (typeof mutator !== "function") throw new LocalStoreError("STATE_MUTATOR_REQUIRED");
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      throw new LocalStoreError("INVALID_EXPECTED_REVISION");
    }
    return this.#enqueueMutation(async () => {
      const loaded = await this.loadState();
      if (!loaded.ok) throw new LocalStoreError("LOCAL_STATE_UNAVAILABLE");
      if (expectedRevision !== null && loaded.state.stateRevision !== expectedRevision) {
        throw new LocalStoreError("STALE_STATE_REVISION");
      }
      const draft = cloneJson(loaded.state);
      const returned = await mutator(draft);
      const candidate = returned === undefined ? draft : returned;
      const next = normalizeState({ ...candidate, stateRevision: loaded.state.stateRevision + 1 });
      return this.#writeState(next);
    });
  }

  async consumeTransactionApproval({ approvalId, actionDigest, expectedRevision } = {}) {
    if (typeof approvalId !== "string" || !approvalId || !/^[a-f0-9]{64}$/.test(actionDigest ?? "")) {
      throw new LocalStoreError("INVALID_APPROVAL_CONSUMPTION");
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new LocalStoreError("EXPECTED_REVISION_REQUIRED");
    }
    return this.mutateState((draft) => {
      const approvals = draft.policy?.transactionApprovals;
      if (!Array.isArray(approvals)) throw new LocalStoreError("APPROVAL_COLLECTION_UNAVAILABLE");
      const approval = approvals.find((entry) => entry?.id === approvalId);
      if (!approval || approval.actionDigest !== actionDigest) throw new LocalStoreError("APPROVAL_BINDING_MISMATCH");
      if (approval.consumedAt) throw new LocalStoreError("APPROVAL_ALREADY_CONSUMED");
      const consumedAt = currentMilliseconds(this.#clock);
      if (!approval.expiresAt || Date.parse(approval.expiresAt) <= consumedAt) {
        throw new LocalStoreError("APPROVAL_EXPIRED");
      }
      approval.consumedAt = new Date(consumedAt).toISOString();
    }, { expectedRevision });
  }

  async putReceipt(receipt) {
    const normalized = normalizeReceipt(receipt);
    try {
      await this.#receipts.put(normalized);
      return normalized;
    } catch (error) {
      throw new LocalStoreError("RECEIPT_WRITE_FAILED", error);
    }
  }

  async getReceipt(receiptId) {
    try {
      const receipt = await this.#receipts.get(receiptId);
      return receipt ? normalizeReceipt(receipt) : null;
    } catch (error) {
      throw new LocalStoreError("RECEIPT_READ_FAILED", error);
    }
  }

  async #allReceipts() {
    try {
      const records = await this.#receipts.getAll();
      if (!Array.isArray(records)) throw new LocalStoreError("INVALID_RECEIPT_STORE_RESULT");
      return records.map(normalizeReceipt).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    } catch (error) {
      if (error instanceof LocalStoreError) throw error;
      throw new LocalStoreError("RECEIPT_LIST_FAILED", error);
    }
  }

  async listReceipts({ limit = 500 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new LocalStoreError("INVALID_RECEIPT_LIMIT");
    return deepFreeze((await this.#allReceipts()).slice(0, limit));
  }

  async pinReceipt(receiptId, pinned = true) {
    if (typeof pinned !== "boolean") throw new LocalStoreError("INVALID_PIN_STATE");
    let receipt;
    try {
      receipt = await this.#receipts.updateRetention(receiptId, { pinned });
    } catch (error) {
      throw new LocalStoreError("RECEIPT_RETENTION_UPDATE_FAILED", error);
    }
    if (!receipt) throw new LocalStoreError("RECEIPT_NOT_FOUND");
    return normalizeReceipt(receipt);
  }

  async markReceiptExported(receiptId) {
    let receipt;
    try {
      receipt = await this.#receipts.updateRetention(receiptId, { exported: true });
    } catch (error) {
      throw new LocalStoreError("RECEIPT_RETENTION_UPDATE_FAILED", error);
    }
    if (!receipt) throw new LocalStoreError("RECEIPT_NOT_FOUND");
    return normalizeReceipt(receipt);
  }

  async pruneReceipts({ retentionDays = DEFAULT_RECEIPT_RETENTION_DAYS, now = null } = {}) {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3_650) {
      throw new LocalStoreError("INVALID_RECEIPT_RETENTION");
    }
    const currentTime = now === null ? currentMilliseconds(this.#clock) : currentMilliseconds(() => now);
    const cutoff = currentTime - retentionDays * 24 * 60 * 60 * 1_000;
    const records = await this.#allReceipts();
    const deleted = [];
    for (const receipt of records) {
      if (receipt.pinned || receipt.exported || Date.parse(receipt.terminalAt) >= cutoff) continue;
      try {
        if (!await this.#receipts.deleteIfUnretained(receipt.receiptId, new Date(cutoff).toISOString())) continue;
      } catch (error) {
        throw new LocalStoreError("RECEIPT_DELETE_FAILED", error);
      }
      deleted.push(receipt.receiptId);
    }
    return deepFreeze({ deleted, retained: records.length - deleted.length, cutoff: new Date(cutoff).toISOString() });
  }
}

/** Creates the production store from explicit browser capabilities. */
export function createBrowserAuthorityStore({
  storageArea = globalThis.chrome?.storage?.local,
  indexedDBImpl = globalThis.indexedDB,
  clock = () => Date.now(),
} = {}) {
  return new LocalAuthorityStore({
    keyValueStore: createChromeStorageAdapter(storageArea),
    receiptStore: createIndexedDbReceiptAdapter(indexedDBImpl),
    clock,
  });
}
