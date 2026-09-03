const CONTRACT_REVISION = "doa2ai.v1";
const RECEIPT_REVISION = "doa2ai.receipt.v1";
const V2_CONTRACT_REVISION = "doa2ai.v2";
const MCP_PROTOCOL_VERSION = "2025-11-25";
const MAX_BODY_BYTES = 262_144;
const MAX_TOOLS = 64;
const DEVICE_CHALLENGE_TTL_SECONDS = 300;
const DEVICE_REQUEST_FRESHNESS_MS = 300_000;

const V1_ROUTE_MANIFEST = Object.freeze([
  "POST /mcp",
  "GET /healthz",
  "POST /v1/browser/sessions",
  "PUT /v1/browser/sessions/:session_id/tools",
  "GET /v1/browser/sessions/:session_id/commands",
  "POST /v1/browser/executions/:execution_id/result",
  "GET /v1/browser/executions/:execution_id/status",
  "POST /v1/grants",
  "POST /v1/grants/:grant_id/revoke",
  "GET /v1/dockets/:docket_id",
  "POST /v1/dockets/:docket_id/decision",
  "GET /v1/receipts/:execution_id",
  "GET /v1/control/sessions/:session_id/capabilities",
  "POST /v1/control/sessions/:session_id/actions",
  "GET /v1/control/sessions/:session_id/executions/:execution_id",
]);

const V2_ROUTE_MANIFEST = Object.freeze([
  "GET /v2/status",
  "POST /v2/devices/challenge",
  "POST /v2/devices/register",
  "GET /v2/devices/:device_id/status",
  "POST /v2/devices/:device_id/revoke",
  "POST /v2/receipts/bind",
  "POST /v2/connections",
  "POST /v2/connections/:connection_id/revoke",
]);

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const fail = (status, code, message, details) => {
  throw new HttpError(status, code, message, details);
};

const nowIso = () => new Date().toISOString();
const addSeconds = (iso, seconds) => new Date(Date.parse(iso) + seconds * 1000).toISOString();
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function base64UrlDecode(value, label = "value") {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    fail(400, "INVALID_BASE64URL", `${label} must be unpadded base64url.`);
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    fail(400, "INVALID_BASE64URL", `${label} must be unpadded base64url.`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64UrlEncode(bytes) !== value) fail(400, "INVALID_BASE64URL", `${label} is not canonical base64url.`);
  return bytes;
}

function validateP256PublicJwk(value) {
  exactObject(value, ["kty", "crv", "x", "y", "alg", "ext", "key_ops"], ["kty", "crv", "x", "y"], "public_jwk");
  if (value.kty !== "EC" || value.crv !== "P-256") fail(400, "INVALID_PUBLIC_KEY", "public_jwk must be an EC P-256 public key.");
  if (Object.hasOwn(value, "alg") && value.alg !== "ES256") fail(400, "INVALID_PUBLIC_KEY", "public_jwk.alg must be ES256 when present.");
  if (Object.hasOwn(value, "ext") && value.ext !== true) fail(400, "INVALID_PUBLIC_KEY", "public_jwk.ext must be true when present.");
  if (Object.hasOwn(value, "key_ops")) {
    if (!Array.isArray(value.key_ops) || value.key_ops.some((operation) => operation !== "verify") || new Set(value.key_ops).size !== value.key_ops.length) {
      fail(400, "INVALID_PUBLIC_KEY", "public_jwk.key_ops may contain only verify.");
    }
  }
  const x = base64UrlDecode(value.x, "public_jwk.x");
  const y = base64UrlDecode(value.y, "public_jwk.y");
  if (x.length !== 32 || y.length !== 32) fail(400, "INVALID_PUBLIC_KEY", "public_jwk coordinates must each be 32 bytes.");
  return {
    kty: "EC",
    crv: "P-256",
    x: value.x,
    y: value.y,
    alg: "ES256",
    ext: true,
    key_ops: ["verify"],
  };
}

async function importP256PublicKey(publicJwk) {
  const normalized = validateP256PublicJwk(publicJwk);
  try {
    return await crypto.subtle.importKey("jwk", normalized, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    fail(400, "INVALID_PUBLIC_KEY", "public_jwk is not a valid P-256 point.");
  }
}

async function p256JwkThumbprint(publicJwk) {
  const normalized = validateP256PublicJwk(publicJwk);
  return sha256({ crv: normalized.crv, kty: normalized.kty, x: normalized.x, y: normalized.y });
}

function deviceChallengeSigningInput(challenge) {
  return challenge;
}

function canonicalDeviceRequest(method, pathWithQuery, timestamp, nonce, bodyDigest) {
  return `doa2ai.v2\n${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${bodyDigest}`;
}

function validateSignedRequestMetadata({ method, pathWithQuery, timestamp, nonce, bodyDigest }, now = Date.now()) {
  if (typeof method !== "string" || !/^[A-Z]+$/u.test(method)) fail(400, "INVALID_SIGNATURE_INPUT", "Signed request method must be uppercase.");
  if (typeof pathWithQuery !== "string" || !pathWithQuery.startsWith("/v2/") || pathWithQuery.includes("#") || /[\r\n]/u.test(pathWithQuery)) {
    fail(400, "INVALID_SIGNATURE_INPUT", "Signed request audience must be one exact V2 path and query.");
  }
  const parsedTimestamp = Date.parse(timestamp);
  if (typeof timestamp !== "string" || !Number.isFinite(parsedTimestamp) || new Date(parsedTimestamp).toISOString() !== timestamp) {
    fail(400, "INVALID_SIGNATURE_TIMESTAMP", "X-doA2Ai-Timestamp must be a canonical ISO-8601 timestamp.");
  }
  if (Math.abs(now - parsedTimestamp) > DEVICE_REQUEST_FRESHNESS_MS) fail(401, "STALE_SIGNATURE", "Signed request timestamp is outside the five-minute freshness window.");
  if (typeof nonce !== "string" || nonce.length < 16 || nonce.length > 128 || !/^[A-Za-z0-9._~-]+$/u.test(nonce)) {
    fail(400, "INVALID_SIGNATURE_NONCE", "X-doA2Ai-Nonce is invalid.");
  }
  if (typeof bodyDigest !== "string" || !/^[a-f0-9]{64}$/u.test(bodyDigest)) fail(400, "INVALID_SIGNATURE_INPUT", "Signed request body digest is invalid.");
  return { method, pathWithQuery, timestamp, nonce, bodyDigest };
}

async function verifyP256Signature(publicJwk, signature, input) {
  let signatureBytes;
  try {
    signatureBytes = base64UrlDecode(signature, "signature");
  } catch (error) {
    if (error instanceof HttpError) return false;
    throw error;
  }
  if (signatureBytes.length !== 64) return false;
  const key = await importP256PublicKey(publicJwk);
  try {
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signatureBytes, new TextEncoder().encode(input));
  } catch {
    return false;
  }
}

async function verifySignedDeviceEnvelope({
  method,
  pathWithQuery,
  timestamp,
  nonce,
  signature,
  rawBody,
  publicJwk,
  now = Date.now(),
  claimNonce = async () => true,
}) {
  const bodyDigest = await sha256(rawBody);
  const metadata = validateSignedRequestMetadata({ method, pathWithQuery, timestamp, nonce, bodyDigest }, now);
  const signingInput = canonicalDeviceRequest(method, pathWithQuery, timestamp, nonce, bodyDigest);
  if (!await verifyP256Signature(publicJwk, signature, signingInput)) fail(401, "INVALID_DEVICE_SIGNATURE", "Device request signature is invalid for this endpoint and body.");
  if (!await claimNonce({ nonce, timestamp, pathWithQuery })) fail(409, "DEVICE_REPLAY", "This signed request nonce has already been used.");
  return { ...metadata, signingInput };
}

async function hashConnectionToken(token) {
  return sha256(token);
}

async function connectionTokenMatches(row, suppliedToken, { deviceId, taskId, now = Date.now() }) {
  const expiresAt = row ? Date.parse(row.expires_at) : Number.NaN;
  if (typeof suppliedToken !== "string" || !row || row.device_id !== deviceId || row.task_id !== taskId || row.revoked_at || !Number.isFinite(expiresAt) || expiresAt <= now) return false;
  return secureEqual(await hashConnectionToken(suppliedToken), row.token_hash);
}

function randomToken(prefix) {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function randomBase64Url(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function exactObject(value, allowed, required, label) {
  if (!isRecord(value)) fail(400, "INVALID_BODY", `${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(400, "UNKNOWN_FIELD", `${label}.${key} is not allowed.`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(400, "MISSING_FIELD", `${label}.${key} is required.`);
  }
  return value;
}

function text(value, label, { min = 1, max = 2048, pattern } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max || (pattern && !pattern.test(value))) {
    fail(400, "INVALID_FIELD", `${label} is invalid.`);
  }
  return value;
}

function integer(value, label, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(400, "INVALID_FIELD", `${label} must be an integer in range.`);
  return value;
}

function isoFuture(value, label) {
  text(value, label, { max: 64 });
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value || milliseconds <= Date.now()) {
    fail(400, "INVALID_FIELD", `${label} must be a future ISO-8601 timestamp.`);
  }
  return value;
}

function sourceEnvelope(value, label = "source") {
  exactObject(value, ["origin", "url"], ["origin", "url"], label);
  const origin = text(value.origin, `${label}.origin`, { max: 2048 });
  const urlText = text(value.url, `${label}.url`, { max: 8192 });
  let parsed;
  try {
    parsed = new URL(urlText);
  } catch {
    fail(400, "INVALID_SOURCE", `${label}.url must be an absolute HTTPS URL.`);
  }
  if (parsed.protocol !== "https:" || parsed.origin !== origin) {
    fail(400, "INVALID_SOURCE", `${label} must bind one matching HTTPS origin and URL.`);
  }
  return { origin, url: parsed.href };
}

async function readRawBody(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) fail(413, "BODY_TOO_LARGE", "Request body is too large.");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) fail(413, "BODY_TOO_LARGE", "Request body is too large.");
  return raw;
}

function parseJson(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    fail(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}

async function readJson(request) {
  return parseJson(await readRawBody(request));
}

function envInteger(env, name, fallback, min, max) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name} binding.`);
  return value;
}

function configuredOrigins(env) {
  return new Set(String(env.ALLOWED_EXTENSION_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean));
}

function requireRestOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (origin && !configuredOrigins(env).has(origin)) fail(403, "ORIGIN_NOT_ALLOWED", "Request origin is not allowed.");
}

function requireControlOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (!origin || !configuredOrigins(env).has(origin)) fail(403, "ORIGIN_NOT_ALLOWED", "The exact extension origin is required.");
}

function secureEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  let difference = left.length ^ right.length;
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) difference |= (left.charCodeAt(index % Math.max(1, left.length)) || 0) ^ (right.charCodeAt(index % Math.max(1, right.length)) || 0);
  return difference === 0;
}

function requireBearer(request, expected, role) {
  if (!expected) throw new Error(`Missing ${role} token binding.`);
  const header = request.headers.get("authorization") || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!secureEqual(supplied, String(expected))) fail(401, "UNAUTHORIZED", `${role} authentication is required.`);
}

function responseHeaders(request, env) {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  const origin = request.headers.get("origin");
  if (origin && configuredOrigins(env).has(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }
  return headers;
}

function jsonResponse(request, env, value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: responseHeaders(request, env) });
}

function noContent(request, env, status = 204) {
  const headers = responseHeaders(request, env);
  headers.delete("content-type");
  return new Response(null, { status, headers });
}

