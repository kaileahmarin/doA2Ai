import { canonicalJson, sha256Hex } from "./protocol.js";

const SECURITY_TERMS = /\b(password|passcode|pin|credential|secret|token|api[ _-]?key|authorization|cookie|private[ _-]?key|card[ _-]?(?:number|pan)|cvv|cvc|sign[ _-]?in|log[ _-]?in|permission|role|access[ _-]?control|security|two[ _-]?factor|2fa|mfa)\b/i;
const DESTRUCTIVE_TERMS = /\b(delete|destroy|erase|wipe|remove[ _-]?account|close[ _-]?account|terminate)\b/i;
const EXTERNAL_TERMS = /\b(send|publish|post|message|email|share|invite|book|reserve|order|checkout|purchase|buy|pay|submit|transfer|trade|commit)\b/i;
const SENSITIVE_TERMS = /\b(address|billing|shipping|email|phone|health|medical|personal|identity|account|profile|location|contact|postal|zip|payment[ _-]?(?:method|handle|reference)|ssn|social[ _-]?security)\b/i;
const HUMAN_PRESENCE_TERMS = /\b(checkout|purchase|buy|pay|payment|submit|place[ _-]?order|confirm[ _-]?(?:order|payment|purchase))\b/i;
const READ_TERMS = /^(read|get|list|find|search|inspect|view|lookup|check|show|fetch|query)(?:[_.-]|$)/i;
const REVERSIBLE_CHANGE_TERMS = /^(add|remove|update|edit|set|select|toggle|save|draft)(?:[_.-]|$)/i;
const SECRET_FIELD = /(?:^|[_-])(password|passcode|pin|token|secret|api[_-]?key|authorization|cookie|credential|private[_-]?key|card[_-]?(?:number|pan)|cvv|cvc)(?:$|[_-])/i;
const PRIVATE_FIELD = /(?:^|_)(address|street|billing|shipping|delivery|contact|email|phone|full_name|first_name|last_name|postal(?:_code)?|zip(?:_code)?|payment_(?:method|handle|reference))(?:$|_)/i;
const REDACTED = "[REDACTED]";
const SIGNATURE_DOMAINS = new Set(["doa2ai.authority-proof.v1", "doa2ai.receipt-signature.v1"]);

function text(value, maximum = 4_096) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}

function semanticFieldKey(value) {
  return typeof value === "string"
    ? value
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase()
    : "";
}

function isSecretField(key) {
  return SECRET_FIELD.test(semanticFieldKey(key));
}

function isPrivateField(key) {
  return PRIVATE_FIELD.test(semanticFieldKey(key));
}

function searchableToolText(tool) {
  const schemaKeys = tool?.inputSchema && typeof tool.inputSchema === "object"
    ? Object.keys(tool.inputSchema.properties ?? {}).map((key) => {
      const semantic = semanticFieldKey(key);
      return `${key} ${semantic} ${semantic.replaceAll("_", " ")}`;
    }).join(" ")
    : "";
  const name = text(tool?.name, 128);
  const semanticName = semanticFieldKey(name);
  return `${name} ${semanticName} ${semanticName.replaceAll("_", " ")} ${text(tool?.description)} ${schemaKeys}`;
}

/**
 * Produces conservative impact evidence from the closed WebMCP definition.
 * It is classification evidence only; policy evaluation remains authoritative.
 */
