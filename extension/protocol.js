export const CONTRACT_REVISION = "doa2ai.v1";
export const MAX_TOOL_COUNT = 64;
export const MAX_CATALOG_BYTES = 192 * 1024;
export const MAX_RESULT_BYTES = 192 * 1024;

const MAX_TEXT = 500;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const SCHEMA_KEYS = new Set([
  "type",
  "title",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
]);

function protocolError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonSize(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function cloneJson(value, state = { depth: 0, nodes: 0, seen: new WeakSet() }) {
  state.nodes += 1;
  if (state.nodes > 20_000 || state.depth > 16) throw protocolError("JSON_VALUE_TOO_COMPLEX");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw protocolError("NON_FINITE_JSON_NUMBER");
    return value;
  }
  if (typeof value !== "object") throw protocolError("NON_JSON_VALUE");
  if (state.seen.has(value)) throw protocolError("CYCLIC_JSON_VALUE");
  state.seen.add(value);
  const next = { ...state, depth: state.depth + 1 };
  let copy;
  if (Array.isArray(value)) {
    copy = value.map((entry) => cloneJson(entry, next));
  } else {
    copy = {};
    for (const [key, entry] of Object.entries(value)) copy[key] = cloneJson(entry, next);
  }
  state.nodes = next.nodes;
  state.seen.delete(value);
  return copy;
}

export function cleanText(value, maxLength = MAX_TEXT) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function normalizeServiceUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    throw protocolError("SERVICE_URL_INVALID");
  }
  if (url.protocol !== "https:") throw protocolError("SERVICE_URL_MUST_BE_HTTPS");
  if (url.username || url.password) throw protocolError("SERVICE_URL_CREDENTIALS_FORBIDDEN");
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function serviceOrigin(value) {
  return new URL(normalizeServiceUrl(value)).origin;
}

export function serviceOriginPattern(value) {
  return `${serviceOrigin(value)}/*`;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function normalizeSchema(rawSchema, label = "schema", depth = 0) {
  if (depth > 12 || !isRecord(rawSchema)) throw protocolError("UNSUPPORTED_SCHEMA");
  const schema = cloneJson(rawSchema);
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYS.has(key)) throw protocolError("UNSUPPORTED_SCHEMA_KEY");
  if (!["object", "array", "string", "number", "integer", "boolean", "null"].includes(schema.type)) {
    throw protocolError("UNSUPPORTED_SCHEMA_TYPE");
  }
  if (Object.hasOwn(schema, "enum") && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw protocolError("INVALID_SCHEMA_ENUM");
  }
  if (schema.type === "object") {
    // WebMCP's current examples commonly omit `additionalProperties` even
    // though doA2Ai's protected surface must remain closed. Treat omission as
    // the conservative local default, while continuing to reject an explicit
    // open object (or any other non-false value).
    if (!isRecord(schema.properties) || (Object.hasOwn(schema, "additionalProperties") && schema.additionalProperties !== false)) {
      throw protocolError("OPEN_INPUT_SCHEMA");
    }
    schema.additionalProperties = false;
    const required = schema.required ?? [];
    if (!Array.isArray(required) || required.some((key) => typeof key !== "string" || !Object.hasOwn(schema.properties, key))) {
      throw protocolError("INVALID_SCHEMA_REQUIRED");
    }
    for (const [key, child] of Object.entries(schema.properties)) {
      schema.properties[key] = normalizeSchema(child, `${label}.properties.${key}`, depth + 1);
    }
  } else if (Object.hasOwn(schema, "properties") || Object.hasOwn(schema, "required") || Object.hasOwn(schema, "additionalProperties")) {
    throw protocolError("OBJECT_KEYWORD_ON_NON_OBJECT_SCHEMA");
  }
  if (schema.type === "array") {
    if (!Object.hasOwn(schema, "items")) throw protocolError("ARRAY_SCHEMA_ITEMS_REQUIRED");
    schema.items = normalizeSchema(schema.items, `${label}.items`, depth + 1);
  } else if (Object.hasOwn(schema, "items")) {
    throw protocolError("ARRAY_KEYWORD_ON_NON_ARRAY_SCHEMA");
  }
  return schema;
}

function normalizeAnnotations(value) {
  const annotations = isRecord(value) ? value : {};
  return {
    readOnlyHint: annotations.readOnlyHint === true,
    untrustedContentHint: annotations.untrustedContentHint === true,
    destructiveHint: annotations.destructiveHint === true,
    idempotentHint: annotations.idempotentHint === true,
    openWorldHint: annotations.openWorldHint === true,
  };
}

function decodeSchema(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw protocolError("INVALID_SCHEMA_JSON");
  }
}