function preflight(request, env) {
  requireRestOrigin(request, env);
  const origin = request.headers.get("origin");
  if (!origin) fail(403, "ORIGIN_REQUIRED", "CORS preflight requires an origin.");
  const requested = (request.headers.get("access-control-request-headers") || "").toLowerCase().split(",").map((value) => value.trim()).filter(Boolean);
  const allowedHeaders = [
    "authorization", "content-type", "x-doa2ai-pairing-key", "x-doa2ai-device",
    "x-doa2ai-timestamp", "x-doa2ai-nonce", "x-doa2ai-signature",
  ];
  if (requested.some((header) => !allowedHeaders.includes(header))) fail(403, "HEADER_NOT_ALLOWED", "CORS request header is not allowed.");
  const headers = responseHeaders(request, env);
  headers.set("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
  headers.set("access-control-allow-headers", "Authorization, Content-Type, X-doA2Ai-Pairing-Key, X-doA2Ai-Device, X-doA2Ai-Timestamp, X-doA2Ai-Nonce, X-doA2Ai-Signature");
  headers.set("access-control-max-age", "600");
  headers.delete("content-type");
  return new Response(null, { status: 204, headers });
}

const SCHEMA_KEYS = new Set([
  "type", "title", "description", "properties", "required", "additionalProperties", "items",
  "enum", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "minLength", "maxLength", "minItems", "maxItems",
]);

function validateSchemaDefinition(schema, label = "schema", depth = 0) {
  if (depth > 12 || !isRecord(schema)) fail(400, "UNSUPPORTED_SCHEMA", `${label} is not a supported closed schema.`);
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYS.has(key)) fail(400, "UNSUPPORTED_SCHEMA", `${label}.${key} is not supported.`);
  if (typeof schema.type !== "string" || !["object", "array", "string", "number", "integer", "boolean", "null"].includes(schema.type)) {
    fail(400, "UNSUPPORTED_SCHEMA", `${label}.type must name one supported JSON type.`);
  }
  if (Object.hasOwn(schema, "enum") && (!Array.isArray(schema.enum) || schema.enum.length === 0)) fail(400, "UNSUPPORTED_SCHEMA", `${label}.enum must be non-empty.`);
  if (schema.type === "object") {
    if (schema.additionalProperties !== false || !isRecord(schema.properties || {})) {
      fail(400, "OPEN_SCHEMA", `${label} must define properties and additionalProperties: false.`);
    }
    const required = schema.required ?? [];
    if (!Array.isArray(required) || required.some((key) => typeof key !== "string" || !Object.hasOwn(schema.properties, key))) {
      fail(400, "UNSUPPORTED_SCHEMA", `${label}.required is invalid.`);
    }
    for (const [key, child] of Object.entries(schema.properties)) validateSchemaDefinition(child, `${label}.properties.${key}`, depth + 1);
  } else if (Object.hasOwn(schema, "properties") || Object.hasOwn(schema, "required") || Object.hasOwn(schema, "additionalProperties")) {
    fail(400, "UNSUPPORTED_SCHEMA", `${label} has object-only keywords.`);
  }
  if (schema.type === "array") {
    if (!Object.hasOwn(schema, "items")) fail(400, "UNSUPPORTED_SCHEMA", `${label}.items is required.`);
    validateSchemaDefinition(schema.items, `${label}.items`, depth + 1);
  } else if (Object.hasOwn(schema, "items")) {
    fail(400, "UNSUPPORTED_SCHEMA", `${label}.items is only valid for arrays.`);
  }
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function validateValue(value, schema, label = "value") {
  const validType = schema.type === "null" ? value === null
    : schema.type === "object" ? isRecord(value)
      : schema.type === "array" ? Array.isArray(value)
        : schema.type === "integer" ? Number.isSafeInteger(value)
          : schema.type === "number" ? typeof value === "number" && Number.isFinite(value)
            : typeof value === schema.type;
  if (!validType) fail(400, "SCHEMA_MISMATCH", `${label} does not match type ${schema.type}.`);
  if (Object.hasOwn(schema, "const") && !sameJson(value, schema.const)) fail(400, "SCHEMA_MISMATCH", `${label} does not match const.`);
  if (schema.enum && !schema.enum.some((candidate) => sameJson(value, candidate))) fail(400, "SCHEMA_MISMATCH", `${label} is not in enum.`);
  if (schema.type === "object") {
    for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) fail(400, "SCHEMA_MISMATCH", `${label}.${key} is not allowed.`);
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail(400, "SCHEMA_MISMATCH", `${label}.${key} is required.`);
    for (const [key, child] of Object.entries(value)) validateValue(child, schema.properties[key], `${label}.${key}`);
  }
  if (schema.type === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(400, "SCHEMA_MISMATCH", `${label} has too few items.`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(400, "SCHEMA_MISMATCH", `${label} has too many items.`);
    value.forEach((child, index) => validateValue(child, schema.items, `${label}[${index}]`));
  }
  if (schema.type === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(400, "SCHEMA_MISMATCH", `${label} is too short.`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(400, "SCHEMA_MISMATCH", `${label} is too long.`);
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (schema.minimum !== undefined && value < schema.minimum) fail(400, "SCHEMA_MISMATCH", `${label} is below minimum.`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(400, "SCHEMA_MISMATCH", `${label} is above maximum.`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) fail(400, "SCHEMA_MISMATCH", `${label} is below exclusive minimum.`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) fail(400, "SCHEMA_MISMATCH", `${label} is above exclusive maximum.`);
  }
  return value;
}

function getPath(value, path) {
  let current = value;
  for (const segment of path.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return { found: false };
    current = current[segment];
  }
  return { found: true, value: current };
}

function validateConstraintsDefinition(value) {
  exactObject(value, ["exact_args", "argument_schema", "numeric_bounds"], [], "constraints");
  if (!Object.hasOwn(value, "exact_args") && !Object.hasOwn(value, "argument_schema")) {
    fail(400, "INVALID_CONSTRAINTS", "constraints requires exact_args or argument_schema.");
  }
  if (Object.hasOwn(value, "exact_args") && !isRecord(value.exact_args)) fail(400, "INVALID_CONSTRAINTS", "constraints.exact_args must be an object.");
  if (Object.hasOwn(value, "argument_schema")) validateSchemaDefinition(value.argument_schema, "constraints.argument_schema");
  const bounds = value.numeric_bounds ?? [];
  if (!Array.isArray(bounds) || bounds.length > 32) fail(400, "INVALID_CONSTRAINTS", "constraints.numeric_bounds is invalid.");
  bounds.forEach((bound, index) => {
    exactObject(bound, ["path", "minimum", "maximum", "max_abs"], ["path"], `constraints.numeric_bounds[${index}]`);
    text(bound.path, `constraints.numeric_bounds[${index}].path`, { max: 256, pattern: /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/ });
    for (const key of ["minimum", "maximum", "max_abs"]) {
      if (Object.hasOwn(bound, key) && (typeof bound[key] !== "number" || !Number.isFinite(bound[key]))) fail(400, "INVALID_CONSTRAINTS", `${key} must be finite.`);
    }
    if (bound.max_abs !== undefined && bound.max_abs < 0) fail(400, "INVALID_CONSTRAINTS", "max_abs cannot be negative.");
    if (bound.minimum !== undefined && bound.maximum !== undefined && bound.minimum > bound.maximum) fail(400, "INVALID_CONSTRAINTS", "minimum cannot exceed maximum.");
  });
  return value;
}

function argumentsWithinConstraints(args, constraints) {
  try {
    if (Object.hasOwn(constraints, "exact_args") && !sameJson(args, constraints.exact_args)) return false;
    if (Object.hasOwn(constraints, "argument_schema")) validateValue(args, constraints.argument_schema, "arguments");
    for (const bound of constraints.numeric_bounds || []) {
      const located = getPath(args, bound.path);
      if (!located.found || typeof located.value !== "number" || !Number.isFinite(located.value)) return false;
      if (bound.minimum !== undefined && located.value < bound.minimum) return false;
      if (bound.maximum !== undefined && located.value > bound.maximum) return false;
      if (bound.max_abs !== undefined && Math.abs(located.value) > bound.max_abs) return false;
    }
    return true;
  } catch (error) {
    if (error instanceof HttpError) return false;
    throw error;
  }
}

function parseStored(value) {
  return value === null || value === undefined ? null : JSON.parse(value);
}

function changes(result) {
  return Number(result?.meta?.changes ?? 0);
}

function terminal(status) {
  return ["completed", "failed", "unknown", "denied", "blocked_authority", "blocked_session_expired"].includes(status);
}

async function loadBrowserSession(env, sessionId) {
  const row = await env.DB.prepare("SELECT * FROM browser_sessions WHERE session_id = ?").bind(sessionId).first();
  if (!row) fail(404, "SESSION_NOT_FOUND", "Browser session was not found.");
  return row;
}

async function loadMcpSession(env, opaqueKey) {
  text(opaqueKey, "session", { max: 160, pattern: /^mcp_[a-f0-9]{48}$/ });
  const row = await env.DB.prepare("SELECT * FROM browser_sessions WHERE mcp_session_key = ?").bind(opaqueKey).first();
  if (!row) fail(404, "SESSION_NOT_FOUND", "MCP session was not found.");
  if (Date.parse(row.expires_at) <= Date.now()) fail(410, "SESSION_EXPIRED", "MCP session has expired.");
  return row;
}

async function requireControlSession(request, env, sessionId) {
  requireControlOrigin(request, env);
  const session = await loadBrowserSession(env, sessionId);
  const supplied = request.headers.get("x-doa2ai-pairing-key") || "";
  if (!supplied) fail(401, "PAIRING_REQUIRED", "A control-page pairing key is required.");
  const suppliedHash = await sha256(supplied);
  if (!secureEqual(suppliedHash, session.control_key_hash)) fail(401, "PAIRING_INVALID", "The control-page pairing key is invalid.");
  if (Date.parse(session.expires_at) <= Date.now()) fail(410, "SESSION_EXPIRED", "Browser session has expired.");
  return session;
}

async function appendEvent(env, executionId, eventKey, eventType, evidence, createdAt = nowIso()) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO receipt_events (execution_id, event_key, event_type, evidence_json, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(executionId, eventKey, eventType, canonicalJson(evidence), createdAt).run();
}

function receiptPreimage(row) {
  return {
    receipt_revision: RECEIPT_REVISION,
    execution_id: row.execution_id,
    action: {
      source_origin: row.source_origin,
      source_url: row.source_url,
      tool_name: row.tool_name,
      tool_digest: row.tool_digest || null,
      catalog_revision: row.catalog_revision || null,
      action_digest: row.action_digest,
    },
    authority: {
      mode: row.authority_mode,
      review_profile: row.review_profile,
      state: row.authority_state,
      grant_id: row.grant_id || null,
      docket_id: row.docket_id || null,
    },
    execution: {
      status: row.status,
      outcome: row.outcome || null,
      result_status: row.result_status || null,
      result_digest: row.result_digest || null,
      result_verification: row.result_verification || null,
    },
    timestamps: {
      created_at: row.created_at,
      authorized_at: row.authorized_at || null,
      dispatched_at: row.dispatched_at || null,
      completed_at: row.completed_at || null,
    },
    trust: {
      broker_record: "d1_persisted",
      page_result: row.result_verification || "not_received",
      independent_target_attestation: "not_provided",
    },
  };
}

async function publicReceipt(env, row) {
  const preimage = receiptPreimage(row);
  const digest = row.receipt_digest || await sha256(preimage);
  const events = await env.DB.prepare(
    "SELECT event_type, evidence_json, created_at FROM receipt_events WHERE execution_id = ? ORDER BY event_id",
  ).bind(row.execution_id).all();
  return {
    ...preimage,
    receipt_digest: digest,
    lineage: (events.results || []).map((event) => ({
      type: event.event_type,
      evidence: parseStored(event.evidence_json),
      at: event.created_at,
    })),
  };
}

async function refreshAmbiguity(env, row) {
  if (row.status === "dispatched" && row.result_deadline_at && Date.parse(row.result_deadline_at) <= Date.now()) {
    const completedAt = nowIso();
    const projected = {
      ...row,
      status: "unknown",
      authority_state: "consumed",
      result_status: "unknown",
      result_verification: "no_bound_result_before_deadline",
      outcome: "unknown",
      completed_at: completedAt,
    };
    const digest = await sha256(receiptPreimage(projected));
    const result = await env.DB.prepare(
      `UPDATE executions SET status = 'unknown', authority_state = 'consumed', result_status = 'unknown',
       result_verification = 'no_bound_result_before_deadline', outcome = 'unknown', receipt_digest = ?, completed_at = ?
       WHERE execution_id = ? AND status = 'dispatched'`,
    ).bind(digest, completedAt, row.execution_id).run();
    if (changes(result) === 1) {
      await appendEvent(env, row.execution_id, "terminal", "outcome_unknown", {
        action_digest: row.action_digest,
        reason: "no_bound_result_before_deadline",
      }, completedAt);
    }
    row = await env.DB.prepare("SELECT * FROM executions WHERE execution_id = ?").bind(row.execution_id).first();
  }
  return row;
}

async function executionView(env, row, includeResult = true) {
  if (row.status === "queued") {
    const session = await loadBrowserSession(env, row.session_id);
    await expireQueuedSession(env, session);
    row = await env.DB.prepare("SELECT * FROM executions WHERE execution_id = ?").bind(row.execution_id).first();
  }
  row = await refreshAmbiguity(env, row);
  const view = {
    contract_revision: CONTRACT_REVISION,
    execution_id: row.execution_id,
    status: row.status,
    action_digest: row.action_digest,
    authority: {
      mode: row.authority_mode,
      review_profile: row.review_profile,
      state: row.authority_state,
      grant_id: row.grant_id || null,
      docket_id: row.docket_id || null,
    },
    result_deadline_at: row.result_deadline_at || null,
  };
  if (includeResult && row.result_json && ["completed", "failed"].includes(row.status)) view.result = parseStored(row.result_json);
  if (terminal(row.status)) view.receipt = await publicReceipt(env, row);
  return view;
}

async function handleCreateSession(request, env) {
  requireBearer(request, env.BROWSER_BEARER_TOKEN, "Browser");
  const body = await readJson(request);
  exactObject(body, ["source", "authority", "ttl_seconds"], ["source", "authority"], "body");
  const source = sourceEnvelope(body.source);
  exactObject(body.authority, ["mode", "profile"], ["mode", "profile"], "authority");
  if (!["transaction_authorized", "delegated_authority"].includes(body.authority.mode)) fail(400, "INVALID_AUTHORITY_MODE", "Unknown authority mode.");
  if (!["ask_on_exception", "autonomous_within_bounds"].includes(body.authority.profile)) fail(400, "INVALID_REVIEW_PROFILE", "Unknown review profile.");
  const configuredTtl = envInteger(env, "SESSION_TTL_SECONDS", 3600, 60, 86_400);
  const ttl = body.ttl_seconds === undefined ? configuredTtl : integer(body.ttl_seconds, "ttl_seconds", { min: 60, max: configuredTtl });
  const createdAt = nowIso();
  const sessionId = randomToken("bs");
  const mcpSessionKey = randomToken("mcp");
  const controlPairingKey = randomToken("pair");
  const controlHash = await sha256(controlPairingKey);
  const expiresAt = addSeconds(createdAt, ttl);
  await env.DB.prepare(
    `INSERT INTO browser_sessions
     (session_id, mcp_session_key, control_key_hash, source_origin, source_url, authority_mode, review_profile, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(sessionId, mcpSessionKey, controlHash, source.origin, source.url, body.authority.mode, body.authority.profile, createdAt, expiresAt, createdAt).run();
  const base = new URL(request.url).origin;
  return jsonResponse(request, env, {
    contract_revision: CONTRACT_REVISION,
    session_id: sessionId,
    expires_at: expiresAt,
    mcp: { endpoint: `${base}/mcp?session=${encodeURIComponent(mcpSessionKey)}` },
    control_page: { url: `${base}/`, pairing_key: controlPairingKey },
  }, 201);
}

async function handlePublishTools(request, env, sessionId) {
  requireBearer(request, env.BROWSER_BEARER_TOKEN, "Browser");
  const session = await loadBrowserSession(env, sessionId);
  if (Date.parse(session.expires_at) <= Date.now()) fail(410, "SESSION_EXPIRED", "Browser session has expired.");
  const body = await readJson(request);
  exactObject(body, ["catalog_revision", "tools", "active_tool_names"], ["catalog_revision", "tools", "active_tool_names"], "body");
  const revision = text(body.catalog_revision, "catalog_revision", { max: 160 });
  if (!Array.isArray(body.tools) || body.tools.length > MAX_TOOLS) fail(400, "INVALID_TOOL_CATALOG", `tools must contain at most ${MAX_TOOLS} entries.`);
  if (!Array.isArray(body.active_tool_names) || body.active_tool_names.some((name) => typeof name !== "string")) fail(400, "INVALID_TOOL_CATALOG", "active_tool_names must be a string array.");
  const active = new Set(body.active_tool_names);
  if (active.size !== body.active_tool_names.length) fail(400, "INVALID_TOOL_CATALOG", "active_tool_names contains duplicates.");
  const names = new Set();
  const relayNames = new Set();
  const records = [];
  for (let index = 0; index < body.tools.length; index += 1) {
    const entry = body.tools[index];
    exactObject(entry, ["name", "description", "input_schema", "output_schema", "annotations"], ["name", "description", "input_schema"], `tools[${index}]`);
    const name = text(entry.name, `tools[${index}].name`, { max: 128 });
    const description = text(entry.description, `tools[${index}].description`, { min: 0, max: 4096 });
    if (names.has(name)) fail(400, "INVALID_TOOL_CATALOG", "Tool names must be unique.");
    names.add(name);
    validateSchemaDefinition(entry.input_schema, `tools[${index}].input_schema`);
    if (entry.input_schema.type !== "object") fail(400, "OPEN_SCHEMA", "Every tool input schema must be a closed object schema.");
    if (Object.hasOwn(entry, "output_schema")) validateSchemaDefinition(entry.output_schema, `tools[${index}].output_schema`);
    if (Object.hasOwn(entry, "annotations") && !isRecord(entry.annotations)) fail(400, "INVALID_TOOL_CATALOG", "annotations must be an object.");
    const nameHash = await sha256(name);
    const slug = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 36) || "tool";
    const relayName = `page_${slug}_${nameHash.slice(0, 10)}`;
    if (relayNames.has(relayName)) fail(400, "INVALID_TOOL_CATALOG", "Relay name collision.");
    relayNames.add(relayName);
    const digest = await sha256({ name, description, input_schema: entry.input_schema, output_schema: entry.output_schema ?? null, annotations: entry.annotations ?? null });
    records.push({ name, relayName, description, inputSchema: entry.input_schema, outputSchema: entry.output_schema ?? null, annotations: entry.annotations ?? null, digest });
  }
  for (const name of active) if (!names.has(name)) fail(400, "INVALID_TOOL_CATALOG", `Active tool ${name} is missing from tools.`);
  const catalogDigest = await sha256({ revision, tools: records.map((record) => ({ name: record.name, digest: record.digest, active: active.has(record.name) })) });
  const statements = [env.DB.prepare("DELETE FROM session_tools WHERE session_id = ?").bind(sessionId)];
  for (const record of records) {
    statements.push(env.DB.prepare(
      `INSERT INTO session_tools
       (session_id, tool_name, relay_name, description, input_schema_json, output_schema_json, annotations_json, active, catalog_revision, tool_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(sessionId, record.name, record.relayName, record.description, canonicalJson(record.inputSchema), record.outputSchema ? canonicalJson(record.outputSchema) : null, record.annotations ? canonicalJson(record.annotations) : null, active.has(record.name) ? 1 : 0, revision, record.digest));
  }
  statements.push(env.DB.prepare(
    "UPDATE browser_sessions SET catalog_revision = ?, catalog_digest = ?, last_seen_at = ? WHERE session_id = ?",
  ).bind(revision, catalogDigest, nowIso(), sessionId));
  await env.DB.batch(statements);
  return jsonResponse(request, env, {
    contract_revision: CONTRACT_REVISION,
    session_id: sessionId,
    catalog_revision: revision,
    catalog_digest: catalogDigest,
    active_tools: records.filter((record) => active.has(record.name)).map((record) => ({ name: record.name, relay_name: record.relayName, tool_digest: record.digest })),
  });
}

async function handleCreateGrant(request, env) {
  requireBearer(request, env.OPERATOR_BEARER_TOKEN, "Operator");
  const body = await readJson(request);
  exactObject(body, ["mode", "profile", "session_id", "origin", "tool_name", "tool_digest", "constraints", "expires_at"], ["mode", "profile", "session_id", "origin", "tool_name", "tool_digest", "constraints", "expires_at"], "body");
  if (body.mode !== "delegated_authority") fail(400, "INVALID_AUTHORITY_MODE", "Grant mode must be delegated_authority.");
  if (!["ask_on_exception", "autonomous_within_bounds"].includes(body.profile)) fail(400, "INVALID_REVIEW_PROFILE", "Unknown review profile.");
  const sessionId = text(body.session_id, "session_id", { max: 160, pattern: /^bs_[a-f0-9]{48}$/ });
  const session = await loadBrowserSession(env, sessionId);
  const createdAt = nowIso();
  if (Date.parse(session.expires_at) <= Date.now()) fail(410, "SESSION_EXPIRED", "Cannot create a grant for an expired browser session.");
  if (session.authority_mode !== "delegated_authority" || session.review_profile !== body.profile) {
    fail(409, "SESSION_AUTHORITY_MISMATCH", "The grant must match this browser session's delegated authority profile.");
  }
  const origin = text(body.origin, "origin", { max: 2048 });
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    fail(400, "INVALID_ORIGIN", "origin must be an HTTPS origin.");
  }
  if (parsedOrigin.protocol !== "https:" || parsedOrigin.origin !== origin || parsedOrigin.pathname !== "/") fail(400, "INVALID_ORIGIN", "origin must be an HTTPS origin without a path.");
  if (origin !== session.source_origin) fail(409, "SESSION_ORIGIN_MISMATCH", "The grant origin must match this browser session.");
  const toolName = text(body.tool_name, "tool_name", { max: 128 });
  const toolDigest = text(body.tool_digest, "tool_digest", { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
  const tool = await env.DB.prepare(
    "SELECT tool_digest FROM session_tools WHERE session_id = ? AND tool_name = ? AND active = 1",
  ).bind(sessionId, toolName).first();
  if (!tool || !secureEqual(tool.tool_digest, toolDigest)) fail(409, "TOOL_BINDING_MISMATCH", "The grant must match one active tool definition in this browser session.");
  const constraints = validateConstraintsDefinition(body.constraints);
  const expiresAt = isoFuture(body.expires_at, "expires_at");
  if (Date.parse(expiresAt) > Date.parse(session.expires_at)) fail(400, "GRANT_OUTLIVES_SESSION", "The grant cannot outlive its browser session.");
  const grantId = randomToken("grant");
  const activeKey = `${sessionId}\n${toolName}\n${toolDigest}`;
  const constraintsDigest = await sha256(constraints);
  await env.DB.prepare("UPDATE grants SET active_key = NULL WHERE active_key = ? AND expires_at <= ?").bind(activeKey, createdAt).run();
  try {
    await env.DB.prepare(
      `INSERT INTO grants
       (grant_id, mode, profile, session_id, source_origin, source_url, tool_name, tool_digest, constraints_json, constraints_digest, expires_at, created_at, active_key)
       VALUES (?, 'delegated_authority', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(grantId, body.profile, sessionId, origin, session.source_url, toolName, toolDigest, canonicalJson(constraints), constraintsDigest, expiresAt, createdAt, activeKey).run();
  } catch (error) {
    if (String(error?.message || error).toLowerCase().includes("unique")) fail(409, "ACTIVE_GRANT_EXISTS", "Revoke the active session-bound rule for this tool definition before replacing it.");
    throw error;
  }
  return jsonResponse(request, env, {
    contract_revision: CONTRACT_REVISION,
    grant: { grant_id: grantId, mode: body.mode, profile: body.profile, session_id: sessionId, origin, source_url: session.source_url, tool_name: toolName, tool_digest: toolDigest, constraints_digest: constraintsDigest, expires_at: expiresAt },
  }, 201);
}

async function handleRevokeGrant(request, env, grantId) {
  requireBearer(request, env.OPERATOR_BEARER_TOKEN, "Operator");
  text(grantId, "grant_id", { max: 160, pattern: /^grant_[a-f0-9]{48}$/ });
  const body = await readJson(request);
  exactObject(body, [], [], "body");
  const revokedAt = nowIso();
  const result = await env.DB.prepare(
    "UPDATE grants SET revoked_at = ?, active_key = NULL WHERE grant_id = ? AND revoked_at IS NULL",
  ).bind(revokedAt, grantId).run();
  if (changes(result) !== 1) {
    const existing = await env.DB.prepare("SELECT grant_id, revoked_at FROM grants WHERE grant_id = ?").bind(grantId).first();
    if (!existing) fail(404, "GRANT_NOT_FOUND", "Grant was not found.");
  }
  return jsonResponse(request, env, { contract_revision: CONTRACT_REVISION, grant_id: grantId, status: "revoked", revoked_at: revokedAt });
}

async function applicableGrant(env, session, tool, args, createdAt) {
  const activeKey = `${session.session_id}\n${tool.tool_name}\n${tool.tool_digest}`;
  await env.DB.prepare("UPDATE grants SET active_key = NULL WHERE active_key = ? AND expires_at <= ?").bind(activeKey, createdAt).run();
  const grant = await env.DB.prepare(
    "SELECT * FROM grants WHERE active_key = ? AND revoked_at IS NULL AND expires_at > ?",
  ).bind(activeKey, createdAt).first();
  if (!grant) return { grant: null, matches: false, profile: session.review_profile, reason: "delegated_grant_missing" };
  const constraints = parseStored(grant.constraints_json);
  const matches = argumentsWithinConstraints(args, constraints);
  return { grant, matches, profile: grant.profile, reason: matches ? null : "delegated_grant_exceeded" };
}

async function loadExecutionByRequest(env, sessionId, requestKey) {
  return env.DB.prepare("SELECT * FROM executions WHERE session_id = ? AND mcp_request_key = ?").bind(sessionId, requestKey).first();
}

async function createExecution(env, session, tool, args, requestKey) {
  validateValue(args, parseStored(tool.input_schema_json), "arguments");
  const createdAt = nowIso();
  const executionId = randomToken("exec");
  const action = {
    contract_revision: CONTRACT_REVISION,
    session_id: session.session_id,
    catalog_revision: tool.catalog_revision,
    tool_digest: tool.tool_digest,
    source: { origin: session.source_origin, url: session.source_url },
    tool_name: tool.tool_name,
    tool_description: tool.description,
    tool_input_schema: parseStored(tool.input_schema_json),
    arguments: args,
  };
  const actionDigest = await sha256(action);
  let profile = session.review_profile;
  let grant = null;
  let authorityState;
  let status;
  let outcome = null;
  let docketId = null;
  let docketReason = null;
  if (session.authority_mode === "transaction_authorized") {
    authorityState = "awaiting_transaction_authorization";
    status = "authority_required";
    docketReason = "transaction_authorization_required";
  } else {
    const evaluation = await applicableGrant(env, session, tool, args, createdAt);
    profile = evaluation.profile;
    grant = evaluation.grant;
    if (evaluation.matches) {
      authorityState = "delegated_authority_reserved";
      status = "queued";
    } else if (profile === "ask_on_exception") {
      authorityState = "awaiting_exception_authorization";
      status = "authority_required";
      docketReason = evaluation.reason;
    } else {
      authorityState = "delegated_authority_unavailable";
      status = "blocked_authority";
      outcome = "not_executed";
    }
  }
  if (status === "authority_required") docketId = randomToken("docket");
  const projected = {
    execution_id: executionId,
    session_id: session.session_id,
    mcp_request_key: requestKey,
    source_origin: session.source_origin,
    source_url: session.source_url,
    tool_name: tool.tool_name,
    relay_name: tool.relay_name,
    catalog_revision: tool.catalog_revision,
    tool_digest: tool.tool_digest,
    output_schema_json: tool.output_schema_json,
    arguments_json: canonicalJson(args),
    action_digest: actionDigest,
    authority_mode: session.authority_mode,
    review_profile: profile,
    grant_id: grant?.grant_id || null,
    docket_id: docketId,
    authority_state: authorityState,
    status,
    dispatch_claimed: 0,
    result_status: null,
    result_json: null,
    result_digest: null,
    result_verification: null,
    outcome,
    receipt_digest: null,
    created_at: createdAt,
    authorized_at: status === "queued" ? createdAt : null,
    dispatched_at: null,
    result_deadline_at: null,
    completed_at: terminal(status) ? createdAt : null,
  };
  if (terminal(status)) projected.receipt_digest = await sha256(receiptPreimage(projected));
  const insertExecution = env.DB.prepare(
    `INSERT INTO executions
     (execution_id, session_id, mcp_request_key, source_origin, source_url, tool_name, relay_name, catalog_revision, tool_digest, output_schema_json, arguments_json,
      action_digest, authority_mode, review_profile, grant_id, docket_id, authority_state, status, dispatch_claimed,
      outcome, receipt_digest, created_at, authorized_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
  ).bind(executionId, session.session_id, requestKey, session.source_origin, session.source_url, tool.tool_name, tool.relay_name, tool.catalog_revision, tool.tool_digest, tool.output_schema_json, canonicalJson(args), actionDigest, session.authority_mode, profile, grant?.grant_id || null, docketId, authorityState, status, outcome, projected.receipt_digest, createdAt, projected.authorized_at, projected.completed_at);
  const eventType = status === "queued" ? "delegated_authority_accepted" : status === "authority_required" ? "docket_created" : "authority_blocked";
  const statements = [insertExecution];
  if (docketId) {
    const exactDecision = {
      decision_revision: CONTRACT_REVISION,
      execution_id: executionId,
      action,
      action_digest: actionDigest,
      missing_authority: docketReason,
      permitted_decisions: ["authorize_once", "deny"],
    };
    statements.push(env.DB.prepare(
      `INSERT INTO dockets (docket_id, execution_id, status, reason_code, exact_decision_json, created_at)
       VALUES (?, ?, 'pending', ?, ?, ?)`,
    ).bind(docketId, executionId, docketReason, canonicalJson(exactDecision), createdAt));
  }
  statements.push(env.DB.prepare(
    "INSERT INTO receipt_events (execution_id, event_key, event_type, evidence_json, created_at) VALUES (?, 'created', ?, ?, ?)",
  ).bind(executionId, eventType, canonicalJson({ action_digest: actionDigest, authority_mode: session.authority_mode, review_profile: profile, grant_id: grant?.grant_id || null, docket_id: docketId }), createdAt));
  if (terminal(status)) statements.push(env.DB.prepare(
    "INSERT INTO receipt_events (execution_id, event_key, event_type, evidence_json, created_at) VALUES (?, 'terminal', 'not_executed', ?, ?)",
  ).bind(executionId, canonicalJson({ action_digest: actionDigest, reason: "authority_boundary_not_reviewable" }), createdAt));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const existing = await loadExecutionByRequest(env, session.session_id, requestKey);
    if (!existing) throw error;
    if (existing.action_digest !== actionDigest) fail(409, "REQUEST_ID_REUSED", "The MCP request identifier is already bound to a different exact action.");
    return existing;
  }
  return env.DB.prepare("SELECT * FROM executions WHERE execution_id = ?").bind(executionId).first();
}

async function executionForToolCall(env, session, relayName, args, requestKey) {
  const tool = await env.DB.prepare(
    "SELECT * FROM session_tools WHERE session_id = ? AND relay_name = ? AND active = 1",
  ).bind(session.session_id, relayName).first();
  if (!tool) fail(404, "TOOL_NOT_AVAILABLE", "The requested tool is not in the active bounded set.");
  return createExecution(env, session, tool, args, requestKey);
}

async function expireQueuedSession(env, session) {
  if (Date.parse(session.expires_at) > Date.now()) return;
  const rows = await env.DB.prepare(
    "SELECT * FROM executions WHERE session_id = ? AND status = 'queued' AND dispatch_claimed = 0",
  ).bind(session.session_id).all();
  for (const row of rows.results || []) {
    const completedAt = nowIso();
    const projected = { ...row, status: "blocked_session_expired", authority_state: "expired_before_dispatch", outcome: "not_executed", completed_at: completedAt };
    const digest = await sha256(receiptPreimage(projected));
    const result = await env.DB.prepare(
      `UPDATE executions SET status = 'blocked_session_expired', authority_state = 'expired_before_dispatch',
       outcome = 'not_executed', receipt_digest = ?, completed_at = ?
       WHERE execution_id = ? AND status = 'queued' AND dispatch_claimed = 0`,
    ).bind(digest, completedAt, row.execution_id).run();
    if (changes(result) === 1) await appendEvent(env, row.execution_id, "terminal", "not_executed", { action_digest: row.action_digest, reason: "browser_session_expired" }, completedAt);
  }
}

async function claimCommand(env, session) {
  await expireQueuedSession(env, session);
  if (Date.parse(session.expires_at) <= Date.now()) return null;
  const candidates = await env.DB.prepare(
    "SELECT * FROM executions WHERE session_id = ? AND status = 'queued' AND dispatch_claimed = 0 ORDER BY created_at LIMIT 4",
  ).bind(session.session_id).all();
  for (const candidate of candidates.results || []) {
    const dispatchedAt = nowIso();
    const timeout = envInteger(env, "COMMAND_RESULT_TIMEOUT_SECONDS", 120, 15, 900);
    const resultDeadline = addSeconds(dispatchedAt, timeout);
    const claimed = await env.DB.prepare(
      `UPDATE executions SET status = 'dispatched', dispatch_claimed = 1, authority_state = 'consumed',
       dispatched_at = ?, result_deadline_at = ? WHERE execution_id = ? AND status = 'queued' AND dispatch_claimed = 0`,
    ).bind(dispatchedAt, resultDeadline, candidate.execution_id).run();
    if (changes(claimed) !== 1) continue;
    await appendEvent(env, candidate.execution_id, "dispatch", "browser_dispatch_claimed", { action_digest: candidate.action_digest }, dispatchedAt);
    return {
      execution_id: candidate.execution_id,
      action_hash: candidate.action_digest,
      source: { origin: candidate.source_origin, url: candidate.source_url },
      tool: { name: candidate.tool_name, relay_name: candidate.relay_name },
      arguments: parseStored(candidate.arguments_json),
      result_deadline_at: resultDeadline,
    };
  }
  return null;
}

async function handlePollCommands(request, env, sessionId) {
  requireBearer(request, env.BROWSER_BEARER_TOKEN, "Browser");
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) if (key !== "wait_ms") fail(400, "UNKNOWN_QUERY", `Unknown query parameter ${key}.`);
  const rawWait = url.searchParams.get("wait_ms") ?? "0";
  if (!/^\d+$/.test(rawWait)) fail(400, "INVALID_WAIT", "wait_ms must be an integer.");
  const waitMs = integer(Number(rawWait), "wait_ms", { min: 0, max: 15_000 });
  const session = await loadBrowserSession(env, sessionId);
  const end = Date.now() + waitMs;
  let command = null;
  do {
    command = await claimCommand(env, session);
    if (command || Date.now() >= end) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, end - Date.now())));
  } while (Date.now() < end);
  await env.DB.prepare("UPDATE browser_sessions SET last_seen_at = ? WHERE session_id = ?").bind(nowIso(), sessionId).run();
  const pending = await env.DB.prepare(
    `SELECT d.docket_id, d.execution_id, d.reason_code, d.created_at
     FROM dockets d JOIN executions e ON e.execution_id = d.execution_id
     WHERE e.session_id = ? AND d.status = 'pending' ORDER BY d.created_at`,
  ).bind(sessionId).all();
  return jsonResponse(request, env, {
    contract_revision: CONTRACT_REVISION,
    session_id: sessionId,
    commands: command ? [command] : [],
    authority_required: pending.results || [],
  });
}

function resultBody(value) {
  exactObject(value, ["action_hash", "status", "result", "error"], ["action_hash", "status"], "body");
  text(value.action_hash, "action_hash", { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
  if (!["completed", "failed", "unknown"].includes(value.status)) fail(400, "INVALID_RESULT_STATUS", "Unknown result status.");
  if (value.status === "completed") {
    if (!Object.hasOwn(value, "result") || Object.hasOwn(value, "error")) fail(400, "INVALID_RESULT", "completed requires result and forbids error.");
  } else {
    if (Object.hasOwn(value, "result")) fail(400, "INVALID_RESULT", "Non-completed results cannot include result.");
    if (Object.hasOwn(value, "error")) {
      exactObject(value.error, ["code", "message"], ["code", "message"], "error");
      text(value.error.code, "error.code", { max: 128 });
      text(value.error.message, "error.message", { min: 0, max: 4096 });
    }
  }
  return value;
}

async function handleBrowserResult(request, env, executionId) {
  requireBearer(request, env.BROWSER_BEARER_TOKEN, "Browser");
  text(executionId, "execution_id", { max: 160, pattern: /^exec_[a-f0-9]{48}$/ });
  const body = resultBody(await readJson(request));
  let row = await env.DB.prepare("SELECT * FROM executions WHERE execution_id = ?").bind(executionId).first();
  if (!row) fail(404, "EXECUTION_NOT_FOUND", "Execution was not found.");
  row = await refreshAmbiguity(env, row);
  if (!secureEqual(body.action_hash, row.action_digest)) fail(409, "ACTION_BINDING_MISMATCH", "Result does not match the exact queued action.");
  const resultEnvelope = body.status === "completed" ? { status: body.status, result: body.result } : { status: body.status, error: body.error ?? null };
  const resultDigest = await sha256(resultEnvelope);
  if (row.status !== "dispatched") {
    if (terminal(row.status) && row.result_digest && secureEqual(row.result_digest, resultDigest)) {
      return jsonResponse(request, env, await executionView(env, row));
    }
    if (row.status === "unknown") {
      await appendEvent(env, row.execution_id, `late_${resultDigest}`, "late_result_ignored", { action_digest: row.action_digest, result_digest: resultDigest });
      fail(409, "AMBIGUOUS_LINEAGE_CLOSED", "Late evidence was recorded but cannot replace an unknown outcome.");
    }
    fail(409, "EXECUTION_NOT_DISPATCHED", "Execution is not accepting a browser result.");
  }
  let status = body.status;
  let outcome = body.status === "completed" ? "executed_result_returned" : body.status === "failed" ? "not_executed" : "unknown";
  let verification = body.status === "failed" ? "authenticated_extension_preinvoke_failure_bound" : "authenticated_extension_result_bound";
  if (body.status === "completed") {
    if (row.output_schema_json) {
      try {
        validateValue(body.result, parseStored(row.output_schema_json), "result");
        verification = "authenticated_extension_result_and_output_schema_bound";
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        status = "unknown";
        outcome = "unknown";
        verification = "output_schema_mismatch_after_dispatch";
      }
    }
  } else if (body.status === "unknown") {
    verification = "browser_reported_ambiguity";
  }
  const completedAt = nowIso();
  const projected = {
    ...row,
    status,
    result_status: body.status,
    result_json: canonicalJson(resultEnvelope),
    result_digest: resultDigest,
    result_verification: verification,
    outcome,
    completed_at: completedAt,
  };
  const receiptDigest = await sha256(receiptPreimage(projected));
  const updated = await env.DB.prepare(
    `UPDATE executions SET status = ?, result_status = ?, result_json = ?, result_digest = ?, result_verification = ?,
     outcome = ?, receipt_digest = ?, completed_at = ? WHERE execution_id = ? AND status = 'dispatched'`,
  ).bind(status, body.status, canonicalJson(resultEnvelope), resultDigest, verification, outcome, receiptDigest, completedAt, executionId).run();
  if (changes(updated) !== 1) fail(409, "RESULT_RACE", "Another terminal result won the exact execution lineage.");
  await appendEvent(env, executionId, "terminal", status === "completed" ? "bound_result_returned" : status === "failed" ? "not_executed" : "outcome_unknown", {
    action_digest: row.action_digest,
    result_digest: resultDigest,
    verification,
  }, completedAt);
  row = await env.DB.prepare("SELECT * FROM executions WHERE execution_id = ?").bind(executionId).first();
  return jsonResponse(request, env, await executionView(env, row));
}

async function handleBrowserStatus(request, env, executionId) {
  requireBearer(request, env.BROWSER_BEARER_TOKEN, "Browser");
  const row = await env.DB.prepare("SELECT * FROM executions WHERE execution_id = ?").bind(executionId).first();
  if (!row) fail(404, "EXECUTION_NOT_FOUND", "Execution was not found.");
  return jsonResponse(request, env, await executionView(env, row));
}

async function handleGetDocket(request, env, docketId) {
  requireBearer(request, env.OPERATOR_BEARER_TOKEN, "Operator");
  const docket = await env.DB.prepare("SELECT * FROM dockets WHERE docket_id = ?").bind(docketId).first();
  if (!docket) fail(404, "DOCKET_NOT_FOUND", "Docket was not found.");
  return jsonResponse(request, env, {
    contract_revision: CONTRACT_REVISION,
    docket_id: docket.docket_id,
    execution_id: docket.execution_id,
    status: docket.status,
    reason_code: docket.reason_code,
    exact_decision: parseStored(docket.exact_decision_json),
    created_at: docket.created_at,
    decided_at: docket.decided_at || null,
  });
}

async function handleDocketDecision(request, env, docketId) {
  requireBearer(request, env.OPERATOR_BEARER_TOKEN, "Operator");
  const body = await readJson(request);
  exactObject(body, ["decision"], ["decision"], "body");
  if (!["authorize_once", "deny"].includes(body.decision)) fail(400, "INVALID_DECISION", "decision must be authorize_once or deny.");
  const docket = await env.DB.prepare("SELECT * FROM dockets WHERE docket_id = ?").bind(docketId).first();
  if (!docket) fail(404, "DOCKET_NOT_FOUND", "Docket was not found.");
  if (docket.status !== "pending") fail(409, "DOCKET_ALREADY_DECIDED", "Docket already has a decision.");
  let row = await env.DB.prepare("SELECT * FROM executions WHERE execution_id = ?").bind(docket.execution_id).first();
  if (!row || row.status !== "authority_required") fail(409, "EXECUTION_STATE_MISMATCH", "Execution is not awaiting this decision.");
  const session = await loadBrowserSession(env, row.session_id);
  if (body.decision === "authorize_once" && Date.parse(session.expires_at) <= Date.now()) fail(410, "SESSION_EXPIRED", "Cannot authorize an expired browser session.");
  const decidedAt = nowIso();
  if (body.decision === "authorize_once") {
    await env.DB.batch([
      env.DB.prepare("UPDATE dockets SET status = 'authorized', decided_at = ? WHERE docket_id = ? AND status = 'pending'").bind(decidedAt, docketId),
      env.DB.prepare(
        "UPDATE executions SET status = 'queued', authority_state = 'one_time_authority_reserved', authorized_at = ? WHERE execution_id = ? AND status = 'authority_required'",
      ).bind(decidedAt, row.execution_id),
      env.DB.prepare(
        "INSERT OR IGNORE INTO receipt_events (execution_id, event_key, event_type, evidence_json, created_at) VALUES (?, 'decision', 'authorize_once', ?, ?)",
      ).bind(row.execution_id, canonicalJson({ action_digest: row.action_digest, docket_id: docketId }), decidedAt),
    ]);
  } else {
    const projected = { ...row, status: "denied", authority_state: "denied", outcome: "not_executed", completed_at: decidedAt };
    const receiptDigest = await sha256(receiptPreimage(projected));
    await env.DB.batch([
      env.DB.prepare("UPDATE dockets SET status = 'denied', decided_at = ? WHERE docket_id = ? AND status = 'pending'").bind(decidedAt, docketId),
      env.DB.prepare(
        "UPDATE executions SET status = 'denied', authority_state = 'denied', outcome = 'not_executed', receipt_digest = ?, completed_at = ? WHERE execution_id = ? AND status = 'authority_required'",
      ).bind(receiptDigest, decidedAt, row.execution_id),
      env.DB.prepare(
        "INSERT OR IGNORE INTO receipt_events (execution_id, event_key, event_type, evidence_json, created_at) VALUES (?, 'decision', 'denied', ?, ?)",
      ).bind(row.execution_id, canonicalJson({ action_digest: row.action_digest, docket_id: docketId }), decidedAt),
      env.DB.prepare(
        "INSERT OR IGNORE INTO receipt_events (execution_id, event_key, event_type, evidence_json, created_at) VALUES (?, 'terminal', 'not_executed', ?, ?)",
      ).bind(row.execution_id, canonicalJson({ action_digest: row.action_digest, reason: "human_denied" }), decidedAt),
    ]);
  }
  row = await env.DB.prepare("SELECT * FROM executions WHERE execution_id = ?").bind(row.execution_id).first();
  return jsonResponse(request, env, await executionView(env, row));
}

async function handleReceipt(request, env, executionId) {
  const authorization = request.headers.get("authorization") || "";
  const browser = authorization.startsWith("Bearer ") && secureEqual(authorization.slice(7), String(env.BROWSER_BEARER_TOKEN || ""));
  const operator = authorization.startsWith("Bearer ") && secureEqual(authorization.slice(7), String(env.OPERATOR_BEARER_TOKEN || ""));
  if (!browser && !operator) fail(401, "UNAUTHORIZED", "Browser or operator authentication is required.");
  let row = await env.DB.prepare("SELECT * FROM executions WHERE execution_id = ?").bind(executionId).first();
  if (!row) fail(404, "EXECUTION_NOT_FOUND", "Execution was not found.");
  row = await refreshAmbiguity(env, row);
  if (!terminal(row.status)) fail(409, "RECEIPT_NOT_READY", "Execution has no terminal receipt yet.");
  return jsonResponse(request, env, await publicReceipt(env, row));
}

function mcpToolResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

async function listRelayTools(env, sessionId) {
  const rows = await env.DB.prepare(
    "SELECT * FROM session_tools WHERE session_id = ? AND active = 1 ORDER BY relay_name",
  ).bind(sessionId).all();
  return (rows.results || []).map((row) => ({
    name: row.relay_name,
    title: row.tool_name,
    description: row.description || `Invoke the bounded current-page WebMCP tool ${row.tool_name}.`,
    inputSchema: parseStored(row.input_schema_json),
    ...(row.output_schema_json ? { outputSchema: parseStored(row.output_schema_json) } : {}),
    ...(row.annotations_json ? { annotations: parseStored(row.annotations_json) } : {}),
  }));
}

const STATUS_TOOL = {
  name: "doa2ai_status",
  title: "Read doA2Ai execution status",
  description: "Read the authority, dispatch, result, and receipt state for one exact queued doA2Ai execution. This tool is read-only.",
  inputSchema: {
    type: "object",
    properties: { execution_id: { type: "string", minLength: 10, maxLength: 160 } },
    required: ["execution_id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

async function handleMcp(request, env) {
  requireBearer(request, env.MCP_BEARER_TOKEN, "MCP");
  const origin = request.headers.get("origin");
  if (origin) fail(403, "MCP_ORIGIN_NOT_ALLOWED", "Browser-origin MCP requests are not accepted by this server-to-server endpoint.");
  const requestedProtocol = request.headers.get("mcp-protocol-version");
  if (requestedProtocol && requestedProtocol !== MCP_PROTOCOL_VERSION) fail(400, "UNSUPPORTED_MCP_PROTOCOL", "Unsupported MCP protocol version.");
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) if (key !== "session") fail(400, "UNKNOWN_QUERY", `Unknown query parameter ${key}.`);
  const session = await loadMcpSession(env, url.searchParams.get("session") || "");
  const body = await readJson(request);
  if (!isRecord(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return jsonResponse(request, env, rpcError(body?.id, -32600, "Invalid JSON-RPC request."));
  }
  const id = body.id;
  try {
    if (body.method === "notifications/initialized") return noContent(request, env, 202);
    if (body.method === "initialize") {
      return jsonResponse(request, env, rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "doA2Ai", version: "1.0.0" },
        instructions: "This server relays only the active bounded WebMCP tools published by the paired doA2Ai browser extension. Use doa2ai_status after a queued or authority-required call.",
      }));
    }
    if (body.method === "ping") return jsonResponse(request, env, rpcResult(id, {}));
    if (body.method === "tools/list") {
      if (body.params !== undefined) exactObject(body.params, ["cursor"], [], "params");
      const tools = [STATUS_TOOL, ...await listRelayTools(env, session.session_id)];
      return jsonResponse(request, env, rpcResult(id, { tools }));
    }
    if (body.method === "tools/call") {
      if (id === undefined || (typeof id !== "string" && typeof id !== "number")) return jsonResponse(request, env, rpcError(id, -32600, "tools/call requires a string or numeric id."));
      exactObject(body.params, ["name", "arguments"], ["name"], "params");
      const name = text(body.params.name, "params.name", { max: 160 });
      const args = body.params.arguments ?? {};
      if (!isRecord(args)) fail(400, "INVALID_ARGUMENTS", "Tool arguments must be an object.");
      if (name === STATUS_TOOL.name) {
        validateValue(args, STATUS_TOOL.inputSchema, "arguments");
        let row = await env.DB.prepare("SELECT * FROM executions WHERE execution_id = ? AND session_id = ?").bind(args.execution_id, session.session_id).first();
        if (!row) fail(404, "EXECUTION_NOT_FOUND", "Execution was not found in this MCP session.");
        return jsonResponse(request, env, rpcResult(id, mcpToolResult(await executionView(env, row))));
      }
      const requestKey = await sha256({ jsonrpc_id: id });
      const row = await executionForToolCall(env, session, name, args, requestKey);
      const view = await executionView(env, row, false);
      return jsonResponse(request, env, rpcResult(id, mcpToolResult(view, row.status === "blocked_authority")));
    }
    return jsonResponse(request, env, rpcError(id, -32601, "Method not found."));
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse(request, env, rpcError(id, -32000 - Math.min(error.status, 999), error.message, { code: error.code }));
    throw error;
  }
}

async function controlCapabilities(request, env, sessionId) {
  const session = await requireControlSession(request, env, sessionId);
  const tools = await listRelayTools(env, session.session_id);
  const pending = await env.DB.prepare(
    `SELECT d.docket_id, d.execution_id, d.reason_code, d.created_at
     FROM dockets d JOIN executions e ON e.execution_id = d.execution_id
     WHERE e.session_id = ? AND d.status = 'pending' ORDER BY d.created_at`,
  ).bind(sessionId).all();
  return jsonResponse(request, env, {
    contract_revision: CONTRACT_REVISION,
    session: {
      session_id: session.session_id,
      source: { origin: session.source_origin, url: session.source_url },
      authority: { mode: session.authority_mode, profile: session.review_profile },
      catalog_revision: session.catalog_revision,
      expires_at: session.expires_at,
    },
    tools: tools.map((tool) => ({ relay_name: tool.name, name: tool.title, description: tool.description, input_schema: tool.inputSchema })),
    pending_dockets: pending.results || [],
  });
}

async function controlAction(request, env, sessionId) {
  const session = await requireControlSession(request, env, sessionId);
  const body = await readJson(request);
  exactObject(body, ["request_id", "relay_name", "arguments"], ["request_id", "relay_name", "arguments"], "body");
  const requestId = text(body.request_id, "request_id", { max: 160, pattern: /^[A-Za-z0-9._:-]{8,160}$/ });
  const relayName = text(body.relay_name, "relay_name", { max: 160 });
  if (!isRecord(body.arguments)) fail(400, "INVALID_ARGUMENTS", "arguments must be an object.");
  const requestKey = await sha256({ control_request_id: requestId });
  const row = await executionForToolCall(env, session, relayName, body.arguments, requestKey);
  return jsonResponse(request, env, await executionView(env, row, false), 202);
}

async function controlStatus(request, env, sessionId, executionId) {
  await requireControlSession(request, env, sessionId);
  const row = await env.DB.prepare("SELECT * FROM executions WHERE execution_id = ? AND session_id = ?").bind(executionId, sessionId).first();
  if (!row) fail(404, "EXECUTION_NOT_FOUND", "Execution was not found in the paired session.");
  return jsonResponse(request, env, await executionView(env, row));
}

function opaqueV2Id(value, label) {
  return text(value, label, { min: 8, max: 160, pattern: /^[A-Za-z][A-Za-z0-9._:-]{7,159}$/u });
}

function fixedV2Id(value, label, prefix) {
  return text(value, label, { max: 80, pattern: new RegExp(`^${prefix}_[a-f0-9]{48}$`, "u") });
}

function v2Readiness() {
  return {
    service: "doa2ai-broker",
    status: "ready",
    contract_revision: V2_CONTRACT_REVISION,
    role: "ephemeral_authority_transport",
    authority_owner: "installed_extension",
    capabilities: {
      proof_of_possession_pairing: true,
      device_signed_requests: true,
      terminal_receipt_binding: true,
      task_scoped_connections: true,
    },
    boundaries: {
      embedded_agent: false,
      webmcp_target: false,
      sample_state: false,
      server_side_policy_history: false,
      independent_target_attestation: false,
    },
  };
}

async function handleV2DeviceChallenge(request, env) {
  const body = await readJson(request);
  exactObject(body, ["public_key_jwk"], ["public_key_jwk"], "body");
  const publicJwk = validateP256PublicJwk(body.public_key_jwk);
  await importP256PublicKey(publicJwk);
  const thumbprint = await p256JwkThumbprint(publicJwk);
  const createdAt = nowIso();
  const expiresAt = addSeconds(createdAt, DEVICE_CHALLENGE_TTL_SECONDS);
  const challengeId = randomToken("dch");
  const challenge = randomBase64Url(32);
  await env.DB.prepare(
    `INSERT INTO v2_device_challenges
     (challenge_id, challenge, public_jwk_json, jwk_thumbprint, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(challengeId, challenge, canonicalJson(publicJwk), thumbprint, createdAt, expiresAt).run();
  return jsonResponse(request, env, { challenge_id: challengeId, challenge, expires_at: expiresAt }, 201);
}

async function handleV2DeviceRegister(request, env) {
  const body = await readJson(request);
  exactObject(body, ["challenge_id", "signature"], ["challenge_id", "signature"], "body");
  const challengeId = fixedV2Id(body.challenge_id, "challenge_id", "dch");
  const signature = text(body.signature, "signature", { min: 80, max: 128, pattern: /^[A-Za-z0-9_-]+$/u });
  const challenge = await env.DB.prepare("SELECT * FROM v2_device_challenges WHERE challenge_id = ?").bind(challengeId).first();
  if (!challenge) fail(404, "CHALLENGE_NOT_FOUND", "Device challenge was not found.");
  if (challenge.consumed_at) fail(409, "CHALLENGE_CONSUMED", "Device challenge has already been consumed.");
  if (Date.parse(challenge.expires_at) <= Date.now()) fail(410, "CHALLENGE_EXPIRED", "Device challenge has expired.");
  const publicJwk = parseStored(challenge.public_jwk_json);
  if (!await verifyP256Signature(publicJwk, signature, deviceChallengeSigningInput(challenge.challenge))) {
    fail(401, "INVALID_CHALLENGE_SIGNATURE", "Device challenge signature is invalid.");
  }
  const registeredAt = nowIso();
  const existing = await env.DB.prepare(
    "SELECT device_id, created_at, revoked_at FROM v2_devices WHERE jwk_thumbprint = ?",
  ).bind(challenge.jwk_thumbprint).first();
  if (existing) {
    if (existing.revoked_at) fail(409, "DEVICE_KEY_REVOKED", "This device key was revoked and cannot be paired again.");
    const consumed = await env.DB.prepare(
      "UPDATE v2_device_challenges SET consumed_at = ? WHERE challenge_id = ? AND consumed_at IS NULL",
    ).bind(registeredAt, challengeId).run();
    if (changes(consumed) !== 1) fail(409, "CHALLENGE_RACE", "Device challenge could not be consumed exactly once.");
    return jsonResponse(request, env, { device_id: existing.device_id, registered_at: existing.created_at }, 200);
  }
  const deviceId = randomToken("dev");
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO v2_devices
       (device_id, public_jwk_json, jwk_thumbprint, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(deviceId, challenge.public_jwk_json, challenge.jwk_thumbprint, registeredAt, registeredAt),
    env.DB.prepare(
      "UPDATE v2_device_challenges SET consumed_at = ? WHERE challenge_id = ? AND consumed_at IS NULL",
    ).bind(registeredAt, challengeId),
  ]);
  if (changes(results[0]) !== 1 || changes(results[1]) !== 1) fail(409, "CHALLENGE_RACE", "Device challenge could not be consumed exactly once.");
  return jsonResponse(request, env, { device_id: deviceId, registered_at: registeredAt }, 201);
}

async function requireSignedV2Device(request, env, expectedDeviceId = null) {
  const deviceId = fixedV2Id(request.headers.get("x-doa2ai-device") || "", "X-doA2Ai-Device", "dev");
  if (expectedDeviceId && deviceId !== expectedDeviceId) fail(403, "DEVICE_AUDIENCE_MISMATCH", "The signing device does not match this endpoint.");
  const device = await env.DB.prepare("SELECT * FROM v2_devices WHERE device_id = ?").bind(deviceId).first();
  if (!device) fail(401, "DEVICE_UNKNOWN", "The signing device is not registered.");
  if (device.revoked_at) fail(401, "DEVICE_REVOKED", "The signing device has been revoked.");
  const rawBody = await readRawBody(request.clone());
  const url = new URL(request.url);
  const pathWithQuery = `${url.pathname}${url.search}`;
  const timestamp = request.headers.get("x-doa2ai-timestamp") || "";
  const nonce = request.headers.get("x-doa2ai-nonce") || "";
  const signature = request.headers.get("x-doa2ai-signature") || "";
  const createdAt = nowIso();
  await verifySignedDeviceEnvelope({
    method: request.method,
    pathWithQuery,
    timestamp,
    nonce,
    signature,
    rawBody,
    publicJwk: parseStored(device.public_jwk_json),
    claimNonce: async () => {
      const result = await env.DB.prepare(
        `INSERT OR IGNORE INTO v2_device_nonces
         (device_id, nonce, request_method, request_path, request_timestamp, body_digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(deviceId, nonce, request.method, pathWithQuery, timestamp, await sha256(rawBody), createdAt).run();
      return changes(result) === 1;
    },
  });
  await env.DB.prepare("UPDATE v2_devices SET last_seen_at = ? WHERE device_id = ? AND revoked_at IS NULL").bind(createdAt, deviceId).run();
  return { device: { ...device, device_id: deviceId }, rawBody, body: parseJson(rawBody), seenAt: createdAt };
}

async function handleV2DeviceStatus(request, env, deviceId) {
  const signed = await requireSignedV2Device(request, env, deviceId);
  return jsonResponse(request, env, {
    contract_revision: V2_CONTRACT_REVISION,
    device_id: deviceId,
    status: "active",
    registered_at: signed.device.created_at,
    last_seen_at: signed.seenAt,
  });
}

async function handleV2DeviceRevoke(request, env, deviceId) {
  const signed = await requireSignedV2Device(request, env, deviceId);
  exactObject(signed.body, [], [], "body");
  const revokedAt = nowIso();
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE v2_devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL").bind(revokedAt, deviceId),
    env.DB.prepare("UPDATE v2_tasks SET status = 'revoked', ended_at = ? WHERE device_id = ? AND status = 'active'").bind(revokedAt, deviceId),
    env.DB.prepare("UPDATE v2_connections SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL").bind(revokedAt, deviceId),
  ]);
  if (changes(results[0]) !== 1) fail(409, "DEVICE_REVOKE_RACE", "Device was already revoked.");
  return jsonResponse(request, env, { device_id: deviceId, status: "revoked", revoked_at: revokedAt });
}

