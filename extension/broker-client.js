import { cleanText, normalizeServiceUrl } from "./protocol.js";

export class BrokerError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.name = "BrokerError";
    this.code = code;
    this.status = status;
  }
}

function encoded(value) {
  return encodeURIComponent(String(value));
}

function normalizePoll(body) {
  const commands = Array.isArray(body?.commands) ? body.commands : [];
  const authorityRequired = Array.isArray(body?.authority_required) ? body.authority_required : [];
  return { commands, authorityRequired };
}

export class BrokerClient {
  constructor({ baseUrl, browserToken, operatorToken, fetchImpl = fetch }) {
    this.baseUrl = normalizeServiceUrl(baseUrl);
    this.browserToken = browserToken;
    this.operatorToken = operatorToken;
    this.fetchImpl = fetchImpl;
  }

  async request(path, { method = "GET", body, scope = "browser" } = {}) {
    const token = scope === "operator" ? this.operatorToken : this.browserToken;
    if (!token) throw new BrokerError(scope === "operator" ? "OPERATOR_TOKEN_REQUIRED" : "BROWSER_TOKEN_REQUIRED");
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new BrokerError(cleanText(payload?.error?.code || payload?.code || payload?.error, 128) || `BROKER_HTTP_${response.status}`, response.status);
    }
    return payload;
  }

  async controlRequest(path, pairingKey, { method = "GET", body } = {}) {
    if (!pairingKey) throw new BrokerError("PAIRING_KEY_REQUIRED");
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "X-doA2Ai-Pairing-Key": pairingKey,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new BrokerError(cleanText(payload?.error?.code || payload?.code || payload?.error, 128) || `BROKER_HTTP_${response.status}`, response.status);
    }
    return payload;
  }

  createSession({ source, authority, ttlSeconds }) {
    return this.request("/v1/browser/sessions", {
      method: "POST",
      body: {
        source,
        authority,
        ...(ttlSeconds === undefined ? {} : { ttl_seconds: ttlSeconds }),
      },
    });
  }

  publishTools(sessionId, { catalogRevision, tools, activeToolNames }) {
    return this.request(`/v1/browser/sessions/${encoded(sessionId)}/tools`, {
      method: "PUT",
      body: {
        catalog_revision: catalogRevision,
        tools,
        active_tool_names: activeToolNames,
      },
    });
  }

  async pollCommands(sessionId, { waitMs = 15_000 } = {}) {
    return normalizePoll(await this.request(
      `/v1/browser/sessions/${encoded(sessionId)}/commands?wait_ms=${encoded(waitMs)}`,
    ));
  }

  submitExecutionResult(executionId, result) {
    return this.request(`/v1/browser/executions/${encoded(executionId)}/result`, {
      method: "POST",
      body: result,
    });
  }

  getExecutionStatus(executionId) {
    return this.request(`/v1/browser/executions/${encoded(executionId)}/status`);
  }

  getDocket(docketId) {
    return this.request(`/v1/dockets/${encoded(docketId)}`, { scope: "operator" });
  }

  decideDocket(docketId, decision) {
    return this.request(`/v1/dockets/${encoded(docketId)}/decision`, {
      method: "POST",
      body: { decision },
      scope: "operator",
    });
  }

  createGrant(grant) {
    return this.request("/v1/grants", { method: "POST", body: grant, scope: "operator" });
  }

  revokeGrant(grantId) {
    return this.request(`/v1/grants/${encoded(grantId)}/revoke`, {
      method: "POST",
      body: {},
      scope: "operator",
    });
  }

  getReceipt(executionId, { scope = "operator" } = {}) {
    return this.request(`/v1/receipts/${encoded(executionId)}`, { scope });
  }

  getControlCapabilities(sessionId, pairingKey) {
    return this.controlRequest(`/v1/control/sessions/${encoded(sessionId)}/capabilities`, pairingKey);
  }

  requestControlAction(sessionId, pairingKey, { requestId, relayName, arguments: args }) {
    return this.controlRequest(`/v1/control/sessions/${encoded(sessionId)}/actions`, pairingKey, {
      method: "POST",
      body: { request_id: requestId, relay_name: relayName, arguments: args },
    });
  }

  getControlExecution(sessionId, pairingKey, executionId) {
    return this.controlRequest(
      `/v1/control/sessions/${encoded(sessionId)}/executions/${encoded(executionId)}`,
      pairingKey,
    );
  }
}