export function normalizePageTool(tool = {}, pageOrigin = "") {
  const name = cleanText(tool.name, 128);
  if (!TOOL_NAME.test(name)) throw protocolError("INVALID_TOOL_NAME");
  const expectedOrigin = serviceOrigin(pageOrigin);
  const observedOrigin = tool.origin ? serviceOrigin(tool.origin) : expectedOrigin;
  if (observedOrigin !== expectedOrigin) throw protocolError("CROSS_ORIGIN_TOOL_NOT_ALLOWED");
  const decodedInputSchema = tool.inputSchema === undefined
    ? { type: "object", properties: {}, additionalProperties: false }
    : decodeSchema(tool.inputSchema);
  const inputSchema = normalizeSchema(decodedInputSchema, `${name}.inputSchema`);
  if (inputSchema.type !== "object") throw protocolError("TOOL_INPUT_MUST_BE_OBJECT");
  const outputSchema = tool.outputSchema === undefined
    ? undefined
    : normalizeSchema(decodeSchema(tool.outputSchema), `${name}.outputSchema`);
  return Object.freeze({
    name,
    description: cleanText(tool.description, 4_096),
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    annotations: normalizeAnnotations(tool.annotations),
    origin: observedOrigin,
  });
}

export function normalizeCatalog(tools, pageOrigin) {
  if (!Array.isArray(tools)) throw protocolError("INVALID_TOOL_CATALOG");
  if (tools.length > MAX_TOOL_COUNT) throw protocolError("TOOL_CATALOG_TOO_LARGE");
  const normalized = tools.map((tool) => normalizePageTool(tool, pageOrigin)).sort((left, right) => left.name.localeCompare(right.name));
  const names = new Set();
  for (const tool of normalized) {
    if (names.has(tool.name)) throw protocolError("DUPLICATE_TOOL_NAME");
    names.add(tool.name);
  }
  if (jsonSize(normalized) > MAX_CATALOG_BYTES) throw protocolError("TOOL_CATALOG_TOO_LARGE");
  return Object.freeze(normalized);
}

export function brokerCatalog(catalog) {
  return catalog.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    ...(tool.outputSchema ? { output_schema: tool.outputSchema } : {}),
    annotations: tool.annotations,
  }));
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function catalogRevision(catalog) {
  return sha256Hex({ contract_revision: CONTRACT_REVISION, tools: catalog });
}

function normalizeSource(source) {
  if (!isRecord(source)) throw protocolError("INVALID_COMMAND_SOURCE");
  let url;
  try {
    url = new URL(source.url);
  } catch {
    throw protocolError("INVALID_COMMAND_SOURCE");
  }
  if (url.protocol !== "https:" || url.origin !== source.origin) throw protocolError("INVALID_COMMAND_SOURCE");
  return Object.freeze({ origin: url.origin, url: url.href });
}

export function normalizeCommand(command = {}) {
  if (!isRecord(command)) throw protocolError("INVALID_COMMAND");
  const executionId = cleanText(command.execution_id, 160);
  const actionHash = cleanText(command.action_hash, 64);
  if (!executionId || !HASH.test(actionHash)) throw protocolError("INVALID_COMMAND_BINDING");
  if (!isRecord(command.tool)) throw protocolError("INVALID_COMMAND_TOOL");
  const name = cleanText(command.tool.name, 128);
  const relayName = cleanText(command.tool.relay_name, 160);
  if (!TOOL_NAME.test(name) || !relayName) throw protocolError("INVALID_COMMAND_TOOL");
  if (!isRecord(command.arguments)) throw protocolError("INVALID_COMMAND_ARGUMENTS");
  const args = cloneJson(command.arguments);
  if (jsonSize(args) > MAX_RESULT_BYTES) throw protocolError("COMMAND_ARGUMENTS_TOO_LARGE");
  const deadline = cleanText(command.result_deadline_at, 64);
  if (!Number.isFinite(Date.parse(deadline))) throw protocolError("INVALID_COMMAND_DEADLINE");
  return Object.freeze({
    executionId,
    actionHash,
    source: normalizeSource(command.source),
    tool: Object.freeze({ name, relayName }),
    arguments: args,
    resultDeadlineAt: deadline,
  });
}

export function safePageResult(value) {
  const copy = value === undefined ? null : cloneJson(value);
  if (jsonSize(copy) > MAX_RESULT_BYTES) throw protocolError("PAGE_RESULT_TOO_LARGE");
  return copy;
}

export function brokerResult(actionHash, status, value = undefined) {
  if (!HASH.test(actionHash)) throw protocolError("INVALID_ACTION_HASH");
  if (status === "completed") return { action_hash: actionHash, status, result: safePageResult(value) };
  if (!["failed", "unknown"].includes(status)) throw protocolError("INVALID_RESULT_STATUS");
  const error = isRecord(value) ? value : {};
  return {
    action_hash: actionHash,
    status,
    error: {
      code: cleanText(error.code, 128) || "PAGE_EXECUTION_ERROR",
      message: cleanText(error.message, 4_096),
    },
  };
}