async function ensureV2Task(env, deviceId, requestedTaskId, createdAt, { requireActive = true } = {}) {
  const taskId = requestedTaskId === undefined ? randomToken("task") : opaqueV2Id(requestedTaskId, "task_id");
  let task = await env.DB.prepare("SELECT * FROM v2_tasks WHERE task_id = ?").bind(taskId).first();
  if (!task) {
    const expiresAt = addSeconds(createdAt, envInteger(env, "TASK_TTL_SECONDS", 1800, 60, 86_400));
    await env.DB.prepare(
      `INSERT OR IGNORE INTO v2_tasks
       (task_id, device_id, status, created_at, last_active_at, expires_at)
       VALUES (?, ?, 'active', ?, ?, ?)`,
    ).bind(taskId, deviceId, createdAt, createdAt, expiresAt).run();
    task = await env.DB.prepare("SELECT * FROM v2_tasks WHERE task_id = ?").bind(taskId).first();
  }
  if (!task || task.device_id !== deviceId) fail(409, "TASK_OWNERSHIP_MISMATCH", "Task ID belongs to another device.");
  if (requireActive && (task.status !== "active" || Date.parse(task.expires_at) <= Date.parse(createdAt))) fail(410, "TASK_INACTIVE", "Task is no longer active.");
  if (task.status === "active") await env.DB.prepare("UPDATE v2_tasks SET last_active_at = ? WHERE task_id = ? AND device_id = ?").bind(createdAt, taskId, deviceId).run();
  return { ...task, task_id: taskId };
}

