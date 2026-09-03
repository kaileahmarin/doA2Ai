import { canonicalJson, normalizeServiceUrl } from "./protocol.js";
import { DEVICE_REQUEST_HEADERS } from "./device-identity.js";

export const DEFAULT_SERVICE_URL = "https://doa2ai-broker.cooing-cupcake.workers.dev";

export class AuthorityServiceError extends Error {
  constructor(code, status = 0, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "AuthorityServiceError";
    this.code = code;
    this.status = status;
  }
}

function cleanText(value, maximum = 500) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}

async function readJsonResponse(response) {
  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new AuthorityServiceError("INVALID_SERVICE_RESPONSE", response.status);
    }
  }
  if (!response.ok) {
    const code = cleanText(body?.error?.code || body?.code, 160) || `HTTP_${response.status}`;
    const detail = cleanText(body?.error?.message || body?.message, 300);
    throw new AuthorityServiceError(code, response.status, detail);
  }
  return body;
}

export class AuthorityServiceClient {
  constructor({
    baseUrl = DEFAULT_SERVICE_URL,
    deviceId = "",
    signRequest = null,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new AuthorityServiceError("INVALID_CLIENT_DEPENDENCY");
    this.baseUrl = normalizeServiceUrl(baseUrl);
    this.deviceId = cleanText(deviceId, 160);
    this.signRequest = signRequest;
    this.fetchImpl = fetchImpl;
  }

  withDevice({ deviceId, signRequest }) {
    return new AuthorityServiceClient({
      baseUrl: this.baseUrl,
      deviceId,
      signRequest,
      fetchImpl: this.fetchImpl,
    });
  }

  async request(path, { method = "GET", body, signed = false } = {}) {
    if (typeof path !== "string" || !path.startsWith("/v2/") || path.includes("#")) {
      throw new AuthorityServiceError("INVALID_SERVICE_PATH");
    }
    const upperMethod = method.toUpperCase();
    const rawBody = body === undefined ? "" : canonicalJson(body);
    const headers = new Headers({ Accept: "application/json" });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (signed) {
      if (!this.deviceId || typeof this.signRequest !== "function") throw new AuthorityServiceError("DEVICE_SIGNATURE_REQUIRED");
      const signedRequest = await this.signRequest({ method: upperMethod, pathWithQuery: path, rawBody });
      if (!signedRequest || signedRequest.rawBody !== rawBody || !signedRequest.headers) {
        throw new AuthorityServiceError("INVALID_SIGNED_REQUEST");
      }
      const signedDevice = cleanText(signedRequest.headers[DEVICE_REQUEST_HEADERS.device], 160);
      if (signedDevice !== this.deviceId) throw new AuthorityServiceError("SIGNED_DEVICE_MISMATCH");
      for (const headerName of Object.values(DEVICE_REQUEST_HEADERS)) {
        const headerValue = cleanText(signedRequest.headers[headerName], 256);
        if (!headerValue) throw new AuthorityServiceError("INVALID_SIGNED_REQUEST");
        headers.set(headerName, headerValue);
      }
    }
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: upperMethod,
        headers,
        ...(body === undefined ? {} : { body: rawBody }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new AuthorityServiceError("SERVICE_UNAVAILABLE");
    }
    return readJsonResponse(response);
  }

  readiness() {
    return this.request("/v2/status");
  }

  createDeviceChallenge(publicKeyJwk) {
    return this.request("/v2/devices/challenge", { method: "POST", body: { public_key_jwk: publicKeyJwk } });
  }

  registerDevice(challengeId, signature) {
    return this.request("/v2/devices/register", {
      method: "POST",
      body: { challenge_id: challengeId, signature },
    });
  }

  deviceStatus() {
    return this.request(`/v2/devices/${encodeURIComponent(this.deviceId)}/status`, { signed: true });
  }

  revokeDevice() {
    return this.request(`/v2/devices/${encodeURIComponent(this.deviceId)}/revoke`, { method: "POST", body: {}, signed: true });
  }

  createConnection({ taskId, ttlSeconds } = {}) {
    return this.request("/v2/connections", {
      method: "POST",
      body: {
        ...(taskId ? { task_id: taskId } : {}),
        ...(ttlSeconds ? { ttl_seconds: ttlSeconds } : {}),
      },
      signed: true,
    });
  }

  revokeConnection(connectionId) {
    return this.request(`/v2/connections/${encodeURIComponent(connectionId)}/revoke`, { method: "POST", body: {}, signed: true });
  }

  bindReceipt({ actionId, taskId, receiptDigest }) {
    return this.request("/v2/receipts/bind", {
      method: "POST",
      body: { action_id: actionId, task_id: taskId, receipt_digest: receiptDigest },
      signed: true,
    });
  }
}
