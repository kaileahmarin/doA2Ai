export const DEVICE_IDENTITY_VERSION = "doa2ai.device-identity.v1";
export const DEVICE_REQUEST_HEADERS = Object.freeze({
  device: "X-doA2Ai-Device",
  timestamp: "X-doA2Ai-Timestamp",
  nonce: "X-doA2Ai-Nonce",
  signature: "X-doA2Ai-Signature",
});

const IDENTITY_SLOT = "primary";
const DEVICE_ID = /^[A-Za-z0-9_.:-]{8,160}$/;
const NONCE = /^[A-Za-z0-9_-]{16,160}$/;
const PAIRING_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const STATEMENT_DOMAINS = new Set([
  "doa2ai.authority-proof.v1",
  "doa2ai.receipt-signature.v1",
]);

export class DeviceIdentityError extends Error {
  constructor(code, cause = null) {
    super(code, cause ? { cause } : undefined);
    this.name = "DeviceIdentityError";
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value, maximum = 500) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}

function canonicalJson(value, state = { seen: new WeakSet(), depth: 0, nodes: 0 }) {
  state.nodes += 1;
  if (state.nodes > 20_000 || state.depth > 20) throw new DeviceIdentityError("JSON_VALUE_TOO_COMPLEX");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DeviceIdentityError("NON_FINITE_JSON_NUMBER");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new DeviceIdentityError("NON_JSON_VALUE");
  if (state.seen.has(value)) throw new DeviceIdentityError("CYCLIC_JSON_VALUE");
  state.seen.add(value);
  const next = { seen: state.seen, depth: state.depth + 1, nodes: state.nodes };
  let result;
  if (Array.isArray(value)) {
    result = `[${value.map((entry) => canonicalJson(entry, next)).join(",")}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new DeviceIdentityError("NON_PLAIN_JSON_OBJECT");
    result = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], next)}`).join(",")}}`;
  }
  state.nodes = next.nodes;
  state.seen.delete(value);
  return result;
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new DeviceIdentityError("INVALID_BASE64URL");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary;
  try {
    binary = atob(padded);
  } catch (error) {
    throw new DeviceIdentityError("INVALID_BASE64URL", error);
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function exactIso(value) {
  if (typeof value !== "string") throw new DeviceIdentityError("INVALID_TIMESTAMP");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new DeviceIdentityError("INVALID_TIMESTAMP");
  }
  return value;
}

function clockIso(clock) {
  const raw = clock();
  const milliseconds = raw instanceof Date ? raw.getTime() : typeof raw === "number" ? raw : Date.parse(raw);
  if (!Number.isFinite(milliseconds)) throw new DeviceIdentityError("INVALID_CLOCK");
  return new Date(milliseconds).toISOString();
}

function requestPath(value) {
  if (typeof value !== "string" || !value.startsWith("/v2/") || value.includes("#") || /[\r\n]/.test(value)) {
    throw new DeviceIdentityError("INVALID_REQUEST_PATH");
  }
  return value;
}

function requestMethod(value) {
  const method = cleanText(value, 16).toUpperCase();
  if (!/^[A-Z]{3,10}$/.test(method)) throw new DeviceIdentityError("INVALID_REQUEST_METHOD");
  return method;
}

function validatePublicJwk(raw) {
  if (!isRecord(raw) || raw.kty !== "EC" || raw.crv !== "P-256"
    || typeof raw.x !== "string" || typeof raw.y !== "string" || raw.d !== undefined) {
    throw new DeviceIdentityError("INVALID_PUBLIC_JWK");
  }
  return Object.freeze({
    key_ops: ["verify"],
    ext: true,
    kty: "EC",
    x: raw.x,
    y: raw.y,
    crv: "P-256",
  });
}

async function sha256Bytes(value, cryptoImpl) {
  if (!cryptoImpl?.subtle) throw new DeviceIdentityError("WEB_CRYPTO_UNAVAILABLE");
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(value);
  return new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", bytes));
}

function resolveRawBody(body, rawBody) {
  if (rawBody !== undefined && body !== undefined) throw new DeviceIdentityError("AMBIGUOUS_BODY_INPUT");
  if (rawBody !== undefined) {
    if (typeof rawBody !== "string") throw new DeviceIdentityError("INVALID_RAW_BODY");
    return rawBody;
  }
  return body === undefined ? "" : canonicalJson(body);
}

/** Returns a lower-case SHA-256 digest of the strict canonical JSON body. */
export async function canonicalBodyDigest(body, cryptoImpl = globalThis.crypto) {
  const digest = await sha256Bytes(canonicalJson(body), cryptoImpl);
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validPrivateKey(key) {
  return key?.type === "private"
    && key.extractable === false
    && key.algorithm?.name === "ECDSA"
    && key.algorithm?.namedCurve === "P-256"
    && Array.isArray(key.usages)
    && key.usages.includes("sign");
}

function validPublicKey(key) {
  return key?.type === "public"
    && key.algorithm?.name === "ECDSA"
    && key.algorithm?.namedCurve === "P-256"
    && Array.isArray(key.usages)
    && key.usages.includes("verify");
}

function clonePublicJwk(jwk) {
  return JSON.parse(JSON.stringify(validatePublicJwk(jwk)));
}

function openKeyDatabase(indexedDBImpl, { databaseName, storeName }) {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDBImpl.open(databaseName, 1);
    } catch (error) {
      reject(new DeviceIdentityError("DEVICE_KEY_DATABASE_OPEN_FAILED", error));
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: "slot" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new DeviceIdentityError("DEVICE_KEY_DATABASE_OPEN_FAILED", request.error));
    request.onblocked = () => reject(new DeviceIdentityError("DEVICE_KEY_DATABASE_BLOCKED"));
  });
}

/** IndexedDB preserves the non-exportable CryptoKey through structured cloning. */
export function createIndexedDbDeviceKeyStore(indexedDBImpl, {
  databaseName = "doa2ai-device-identity-v1",
  storeName = "identities",
} = {}) {
  if (!indexedDBImpl || typeof indexedDBImpl.open !== "function") throw new DeviceIdentityError("INDEXED_DB_UNAVAILABLE");
  let databasePromise = null;
  const database = () => {
    databasePromise ??= openKeyDatabase(indexedDBImpl, { databaseName, storeName });
    return databasePromise;
  };
  const run = async (mode, operation, code) => {
    const db = await database();
    return new Promise((resolve, reject) => {
      let transaction;
      let request;
      let result;
      try {
        transaction = db.transaction(storeName, mode);
        request = operation(transaction.objectStore(storeName));
      } catch (error) {
        reject(new DeviceIdentityError(code, error));
        return;
      }
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(new DeviceIdentityError(code, request.error));
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(new DeviceIdentityError(code, transaction.error));
      transaction.onabort = () => reject(new DeviceIdentityError(code, transaction.error));
    });
  };
  return Object.freeze({
    async get(slot = IDENTITY_SLOT) {
      const row = await run("readonly", (store) => store.get(slot), "DEVICE_KEY_READ_FAILED");
      return row?.record ?? null;
    },
    async put(slot = IDENTITY_SLOT, record) {
      await run("readwrite", (store) => store.put({ slot, record }), "DEVICE_KEY_WRITE_FAILED");
    },
    async delete(slot = IDENTITY_SLOT) {
      await run("readwrite", (store) => store.delete(slot), "DEVICE_KEY_DELETE_FAILED");
    },
    async close() {
      if (databasePromise) (await databasePromise).close();
      databasePromise = null;
    },
  });
}

/**
 * Owns one stable device key. The private key is generated non-exportable and
 * is never returned by this API; only the public JWK can leave the key store.
 */
export class DeviceIdentity {
  #keyStore;
  #crypto;
  #clock;
  #nonceFactory;
  #identityPromise = null;
  #mutationTail = Promise.resolve();

  constructor({
    keyStore,
    cryptoImpl = globalThis.crypto,
    clock = () => Date.now(),
    nonceFactory = null,
  } = {}) {
    if (!keyStore || typeof keyStore.get !== "function" || typeof keyStore.put !== "function") {
      throw new DeviceIdentityError("DEVICE_KEY_STORE_REQUIRED");
    }
    if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== "function") {
      throw new DeviceIdentityError("WEB_CRYPTO_UNAVAILABLE");
    }
    if (typeof clock !== "function") throw new DeviceIdentityError("CLOCK_REQUIRED");
    if (nonceFactory !== null && typeof nonceFactory !== "function") throw new DeviceIdentityError("INVALID_NONCE_FACTORY");
    this.#keyStore = keyStore;
    this.#crypto = cryptoImpl;
    this.#clock = clock;
    this.#nonceFactory = nonceFactory ?? (() => base64url(this.#crypto.getRandomValues(new Uint8Array(18))));
  }

  async #loadOrCreate() {
    let stored;
    try {
      stored = await this.#keyStore.get(IDENTITY_SLOT);
    } catch (error) {
      throw new DeviceIdentityError("DEVICE_KEY_READ_FAILED", error);
    }
    if (stored) {
      if (stored.version !== DEVICE_IDENTITY_VERSION || !DEVICE_ID.test(stored.deviceId)
        || !validPrivateKey(stored.privateKey) || !validPublicKey(stored.publicKey)) {
        throw new DeviceIdentityError("STORED_DEVICE_IDENTITY_INVALID");
      }
      const storedJwk = validatePublicJwk(stored.publicJwk);
      let exportedJwk;
      let pairMatches;
      try {
        exportedJwk = validatePublicJwk(await this.#crypto.subtle.exportKey("jwk", stored.publicKey));
        const probe = new TextEncoder().encode("doa2ai-device-key-integrity-v1");
        const probeSignature = await this.#crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          stored.privateKey,
          probe,
        );
        pairMatches = await this.#crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          stored.publicKey,
          probeSignature,
          probe,
        );
      } catch (error) {
        throw new DeviceIdentityError("STORED_DEVICE_IDENTITY_INVALID", error);
      }
      if (canonicalJson(exportedJwk) !== canonicalJson(storedJwk) || pairMatches !== true) {
        throw new DeviceIdentityError("STORED_DEVICE_IDENTITY_INVALID");
      }
      if (stored.pairing !== null && stored.pairing !== undefined) this.#validatePairing(stored.pairing);
      return stored;
    }
    let keyPair;
    try {
      keyPair = await this.#crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"],
      );
    } catch (error) {
      throw new DeviceIdentityError("DEVICE_KEY_GENERATION_FAILED", error);
    }
    if (!validPrivateKey(keyPair.privateKey) || !validPublicKey(keyPair.publicKey)) {
      throw new DeviceIdentityError("GENERATED_DEVICE_IDENTITY_INVALID");
    }
    const publicJwk = validatePublicJwk(await this.#crypto.subtle.exportKey("jwk", keyPair.publicKey));
    const fingerprint = base64url(await sha256Bytes(canonicalJson(publicJwk), this.#crypto)).slice(0, 32);
    const identity = {
      version: DEVICE_IDENTITY_VERSION,
      deviceId: `device:${fingerprint}`,
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      publicJwk,
      createdAt: clockIso(this.#clock),
      pairing: null,
    };
    try {
      await this.#keyStore.put(IDENTITY_SLOT, identity);
    } catch (error) {
      throw new DeviceIdentityError("DEVICE_KEY_WRITE_FAILED", error);
    }
    return identity;
  }

  async #identity() {
    this.#identityPromise ??= this.#loadOrCreate();
    try {
      return await this.#identityPromise;
    } catch (error) {
      this.#identityPromise = null;
      throw error;
    }
  }

  #validatePairing(pairing) {
    if (!isRecord(pairing)) throw new DeviceIdentityError("INVALID_PAIRING_STATE");
    let origin;
    try {
      const url = new URL(pairing.serviceOrigin);
      if (url.protocol !== "https:" || url.origin !== url.href.replace(/\/$/, "")) throw new Error("invalid origin");
      origin = url.origin;
    } catch {
      throw new DeviceIdentityError("INVALID_PAIRING_ORIGIN");
    }
    const pairedAt = exactIso(pairing.pairedAt);
    return Object.freeze({ serviceOrigin: origin, pairedAt });
  }

  async publicJwk() {
    return Object.freeze(clonePublicJwk((await this.#identity()).publicJwk));
  }

  async getDeviceId() {
    return (await this.#identity()).deviceId;
  }

  #enqueueMutation(operation) {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.catch(() => {});
    return result;
  }

  async #persistIdentity(identity) {
    try {
      await this.#keyStore.put(IDENTITY_SLOT, identity);
    } catch (error) {
      throw new DeviceIdentityError("DEVICE_KEY_WRITE_FAILED", error);
    }
    this.#identityPromise = Promise.resolve(identity);
    return identity;
  }

  async setDeviceId(deviceId) {
    const normalized = cleanText(deviceId, 160);
    if (!DEVICE_ID.test(normalized)) throw new DeviceIdentityError("INVALID_DEVICE_ID");
    return this.#enqueueMutation(async () => {
      const identity = await this.#identity();
      if (identity.pairing && identity.deviceId !== normalized) throw new DeviceIdentityError("PAIRED_DEVICE_ID_IMMUTABLE");
      await this.#persistIdentity({ ...identity, deviceId: normalized });
      return normalized;
    });
  }

  async getPairingState() {
    const pairing = (await this.#identity()).pairing;
    return pairing ? Object.freeze({ ...pairing }) : null;
  }

  async setPairingState(pairing) {
    const normalized = this.#validatePairing(pairing);
    return this.#enqueueMutation(async () => {
      const identity = await this.#identity();
      await this.#persistIdentity({ ...identity, pairing: normalized });
      return Object.freeze({ ...normalized });
    });
  }

  async clearPairingState() {
    return this.#enqueueMutation(async () => {
      const identity = await this.#identity();
      await this.#persistIdentity({ ...identity, pairing: null });
    });
  }

  /** Replaces a revoked/unrecoverable local key while preserving other local product state. */
  async rotate() {
    if (typeof this.#keyStore.delete !== "function") throw new DeviceIdentityError("DEVICE_KEY_DELETE_UNAVAILABLE");
    return this.#enqueueMutation(async () => {
      try {
        await this.#keyStore.delete(IDENTITY_SLOT);
      } catch (error) {
        throw new DeviceIdentityError("DEVICE_KEY_DELETE_FAILED", error);
      }
      this.#identityPromise = null;
      const identity = await this.#identity();
      return Object.freeze({ deviceId: identity.deviceId, publicJwk: Object.freeze(clonePublicJwk(identity.publicJwk)) });
    });
  }

  /** Atomically records the service-assigned identifier and completed pairing. */
  async completePairing({ deviceId, serviceOrigin, pairedAt } = {}) {
    const normalizedDeviceId = cleanText(deviceId, 160);
    if (!DEVICE_ID.test(normalizedDeviceId)) throw new DeviceIdentityError("INVALID_DEVICE_ID");
    const pairing = this.#validatePairing({ serviceOrigin, pairedAt });
    return this.#enqueueMutation(async () => {
      const identity = await this.#identity();
      if (identity.pairing && identity.deviceId !== normalizedDeviceId) throw new DeviceIdentityError("PAIRED_DEVICE_ID_IMMUTABLE");
      await this.#persistIdentity({ ...identity, deviceId: normalizedDeviceId, pairing });
      return Object.freeze({ deviceId: normalizedDeviceId, pairing: Object.freeze({ ...pairing }) });
    });
  }

  /** Signs the exact UTF-8 challenge string supplied by the pairing service. */
  async signChallenge(challenge) {
    // The service emits exactly 32 random bytes as unpadded base64url. This
    // grammar is deliberately disjoint from every newline-delimited request.
    if (typeof challenge !== "string" || !PAIRING_CHALLENGE.test(challenge)) {
      throw new DeviceIdentityError("INVALID_PAIRING_CHALLENGE");
    }
    const identity = await this.#identity();
    const signature = new Uint8Array(await this.#crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identity.privateKey,
      new TextEncoder().encode(challenge),
    ));
    if (signature.byteLength !== 64) throw new DeviceIdentityError("INVALID_RAW_SIGNATURE_LENGTH");
    return base64url(signature);
  }

  /** Signs an explicitly allowlisted, domain-separated local statement. */
  async signStatement({ domain, input } = {}) {
    if (!STATEMENT_DOMAINS.has(domain) || typeof input !== "string" || input.length === 0 || input.length > 262_144) {
      throw new DeviceIdentityError("INVALID_SIGNING_STATEMENT");
    }
    const identity = await this.#identity();
    const signature = new Uint8Array(await this.#crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identity.privateKey,
      new TextEncoder().encode(`${domain}\n${input}`),
    ));
    if (signature.byteLength !== 64) throw new DeviceIdentityError("INVALID_RAW_SIGNATURE_LENGTH");
    return base64url(signature);
  }

  /**
   * Signs the service's exact V2 request string. When `rawBody` is supplied the
   * caller must transmit those exact bytes; otherwise `body` is canonicalized.
   */
  async signRequest({ method = "POST", path = undefined, pathWithQuery = undefined, body = undefined, rawBody = undefined } = {}) {
    const identity = await this.#identity();
    const timestamp = clockIso(this.#clock);
    const nonce = this.#nonceFactory();
    if (typeof nonce !== "string" || !NONCE.test(nonce)) throw new DeviceIdentityError("INVALID_NONCE");
    const normalizedMethod = requestMethod(method);
    if (path !== undefined && pathWithQuery !== undefined && path !== pathWithQuery) {
      throw new DeviceIdentityError("AMBIGUOUS_REQUEST_PATH");
    }
    const normalizedPath = requestPath(pathWithQuery ?? path);
    const serializedBody = resolveRawBody(body, rawBody);
    const bodyDigestBytes = await sha256Bytes(serializedBody, this.#crypto);
    const bodyDigest = [...bodyDigestBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const signatureBase = `doa2ai.v2\n${normalizedMethod}\n${normalizedPath}\n${timestamp}\n${nonce}\n${bodyDigest}`;
    const signatureBytes = new Uint8Array(await this.#crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identity.privateKey,
      new TextEncoder().encode(signatureBase),
    ));
    if (signatureBytes.byteLength !== 64) throw new DeviceIdentityError("INVALID_RAW_SIGNATURE_LENGTH");
    const signature = base64url(signatureBytes);
    return Object.freeze({
      headers: Object.freeze({
        [DEVICE_REQUEST_HEADERS.device]: identity.deviceId,
        [DEVICE_REQUEST_HEADERS.timestamp]: timestamp,
        [DEVICE_REQUEST_HEADERS.nonce]: nonce,
        [DEVICE_REQUEST_HEADERS.signature]: signature,
      }),
      bodyDigest,
      rawBody: serializedBody,
      signatureBase,
    });
  }
}

/** Verification helper shared by tests and service-side compatible adapters. */
export async function verifyRequestSignature({
  publicJwk,
  deviceId,
  timestamp,
  nonce,
  signature,
  method = "POST",
  path = undefined,
  pathWithQuery = undefined,
  body = undefined,
  rawBody = undefined,
} = {}, cryptoImpl = globalThis.crypto) {
  try {
    const jwk = validatePublicJwk(publicJwk);
    const normalizedDeviceId = cleanText(deviceId, 160);
    if (!DEVICE_ID.test(normalizedDeviceId) || !NONCE.test(nonce)) return false;
    exactIso(timestamp);
    const normalizedMethod = requestMethod(method);
    if (path !== undefined && pathWithQuery !== undefined && path !== pathWithQuery) return false;
    const normalizedPath = requestPath(pathWithQuery ?? path);
    const serializedBody = resolveRawBody(body, rawBody);
    const digestBytes = await sha256Bytes(serializedBody, cryptoImpl);
    const bodyDigest = [...digestBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const signatureBase = `doa2ai.v2\n${normalizedMethod}\n${normalizedPath}\n${timestamp}\n${nonce}\n${bodyDigest}`;
    const publicKey = await cryptoImpl.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await cryptoImpl.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      fromBase64url(signature),
      new TextEncoder().encode(signatureBase),
    );
  } catch {
    return false;
  }
}