async function handleV2CreateConnection(request, env) {
  const signed = await requireSignedV2Device(request, env);
  exactObject(signed.body, ["task_id", "ttl_seconds"], [], "body");
  const task = await ensureV2Task(env, signed.device.device_id, signed.body.task_id, signed.seenAt);
  const configuredTtl = envInteger(env, "CONNECTION_TTL_SECONDS", 900, 60, 3600);
  const requestedTtl = signed.body.ttl_seconds === undefined
    ? configuredTtl
    : integer(signed.body.ttl_seconds, "ttl_seconds", { min: 60, max: configuredTtl });
  const taskSecondsRemaining = Math.max(0, Math.floor((Date.parse(task.expires_at) - Date.parse(signed.seenAt)) / 1000));
  const ttl = Math.min(requestedTtl, taskSecondsRemaining);
  if (ttl < 60) fail(410, "TASK_EXPIRING", "Task expires too soon to create a connection.");
  const connectionId = randomToken("conn");
  const bearerToken = `d2c_${randomBase64Url(32)}`;
  const tokenHash = await hashConnectionToken(bearerToken);
  const expiresAt = addSeconds(signed.seenAt, ttl);
  await env.DB.prepare(
    `INSERT INTO v2_connections
     (connection_id, device_id, task_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(connectionId, signed.device.device_id, task.task_id, tokenHash, signed.seenAt, expiresAt).run();
  return jsonResponse(request, env, {
    contract_revision: V2_CONTRACT_REVISION,
    connection_id: connectionId,
    task_id: task.task_id,
    bearer_token: bearerToken,
    token_type: "Bearer",
    expires_at: expiresAt,
  }, 201);
}

async function handleV2RevokeConnection(request, env, connectionId) {
  const signed = await requireSignedV2Device(request, env);
  exactObject(signed.body, [], [], "body");
  const connection = await env.DB.prepare("SELECT * FROM v2_connections WHERE connection_id = ?").bind(connectionId).first();
  if (!connection || connection.device_id !== signed.device.device_id) fail(404, "CONNECTION_NOT_FOUND", "Connection was not found for this device.");
  if (connection.revoked_at) return jsonResponse(request, env, { connection_id: connectionId, status: "revoked", revoked_at: connection.revoked_at });
  const revokedAt = nowIso();
  await env.DB.prepare("UPDATE v2_connections SET revoked_at = ? WHERE connection_id = ? AND device_id = ? AND revoked_at IS NULL")
    .bind(revokedAt, connectionId, signed.device.device_id).run();
  return jsonResponse(request, env, { connection_id: connectionId, status: "revoked", revoked_at: revokedAt });
}

async function handleV2BindReceipt(request, env) {
  const signed = await requireSignedV2Device(request, env);
  exactObject(signed.body, ["action_id", "task_id", "receipt_digest"], ["action_id", "task_id", "receipt_digest"], "body");
  const actionId = opaqueV2Id(signed.body.action_id, "action_id");
  const taskId = opaqueV2Id(signed.body.task_id, "task_id");
  const receiptDigest = text(signed.body.receipt_digest, "receipt_digest", { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/u });
  await ensureV2Task(env, signed.device.device_id, taskId, signed.seenAt, { requireActive: false });
  const existingBinding = await env.DB.prepare("SELECT * FROM v2_receipt_bindings WHERE action_id = ?").bind(actionId).first();
  if (existingBinding) {
    if (existingBinding.device_id !== signed.device.device_id || existingBinding.task_id !== taskId || existingBinding.receipt_digest !== receiptDigest) {
      fail(409, "RECEIPT_BINDING_CONFLICT", "Action ID is already bound to a different terminal receipt.");
    }
    return jsonResponse(request, env, { action_id: actionId, receipt_digest: receiptDigest, bound_at: existingBinding.bound_at });
  }
  const existingAction = await env.DB.prepare("SELECT device_id, task_id FROM v2_actions WHERE action_id = ?").bind(actionId).first();
  if (existingAction && (existingAction.device_id !== signed.device.device_id || existingAction.task_id !== taskId)) {
    fail(409, "ACTION_OWNERSHIP_MISMATCH", "Action ID belongs to another task or device.");
  }
  const boundAt = nowIso();
  const actionStatement = existingAction
    ? env.DB.prepare(
      "UPDATE v2_actions SET status = 'receipt_bound', receipt_digest = ?, updated_at = ? WHERE action_id = ? AND device_id = ? AND task_id = ?",
    ).bind(receiptDigest, boundAt, actionId, signed.device.device_id, taskId)
    : env.DB.prepare(
      `INSERT INTO v2_actions
       (action_id, device_id, task_id, status, receipt_digest, created_at, updated_at)
       VALUES (?, ?, ?, 'receipt_bound', ?, ?, ?)`,
    ).bind(actionId, signed.device.device_id, taskId, receiptDigest, boundAt, boundAt);
  await env.DB.batch([
    actionStatement,
    env.DB.prepare(
      `INSERT INTO v2_receipt_bindings
       (action_id, device_id, task_id, receipt_digest, bound_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(actionId, signed.device.device_id, taskId, receiptDigest, boundAt),
  ]);
  return jsonResponse(request, env, { action_id: actionId, receipt_digest: receiptDigest, bound_at: boundAt }, 201);
}