export function classifyToolImpact(tool) {
  const annotations = tool?.annotations ?? {};
  const searchable = searchableToolText(tool);
  const name = text(tool?.name, 128);
  const humanPresence = HUMAN_PRESENCE_TERMS.test(searchable);
  const credential = SECURITY_TERMS.test(searchable);
  const security = credential || /\b(permission|role|security|access[ _-]?control)\b/i.test(searchable);
  const destructive = annotations.destructiveHint === true || DESTRUCTIVE_TERMS.test(searchable);

  if (credential || security || destructive) {
    return {
      effect: destructive ? "change" : "external",
      reversible: false,
      sensitive_data: credential || security,
      credential,
      security,
      destructive,
      human_presence: humanPresence,
      recipient: "external",
      financial: null,
      source: annotations.destructiveHint === true ? "page_annotation_and_definition" : "tool_definition",
      confidence: "high",
    };
  }

  const sensitive = SENSITIVE_TERMS.test(searchable);
  const external = EXTERNAL_TERMS.test(searchable);
  if (external) {
    return {
      effect: "external",
      reversible: false,
      sensitive_data: sensitive,
      credential: false,
      security: false,
      destructive: false,
      human_presence: humanPresence,
      recipient: "external",
      financial: /\b(order|checkout|purchase|buy|pay|transfer|trade)\b/i.test(searchable)
        ? { amount: 0, currency: "XXX" }
        : null,
      source: "tool_definition",
      confidence: "high",
    };
  }

  if (annotations.readOnlyHint === true && READ_TERMS.test(name) && !sensitive && annotations.openWorldHint !== true) {
    return {
      effect: "read",
      reversible: true,
      sensitive_data: false,
      credential: false,
      security: false,
      destructive: false,
      human_presence: false,
      recipient: "self",
      financial: null,
      source: "page_annotation_and_definition",
      confidence: "high",
    };
  }

  if (REVERSIBLE_CHANGE_TERMS.test(name) && !sensitive && annotations.openWorldHint !== true) {
    return {
      effect: "change",
      reversible: true,
      sensitive_data: false,
      credential: false,
      security: false,
      destructive: false,
      human_presence: false,
      recipient: "self",
      financial: null,
      source: "tool_definition",
      // A page-defined verb is useful impact evidence, but never sufficient
      // on its own for quiet state-changing execution.
      confidence: "low",
    };
  }

  return {
    effect: annotations.readOnlyHint === true ? "read" : "unknown",
    reversible: null,
    sensitive_data: sensitive ? true : null,
    credential: false,
    security: false,
    destructive: false,
    human_presence: humanPresence,
    recipient: "unknown",
    financial: null,
    source: "tool_definition",
    confidence: "low",
  };
}

export async function bindToolDefinition(tool, { origin, documentKey }) {
  const toolDigest = await sha256Hex({
    version: "doa2ai.tool-binding.v1",
    origin,
    documentKey,
    tool,
  });
  return Object.freeze({ ...tool, toolDigest });
}

export async function computeActionDigest({ taskId, connectionId, origin, documentKey, tool, arguments: args }) {
  return sha256Hex({
    version: "doa2ai.action.v1",
    taskId,
    connectionId,
    origin,
    documentKey,
    toolName: tool.name,
    toolDigest: tool.toolDigest,
    arguments: args,
  });
}

export async function computeArgumentsDigest(args) {
  return sha256Hex({ version: "doa2ai.arguments.v1", arguments: args });
}

export function exactImpactRule(impact) {
  const rule = {
    effects: [impact.effect],
    reversible: impact.reversible,
    sensitive_data: impact.sensitive_data,
    credential: impact.credential,
    security: impact.security,
    destructive: impact.destructive,
    human_presence: impact.human_presence === true,
    recipients: [impact.recipient],
  };
  if (impact.financial && impact.financial.currency !== "XXX") {
    rule.max_financial_amount = impact.financial.amount;
    rule.financial_currency = impact.financial.currency;
  }
  return rule;
}

/**
 * Keeps receipt and review structure useful while removing credential-shaped
 * values. `allValues` is reserved for actions already classified as credential
 * or security operations, which must never retain their submitted values.
 */
export function redactSensitiveFields(value, { allValues = false } = {}) {
  const visit = (node, key = "", atRoot = false) => {
    if ((!atRoot && allValues) || isSecretField(key) || isPrivateField(key)) return REDACTED;
    if (Array.isArray(node)) return node.map((entry) => visit(entry, "", false));
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([entryKey, entryValue]) => [
        entryKey,
        visit(entryValue, entryKey, false),
      ]));
    }
    return node;
  };
  return visit(value, "", true);
}