const PRODUCT_CONTROL_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>doA2Ai — Authority for WebMCP</title>
  <style>
    :root{color-scheme:light dark;font:15px/1.5 system-ui,sans-serif;background:#f4f5f8;color:#172033;--accent:#6757bd;--line:#dfe3ec;--panel:#fff;--muted:#667187;--good:#185b39;--good-bg:#e5f5ec;--warn:#654b00;--warn-bg:#fff2d3}*{box-sizing:border-box}body{margin:0}main{max-width:960px;margin:auto;padding:36px 22px 72px}header{display:flex;gap:24px;align-items:flex-start;justify-content:space-between;margin-bottom:26px}.brand{font-weight:800;color:var(--accent);letter-spacing:.02em}h1{font-size:clamp(2rem,6vw,3.8rem);line-height:1.05;margin:.18em 0}.lede{max-width:65ch;color:var(--muted);font-size:1.08rem}.pill,.status{border-radius:999px;padding:8px 12px;background:#e9e7f5;color:#302867;font-weight:700;white-space:nowrap}.status{border-radius:10px;white-space:normal}.ok{background:var(--good-bg);color:var(--good)}.warn{background:var(--warn-bg);color:var(--warn)}section{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:20px;margin:16px 0;box-shadow:0 8px 30px #1720330b}h2{font-size:1.15rem;margin:0 0 10px}h3{font-size:1rem;margin:0}.muted{color:var(--muted)}button{border:0;border-radius:9px;background:var(--accent);color:#fff;padding:9px 13px;font:inherit;font-weight:750;cursor:pointer}button.secondary{background:#e9e7f5;color:#302867}button.quiet{background:transparent;color:var(--accent);border:1px solid var(--line)}button:disabled{opacity:.55;cursor:not-allowed}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.tabs{display:flex;gap:6px;overflow:auto;border-bottom:1px solid var(--line);padding:0 3px}.tabs button{border-radius:9px 9px 0 0;background:transparent;color:var(--muted)}.tabs button[aria-selected=true]{background:#e9e7f5;color:#302867}.panel[hidden],#workspace[hidden],#onboarding[hidden]{display:none}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px}.card{border:1px solid var(--line);border-radius:12px;padding:14px;overflow-wrap:anywhere}.card p{margin:.35em 0}.count{font-variant-numeric:tabular-nums}.badge{display:inline-block;border-radius:999px;padding:2px 8px;background:#eef0f6;color:#48536a;font-size:.82rem}.receipt{white-space:pre-wrap;max-height:260px;overflow:auto;background:#121725;color:#edf0f7;padding:12px;border-radius:9px;font:12px/1.5 ui-monospace,monospace}details{margin-top:8px}footer{margin-top:28px;color:var(--muted);font-size:.9rem}@media(prefers-color-scheme:dark){:root{background:#111522;color:#eef1f8;--panel:#191f2e;--line:#30394d;--muted:#aeb8ca}.pill,.tabs button[aria-selected=true],button.secondary{background:#303653;color:#e7e4ff}.badge{background:#293145;color:#c6cee0}}
  </style>
</head>
<body><main>
  <header><div><div class="brand">doA2Ai</div><h1>Authority at the exact boundary.</h1><p class="lede">The installed extension keeps rules and receipts on your device. This HTTPS control center shows only extension-provided state and never acts as an agent or WebMCP target.</p></div><div id="top-state" class="pill">Checking extension</div></header>
  <section id="onboarding" aria-labelledby="onboarding-title"><h2 id="onboarding-title">Enable the installed extension</h2><p id="onboarding-copy" class="muted">Open the doA2Ai Chrome extension to enable and connect this device. No account, agent selection, service URL, or token is entered on this page.</p><div id="extension-status" class="status warn">Extension bridge not detected yet.</div></section>
  <div id="workspace" hidden>
    <section><div class="grid"><div><h2>Protection</h2><div id="protection" class="status">Loading</div></div><div><h2>Pending reviews</h2><div id="review-count" class="status count">0</div></div><div><h2>Blocked activity</h2><div id="blocked-count" class="status count">0</div></div></div><p class="muted">Authority decisions, pause, and task revocation stay in the installed extension.</p><div class="actions"><button id="refresh" class="secondary">Refresh</button></div></section>
    <nav class="tabs" role="tablist" aria-label="Control center"><button role="tab" aria-selected="true" aria-controls="tasks" id="tab-tasks">Tasks</button><button role="tab" aria-selected="false" aria-controls="rules" id="tab-rules">Rules</button><button role="tab" aria-selected="false" aria-controls="activity" id="tab-activity">Activity &amp; receipts</button><button role="tab" aria-selected="false" aria-controls="connection" id="tab-connection">Connection health</button></nav>
    <section class="panel" role="tabpanel" id="tasks" aria-labelledby="tab-tasks"><h2>Active tasks</h2><div id="task-list" class="grid"></div><h2 style="margin-top:22px">Needs your authority</h2><div id="review-list" class="grid"></div></section>
    <section class="panel" role="tabpanel" id="rules" aria-labelledby="tab-rules" hidden><h2>Confirmed rules</h2><p class="muted">Only rules confirmed in the extension appear here. Cooperative page metadata is evidence interpreted by confirmed local policy; it is not a rule or approval.</p><div id="rule-list" class="grid"></div></section>
    <section class="panel" role="tabpanel" id="activity" aria-labelledby="tab-activity" hidden><h2>Activity and receipts</h2><div id="activity-list" class="grid"></div></section>
    <section class="panel" role="tabpanel" id="connection" aria-labelledby="tab-connection" hidden><h2>Connection health</h2><div id="connection-state" class="card"></div></section>
  </div>
  <footer>doA2Ai asks only when current authority is missing or uncertain. The service binds terminal digests; it does not claim independent target attestation.</footer>
</main><script src="/control.js"></script></body></html>`;

const PRODUCT_CONTROL_JS = `(() => {
  const PAGE_SOURCE = "doa2ai-control-page";
  const EXTENSION_SOURCE = "doa2ai-control-extension";
  const byId = (id) => document.getElementById(id);
  const pending = new Map();
  let bridgeReady = false;
  let currentSnapshot = null;

  const array = (value) => Array.isArray(value) ? value : [];
  const field = (value, ...names) => { for (const name of names) if (value && value[name] !== undefined && value[name] !== null) return value[name]; return null; };
  const short = (value, fallback = "Unknown") => typeof value === "string" && value.trim() ? value.trim().slice(0, 240) : fallback;
  const empty = (element, message) => { element.replaceChildren(); const p = document.createElement("p"); p.className = "muted"; p.textContent = message; element.append(p); };
  const status = (element, message, kind = "") => { element.className = "status " + kind; element.textContent = message; };

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.source !== EXTENSION_SOURCE) return;
    if (message.type === "ready") { bridgeReady = true; void refresh(); return; }
    if (message.type !== "response" || typeof message.id !== "string") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id); clearTimeout(waiter.timeout);
    if (message.response && message.response.ok) waiter.resolve(message.response.result);
    else waiter.reject(new Error(short(message.response && message.response.error, "Extension bridge request failed.")));
  });

  function bridge(request) {
    if (!bridgeReady) return Promise.reject(new Error("The installed extension bridge is not connected."));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error("Extension bridge timed out.")); }, 15000);
      pending.set(id, { resolve, reject, timeout });
      window.postMessage({ source: PAGE_SOURCE, type: "request", id, request }, location.origin);
    });
  }

  function legacySnapshot(value) {
    return { paired: true, protection: { enabled: true, paused: false }, tasks: [{ taskId: value.session.session_id, label: value.session.source.origin, status: "active", pageBindings: [value.session.source] }], rules: [], activity: [], pending_reviews: array(value.pending_dockets).map((item) => ({ actionId: item.execution_id, summary: item.reason_code, docketId: item.docket_id })), blocked_count: 0, connection: { status: "legacy_v1_connected", service_origin: location.origin, expires_at: value.session.expires_at } };
  }

  async function readSnapshot() {
    try { return await bridge({ operation: "control.snapshot" }); }
    catch (firstError) {
      try { return legacySnapshot(await bridge({ operation: "capabilities" })); }
      catch { throw firstError; }
    }
  }

  function card(title, lines = []) {
    const element = document.createElement("div"); element.className = "card";
    const heading = document.createElement("h3"); heading.textContent = title; element.append(heading);
    for (const line of lines) { const p = document.createElement("p"); p.className = "muted"; p.textContent = line; element.append(p); }
    return element;
  }

  function renderTasks(snapshot) {
    const target = byId("task-list"); target.replaceChildren();
    const tasks = array(snapshot.tasks);
    if (!tasks.length) return empty(target, "No active tasks. Tasks appear when a protected action is first gated.");
    for (const task of tasks) {
      const taskId = short(field(task, "taskId", "task_id"));
      const element = card(short(field(task, "label", "title"), "Bounded task"), [taskId, short(field(task, "status"), "active"), array(field(task, "pageBindings", "page_bindings")).length + " page binding(s)"]);
      target.append(element);
    }
  }

  function renderReviews(snapshot) {
    const target = byId("review-list"); target.replaceChildren();
    const reviews = array(field(snapshot, "pending_reviews", "pendingReviews"));
    byId("review-count").textContent = String(reviews.length);
    if (!reviews.length) return empty(target, "Nothing needs your decision.");
    for (const review of reviews) {
      const actionId = short(field(review, "actionId", "action_id"));
      const taskId = field(review, "taskId", "task_id");
      const element = card(short(field(review, "summary", "label"), "Action needs authority"), [short(field(review, "origin"), "Origin unavailable"), actionId, "Open the installed extension to review the exact action and decide."]);
      target.append(element);
    }
  }

  function renderRules(snapshot) {
    const target = byId("rule-list"); target.replaceChildren(); const rules = array(snapshot.rules);
    if (!rules.length) return empty(target, "No confirmed reusable rules.");
    for (const rule of rules) {
      const tool = short(field(rule, "toolName"), "Bounded tool");
      const origin = short(field(rule, "origin"), "No origin binding");
      target.append(card(tool + " · " + origin, ["Decision: " + short(field(rule, "decision")), "Scope: " + short(field(rule, "scope")), "Expires: " + short(field(rule, "expiresAt"), "When revoked")]));
    }
  }

  function renderActivity(snapshot) {
    const target = byId("activity-list"); target.replaceChildren(); const activity = array(snapshot.activity);
    if (!activity.length) return empty(target, "No recorded activity on this device.");
    for (const item of activity) {
      const element = card(short(field(item, "label"), "Protected action"), ["Outcome: " + short(field(item, "outcome")), "Origin: " + short(field(item, "origin")), "Verification: " + short(field(item, "verification")), "Completed: " + short(field(item, "terminalAt"))]);
      const receipt = field(item, "receipt"); if (receipt) { const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "Receipt JSON"; const pre = document.createElement("pre"); pre.className = "receipt"; pre.textContent = JSON.stringify(receipt, null, 2); details.append(summary, pre); element.append(details); } target.append(element);
    }
  }

  function renderConnection(snapshot) {
    const connection = snapshot.connection || {}; const target = byId("connection-state"); target.replaceChildren();
    for (const line of ["Status: " + short(connection.status), "Service: " + short(field(connection, "service_origin", "serviceOrigin"), location.origin), "Last check: " + short(field(connection, "checked_at")), "Detail: " + short(field(connection, "detail"))]) { const p = document.createElement("p"); p.textContent = line; target.append(p); }
  }

  function render(snapshot) {
    currentSnapshot = snapshot || {}; const paired = snapshot && snapshot.paired !== false;
    byId("onboarding").hidden = paired; byId("workspace").hidden = !paired;
    byId("top-state").textContent = paired ? "Extension connected" : "Extension ready to connect";
    if (!paired) { status(byId("extension-status"), "Extension detected. Open its popup to enable and connect this device.", "ok"); return; }
    const protection = snapshot.protection || {}; const paused = Boolean(protection.paused); status(byId("protection"), paused ? "Paused" : "Active", paused ? "warn" : "ok");
    byId("blocked-count").textContent = String(Number(field(snapshot, "blocked_count", "blockedCount") || 0));
    renderTasks(snapshot); renderReviews(snapshot); renderRules(snapshot); renderActivity(snapshot); renderConnection(snapshot);
  }

  async function refresh() {
    if (!bridgeReady) return;
    try { render(await readSnapshot()); }
    catch (error) { byId("onboarding").hidden = false; byId("workspace").hidden = true; byId("top-state").textContent = "Extension needs attention"; status(byId("extension-status"), error.message, "warn"); }
  }

  for (const tab of document.querySelectorAll('[role="tab"]')) tab.addEventListener("click", () => { for (const other of document.querySelectorAll('[role="tab"]')) { const selected = other === tab; other.setAttribute("aria-selected", String(selected)); byId(other.getAttribute("aria-controls")).hidden = !selected; } });
  const requestedView = new URLSearchParams(location.hash.slice(1)).get("view");
  const requestedTab = byId("tab-" + ({ overview: "tasks", tasks: "tasks", rules: "rules", activity: "activity", connection: "connection" }[requestedView] || "tasks"));
  requestedTab.click();
  byId("refresh").addEventListener("click", refresh);
  setTimeout(() => { if (!bridgeReady) { byId("top-state").textContent = "Extension not detected"; status(byId("extension-status"), "Install or enable the verified doA2Ai Chrome test build, then reload this page.", "warn"); } }, 1500);
})();`;

function controlAsset(path) {
  if (path === "/") return new Response(PRODUCT_CONTROL_HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
  if (path === "/control.js") return new Response(PRODUCT_CONTROL_JS, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
  return null;
}

async function route(request, env) {
  if (!env.DB) throw new Error("Missing DB binding.");
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "GET") {
    const asset = controlAsset(path);
    if (asset) return asset;
  }
  if (["GET", "DELETE"].includes(request.method) && path === "/mcp") {
    return new Response(null, { status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
  }
  if (request.method === "GET" && path === "/healthz") {
    return jsonResponse(request, env, { service: "doa2ai-broker", status: "ok", contract_revision: CONTRACT_REVISION });
  }
  if (request.method === "POST" && path === "/mcp") return handleMcp(request, env);

  if (request.method === "OPTIONS" && (path.startsWith("/v1/") || path.startsWith("/v2/"))) return preflight(request, env);
  if (path.startsWith("/v1/")) requireRestOrigin(request, env);
  if (request.method === "GET" && path === "/v2/status") return jsonResponse(request, env, v2Readiness());
  if (path.startsWith("/v2/")) requireRestOrigin(request, env);

  if (request.method === "POST" && path === "/v2/devices/challenge") return handleV2DeviceChallenge(request, env);
  if (request.method === "POST" && path === "/v2/devices/register") return handleV2DeviceRegister(request, env);
  const v2DeviceStatusMatch = path.match(/^\/v2\/devices\/(dev_[a-f0-9]{48})\/status$/);
  if (request.method === "GET" && v2DeviceStatusMatch) return handleV2DeviceStatus(request, env, v2DeviceStatusMatch[1]);
  const v2DeviceRevokeMatch = path.match(/^\/v2\/devices\/(dev_[a-f0-9]{48})\/revoke$/);
  if (request.method === "POST" && v2DeviceRevokeMatch) return handleV2DeviceRevoke(request, env, v2DeviceRevokeMatch[1]);
  if (request.method === "POST" && path === "/v2/receipts/bind") return handleV2BindReceipt(request, env);
  if (request.method === "POST" && path === "/v2/connections") return handleV2CreateConnection(request, env);
  const v2ConnectionRevokeMatch = path.match(/^\/v2\/connections\/(conn_[a-f0-9]{48})\/revoke$/);
  if (request.method === "POST" && v2ConnectionRevokeMatch) return handleV2RevokeConnection(request, env, v2ConnectionRevokeMatch[1]);

  const controlCapabilitiesMatch = path.match(/^\/v1\/control\/sessions\/(bs_[a-f0-9]{48})\/capabilities$/);
  if (request.method === "GET" && controlCapabilitiesMatch) return controlCapabilities(request, env, controlCapabilitiesMatch[1]);
  const controlActionMatch = path.match(/^\/v1\/control\/sessions\/(bs_[a-f0-9]{48})\/actions$/);
  if (request.method === "POST" && controlActionMatch) return controlAction(request, env, controlActionMatch[1]);
  const controlStatusMatch = path.match(/^\/v1\/control\/sessions\/(bs_[a-f0-9]{48})\/executions\/(exec_[a-f0-9]{48})$/);
  if (request.method === "GET" && controlStatusMatch) return controlStatus(request, env, controlStatusMatch[1], controlStatusMatch[2]);

  if (request.method === "POST" && path === "/v1/browser/sessions") return handleCreateSession(request, env);
  const publishMatch = path.match(/^\/v1\/browser\/sessions\/(bs_[a-f0-9]{48})\/tools$/);
  if (request.method === "PUT" && publishMatch) return handlePublishTools(request, env, publishMatch[1]);
  const commandsMatch = path.match(/^\/v1\/browser\/sessions\/(bs_[a-f0-9]{48})\/commands$/);
  if (request.method === "GET" && commandsMatch) return handlePollCommands(request, env, commandsMatch[1]);
  const resultMatch = path.match(/^\/v1\/browser\/executions\/(exec_[a-f0-9]{48})\/result$/);
  if (request.method === "POST" && resultMatch) return handleBrowserResult(request, env, resultMatch[1]);
  const browserStatusMatch = path.match(/^\/v1\/browser\/executions\/(exec_[a-f0-9]{48})\/status$/);
  if (request.method === "GET" && browserStatusMatch) return handleBrowserStatus(request, env, browserStatusMatch[1]);

  if (request.method === "POST" && path === "/v1/grants") return handleCreateGrant(request, env);
  const revokeMatch = path.match(/^\/v1\/grants\/(grant_[a-f0-9]{48})\/revoke$/);
  if (request.method === "POST" && revokeMatch) return handleRevokeGrant(request, env, revokeMatch[1]);
  const docketMatch = path.match(/^\/v1\/dockets\/(docket_[a-f0-9]{48})$/);
  if (request.method === "GET" && docketMatch) return handleGetDocket(request, env, docketMatch[1]);
  const decisionMatch = path.match(/^\/v1\/dockets\/(docket_[a-f0-9]{48})\/decision$/);
  if (request.method === "POST" && decisionMatch) return handleDocketDecision(request, env, decisionMatch[1]);
  const receiptMatch = path.match(/^\/v1\/receipts\/(exec_[a-f0-9]{48})$/);
  if (request.method === "GET" && receiptMatch) return handleReceipt(request, env, receiptMatch[1]);

  fail(404, "NOT_FOUND", "Route was not found.");
}

export {
  PRODUCT_CONTROL_HTML,
  PRODUCT_CONTROL_JS,
  V1_ROUTE_MANIFEST,
  V2_ROUTE_MANIFEST,
  base64UrlDecode,
  base64UrlEncode,
  canonicalDeviceRequest,
  canonicalJson,
  connectionTokenMatches,
  controlAsset,
  deviceChallengeSigningInput,
  hashConnectionToken,
  p256JwkThumbprint,
  sha256,
  v2Readiness,
  validateP256PublicJwk,
  validateSignedRequestMetadata,
  verifyP256Signature,
  verifySignedDeviceEnvelope,
};

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse(request, env, {
          error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
        }, error.status);
      }
      return jsonResponse(request, env, { error: { code: "INTERNAL_ERROR", message: "The broker could not complete the request." } }, 500);
    }
  },
};