/** Detects credential-shaped argument keys without retaining or inspecting their values. */
export function containsSensitiveFields(value) {
  const visit = (node, key = "", atRoot = false) => {
    if (!atRoot && isSecretField(key)) return true;
    if (Array.isArray(node)) return node.some((entry) => visit(entry, "", false));
    if (node !== null && typeof node === "object") {
      return Object.entries(node).some(([entryKey, entryValue]) => visit(entryValue, entryKey, false));
    }
    return false;
  };
  return visit(value, "", true);
}

/** Detects private checkout/contact fields that may be used once but must not enter durable state. */
export function containsPrivateFields(value) {
  const visit = (node, key = "", atRoot = false) => {
    if (!atRoot && isPrivateField(key)) return true;
    if (Array.isArray(node)) return node.some((entry) => visit(entry, "", false));
    if (node !== null && typeof node === "object") {
      return Object.entries(node).some(([entryKey, entryValue]) => visit(entryValue, entryKey, false));
    }
    return false;
  };
  return visit(value, "", true);
}

export function receiptSigningPayload(receipt) {
  const { deviceSignature: _signature, serviceBinding: _binding, receiptDigest: _digest, ...payload } = receipt;
  return payload;
}

function decodeBase64url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("INVALID_SIGNATURE_ENCODING");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signerThumbprint(publicJwk, cryptoImpl) {
  const input = new TextEncoder().encode(canonicalJson({ version: "doa2ai.device-key.v1", publicJwk }));
  const digest = new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", input));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validSigner(signer) {
  const jwk = signer?.publicJwk;
  return signer?.algorithm === "ECDSA_P256_SHA256"
    && typeof signer.deviceId === "string" && signer.deviceId.length >= 8 && signer.deviceId.length <= 160
    && /^[a-f0-9]{64}$/.test(signer.keyThumbprint || "")
    && jwk?.kty === "EC" && jwk.crv === "P-256" && typeof jwk.x === "string" && typeof jwk.y === "string"
    && jwk.d === undefined;
}

export async function verifyDeviceStatement({ domain, input, signature, signer } = {}, cryptoImpl = globalThis.crypto) {
  try {
    if (!SIGNATURE_DOMAINS.has(domain) || typeof input !== "string" || !input || !validSigner(signer) || !cryptoImpl?.subtle) return false;
    if (await signerThumbprint(signer.publicJwk, cryptoImpl) !== signer.keyThumbprint) return false;
    const signatureBytes = decodeBase64url(signature);
    if (signatureBytes.byteLength !== 64) return false;
    const publicKey = await cryptoImpl.subtle.importKey(
      "jwk",
      signer.publicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await cryptoImpl.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signatureBytes,
      new TextEncoder().encode(`${domain}\n${input}`),
    );
  } catch {
    return false;
  }
}

export async function verifyLocalReceipt(receipt, cryptoImpl = globalThis.crypto) {
  try {
    if (!receipt || typeof receipt !== "object" || typeof receipt.receiptDigest !== "string") return false;
    const payload = receiptSigningPayload(receipt);
    const digestInput = new TextEncoder().encode(canonicalJson({ version: "doa2ai.receipt.v1", payload }));
    const digestBytes = new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", digestInput));
    const digest = [...digestBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (digest !== receipt.receiptDigest) return false;
    const signatureBase = canonicalJson({ version: "doa2ai.receipt-signature.v1", receiptDigest: digest, payload });
    return verifyDeviceStatement({
      domain: "doa2ai.receipt-signature.v1",
      input: signatureBase,
      signature: receipt.deviceSignature,
      signer: receipt.signer,
    }, cryptoImpl);
  } catch {
    return false;
  }
}

export async function finalizeLocalReceipt(receipt, signText) {
  const payload = receiptSigningPayload(receipt);
  const receiptDigest = await sha256Hex({ version: "doa2ai.receipt.v1", payload });
  const signatureBase = canonicalJson({ version: "doa2ai.receipt-signature.v1", receiptDigest, payload });
  const deviceSignature = typeof signText === "function" ? await signText(signatureBase) : null;
  return Object.freeze({ ...receipt, receiptDigest, deviceSignature });
}
