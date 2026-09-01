import { createHash } from "node:crypto";

const CONTRACT_REVISION = "0.1";
const AUTHORITY_MODE = "transaction_authorized";
const OPERATION = "inventoryAdjustQuantities";
const QUANTITY_NAME = "available";
const REASON = "correction";
const DEFAULT_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const SIGNAL_FRESHNESS_MS = 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_FUTURE_SKEW_MS = 60 * 1000;
const MAX_OPERATION_EVIDENCE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const CONFIRMED_OUTCOMES = new Set([
  "committed_exact",
  "committed_divergent",
  "confirmed_nonexecution",
]);
const FAULT_POSITIONS = Object.freeze({
  before_lineage_timeout: "before_executable_lineage",
  revoke_authority_before_dispatch: "after_reservation_before_dispatch",
  drop_response_after_effect: "after_target_effect_before_response",
  post_dispatch_timeout: "after_dispatch_before_response",
  duplicate_response: "response_delivery",
  divergent_effect: "inside_protected_commit",
  reconcile_override: "reconciliation_evidence",
  webhook_mutation_attempt: "webhook_intake",
});

class HarnessError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "NetworkConformanceHarnessError";
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new HarnessError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateClosedJson(value, path = "$", seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("NON_JSON_VALUE", `${path} must be a finite JSON number.`, { path });
    return;
  }
  if (typeof value !== "object") fail("NON_JSON_VALUE", `${path} contains a non-JSON value.`, { path });
  if (seen.has(value)) fail("CYCLIC_VALUE", `${path} contains a cycle.`, { path });
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) fail("SPARSE_ARRAY", `${path} must not contain array holes.`, { path });
      validateClosedJson(value[index], `${path}[${index}]`, seen);
    }
    seen.delete(value);
    return;
  }

  if (!isPlainObject(value)) fail("NON_PLAIN_OBJECT", `${path} must be a plain JSON object.`, { path });
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("SYMBOL_KEY", `${path} contains a symbol key.`, { path });
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail("ACCESSOR_OR_HIDDEN_FIELD", `${path}.${key} must be an enumerable data field.`, {
        path: `${path}.${key}`,
      });
    }
    validateClosedJson(descriptor.value, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function detached(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function assertClosedObject(value, path, keys) {
  if (!isPlainObject(value)) fail("INVALID_SHAPE", `${path} must be an object.`, { path });
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      fail("UNKNOWN_FIELD", `${path}.${key} is outside the closed trial envelope.`, {
        path: `${path}.${key}`,
      });
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      fail("MISSING_FIELD", `${path}.${key} is required.`, { path: `${path}.${key}` });
    }
  }
}

function assertNonEmptyString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("INVALID_STRING", `${path} must be a non-empty string.`, { path });
  }
}

function assertIsoTime(value, path) {
  assertNonEmptyString(value, path);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail("INVALID_TIMESTAMP", `${path} must be a canonical ISO timestamp.`, { path });
  }
  return timestamp;
}

function assertSafeInteger(value, path) {
  if (!Number.isSafeInteger(value)) fail("INVALID_INTEGER", `${path} must be a safe integer.`, { path });
}

function diffValues(expected, actual, path = "") {
  if (canonicalJson(expected) === canonicalJson(actual)) return [];
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    return keys.flatMap((key) => {
      const expectedPresent = Object.hasOwn(expected, key);
      const actualPresent = Object.hasOwn(actual, key);
      const field = path ? `${path}.${key}` : key;
      if (!expectedPresent || !actualPresent) {
        return [{
          field,
          expected: expectedPresent ? detached(expected[key]) : null,
          actual: actualPresent ? detached(actual[key]) : null,
          expected_present: expectedPresent,
          actual_present: actualPresent,
        }];
      }
      return diffValues(expected[key], actual[key], field);
    });
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    const differences = [];
    for (let index = 0; index < length; index += 1) {
      const expectedPresent = index < expected.length;
      const actualPresent = index < actual.length;
      const field = `${path}[${index}]`;
      if (!expectedPresent || !actualPresent) {
        differences.push({
          field,
          expected: expectedPresent ? detached(expected[index]) : null,
          actual: actualPresent ? detached(actual[index]) : null,
          expected_present: expectedPresent,
          actual_present: actualPresent,
        });
      } else {
        differences.push(...diffValues(expected[index], actual[index], field));
      }
    }
    return differences;
  }
  return [{ field: path, expected: detached(expected), actual: detached(actual) }];
}

function validateEnvelope(rawEnvelope) {
  validateClosedJson(rawEnvelope);
  const envelope = detached(rawEnvelope);
  assertClosedObject(envelope, "$", [
    "contract_revision",
    "execution_id",
    "authority_mode",
    "claim_ref",
    "claim_binding",
    "target_context",
    "audience",
    "action",
    "deadline",
  ]);

  for (const key of ["contract_revision", "execution_id", "authority_mode", "claim_ref", "deadline"]) {
    assertNonEmptyString(envelope[key], `$.${key}`);
  }

  assertClosedObject(envelope.claim_binding, "$.claim_binding", [
    "action_binding",
    "target_binding",
    "audience",
    "validity",
  ]);
  for (const key of ["action_binding", "target_binding", "audience"]) {
    assertNonEmptyString(envelope.claim_binding[key], `$.claim_binding.${key}`);
  }
  assertClosedObject(envelope.claim_binding.validity, "$.claim_binding.validity", ["not_before", "expires_at"]);
  const notBefore = assertIsoTime(envelope.claim_binding.validity.not_before, "$.claim_binding.validity.not_before");
  const expiresAt = assertIsoTime(envelope.claim_binding.validity.expires_at, "$.claim_binding.validity.expires_at");
  if (notBefore >= expiresAt) fail("INVALID_VALIDITY", "The claim validity interval must be increasing.");

  assertClosedObject(envelope.target_context, "$.target_context", [
    "trial_provider",
    "development_store",
    "api_version",
    "inventory_level",
    "inventory_item",
    "location",
  ]);
  for (const key of Object.keys(envelope.target_context)) {
    assertNonEmptyString(envelope.target_context[key], `$.target_context.${key}`);
  }

  assertClosedObject(envelope.audience, "$.audience", [
    "protected_adapter",
    "operation",
    "issuer",
    "tenant",
    "account",
  ]);
  for (const key of Object.keys(envelope.audience)) {
    assertNonEmptyString(envelope.audience[key], `$.audience.${key}`);
  }

  assertClosedObject(envelope.action, "$.action", [
    "operation",
    "quantity_name",
    "changes",
    "reason",
    "reference_document_uri",
    "ledger_document_uri",
    "expected_effect",
  ]);
  for (const key of ["operation", "quantity_name", "reason", "reference_document_uri"]) {
    assertNonEmptyString(envelope.action[key], `$.action.${key}`);
  }
  if (!Array.isArray(envelope.action.changes)) {
    fail("INVALID_CHANGES", "$.action.changes must be an array.", { path: "$.action.changes" });
  }
  if (envelope.action.changes.length !== 1) {
    fail("INVALID_CHANGE_CARDINALITY", "The trial envelope requires exactly one change.", {
      path: "$.action.changes",
      count: envelope.action.changes.length,
    });
  }
  const change = envelope.action.changes[0];
  assertClosedObject(change, "$.action.changes[0]", [
    "inventory_item",
    "location",
    "delta",
    "change_from_quantity",
  ]);
  assertNonEmptyString(change.inventory_item, "$.action.changes[0].inventory_item");
  assertNonEmptyString(change.location, "$.action.changes[0].location");
  assertSafeInteger(change.delta, "$.action.changes[0].delta");
  if (change.delta === 0) fail("INVALID_DELTA", "The synthetic fixture delta must be non-zero.");
  if (change.change_from_quantity === null) {
    fail("NULL_CONDITIONAL", "change_from_quantity must be non-null.", {
      path: "$.action.changes[0].change_from_quantity",
    });
  }
  assertSafeInteger(change.change_from_quantity, "$.action.changes[0].change_from_quantity");

  assertClosedObject(envelope.action.expected_effect, "$.action.expected_effect", [
    "available_before",
    "available_after",
    "on_hand_before",
    "on_hand_after",
  ]);
  for (const key of Object.keys(envelope.action.expected_effect)) {
    assertSafeInteger(envelope.action.expected_effect[key], `$.action.expected_effect.${key}`);
  }

  const deadline = assertIsoTime(envelope.deadline, "$.deadline");
  if (deadline > expiresAt) fail("DEADLINE_OUTSIDE_AUTHORITY", "The deadline exceeds the claim validity window.");

  const actionDigest = digest(envelope.action);
  const fixed = [
    [envelope.contract_revision, CONTRACT_REVISION, "$.contract_revision", "UNSUPPORTED_REVISION"],
    [envelope.authority_mode, AUTHORITY_MODE, "$.authority_mode", "UNSUPPORTED_AUTHORITY_MODE"],
    [envelope.action.operation, OPERATION, "$.action.operation", "UNSUPPORTED_OPERATION"],
    [envelope.action.quantity_name, QUANTITY_NAME, "$.action.quantity_name", "UNSUPPORTED_QUANTITY_NAME"],
    [envelope.action.reason, REASON, "$.action.reason", "UNSUPPORTED_REASON"],
  ];
  for (const [actual, expected, path, code] of fixed) {
    if (actual !== expected) {
      fail(code, `${path} must be ${JSON.stringify(expected)} for this synthetic trial revision.`, {
        path,
        expected,
        actual,
        candidate_action_digest: actionDigest,
      });
    }
  }
  if (envelope.action.ledger_document_uri !== null) {
    fail("LEDGER_NULL_POLICY", "ledger_document_uri must be explicitly null.", {
      path: "$.action.ledger_document_uri",
      candidate_action_digest: actionDigest,
    });
  }

  const crossBindings = [
    [envelope.claim_binding.audience, envelope.audience.protected_adapter, "$.claim_binding.audience"],
    [envelope.audience.operation, envelope.action.operation, "$.audience.operation"],
    [change.inventory_item, envelope.target_context.inventory_item, "$.action.changes[0].inventory_item"],
    [change.location, envelope.target_context.location, "$.action.changes[0].location"],
    [change.change_from_quantity, envelope.action.expected_effect.available_before, "$.action.changes[0].change_from_quantity"],
  ];
  for (const [actual, expected, path] of crossBindings) {
    if (actual !== expected) {
      fail("INTERNAL_BINDING_MISMATCH", `${path} does not match its closed-envelope binding.`, {
        path,
        expected,
        actual,
        candidate_action_digest: actionDigest,
      });
    }
  }

  return envelope;
}

export async function bindExecutionEnvelope(rawEnvelope) {
  const envelope = validateEnvelope(rawEnvelope);
  const actionDigest = digest(envelope.action);
  const targetDigest = digest(envelope.target_context);
  const audienceDigest = digest(envelope.audience);
  const executionBindingDigest = digest({
    contract_revision: envelope.contract_revision,
    execution_id: envelope.execution_id,
    authority_mode: envelope.authority_mode,
    claim_ref: envelope.claim_ref,
    claim_binding: envelope.claim_binding,
    target_context: envelope.target_context,
    audience: envelope.audience,
    action: envelope.action,
    deadline: envelope.deadline,
  });

  return deepFreeze({
    kind: "synthetic_network_conformance_binding",
    envelope,
    action_digest: actionDigest,
    target_digest: targetDigest,
    audience_digest: audienceDigest,
    execution_binding_digest: executionBindingDigest,
    redacted_preimage: {
      contract_revision: envelope.contract_revision,
      execution_id: envelope.execution_id,
      authority_mode: envelope.authority_mode,
      claim_ref: envelope.claim_ref,
      action_digest: actionDigest,
      target_digest: targetDigest,
      audience_digest: audienceDigest,
      deadline: envelope.deadline,
    },
    normalized_request: {
      operation: OPERATION,
      idempotency_key: envelope.execution_id,
      input: {
        name: QUANTITY_NAME,
        reason: REASON,
        referenceDocumentUri: envelope.action.reference_document_uri,
        ledgerDocumentUri: null,
        changes: envelope.action.changes.map((entry) => ({
          inventoryItemId: entry.inventory_item,
          locationId: entry.location,
          delta: entry.delta,
          changeFromQuantity: entry.change_from_quantity,
        })),
      },
    },
  });
}

function makeResult({ executionId, outcome, dispatchStatus, reasonCode = null, evidence = null, differences = [] }) {
  return deepFreeze({
    execution_id: executionId ?? null,
    outcome,
    dispatch_status: dispatchStatus,
    reason_code: reasonCode,
    evidence: evidence ? detached(evidence) : null,
    differences: detached(differences),
  });
}

function mapValues(map) {
  return [...map.values()].map(detached);
}

function recordLineageEvent(lineage, event) {
  lineage.events.push(detached(event));
}

function addAnomaly(lineage, anomaly) {
  lineage.anomalies.push(detached(anomaly));
  recordLineageEvent(lineage, { type: "anomaly", ...anomaly });
}

export function createNetworkConformanceHarness({
  authorizedBinding,
  initialInventory,
  targetContext,
  startTime = "2026-08-28T16:00:00.000Z",
  idempotencyWindowMs = DEFAULT_IDEMPOTENCY_WINDOW_MS,
  verifyTestSignal,
} = {}) {
  if (authorizedBinding?.kind !== "synthetic_network_conformance_binding") {
    throw new TypeError("authorizedBinding must come from bindExecutionEnvelope().");
  }
  validateClosedJson(initialInventory, "$.initialInventory");
  assertClosedObject(initialInventory, "$.initialInventory", ["available", "on_hand"]);
  assertSafeInteger(initialInventory.available, "$.initialInventory.available");
  assertSafeInteger(initialInventory.on_hand, "$.initialInventory.on_hand");
  if (!Number.isSafeInteger(idempotencyWindowMs) || idempotencyWindowMs <= 0) {
    throw new TypeError("idempotencyWindowMs must be a positive safe integer.");
  }
  if (verifyTestSignal !== undefined && typeof verifyTestSignal !== "function") {
    throw new TypeError("verifyTestSignal must be a function when provided.");
  }

  const authorized = detached(authorizedBinding);
  const context = detached(targetContext ?? authorized.envelope.target_context);
  if (canonicalJson(context) !== canonicalJson(authorized.envelope.target_context)) {
    throw new TypeError("targetContext must equal the authorized target context.");
  }
  let nowMs = assertIsoTime(startTime, "$.startTime");
  const inventory = detached(initialInventory);
  const authority = {
    claim_ref: authorized.envelope.claim_ref,
    state: "available",
    reserved_execution_id: null,
    reservation_count: 0,
    consumption_count: 0,
    revoked: false,
    log: [],
  };
  const idempotencyRecords = new Map();
  const operationRecords = new Map();
  const lineages = new Map();
  const acceptedDeliveryIds = new Set();
  const scheduledFaults = [];
  const commitMutationCapability = Symbol("synthetic-commit-mutation-capability");
  const ledgers = {
    gateway_attempts: [],
    rejections: [],
    dispatches: [],
    acceptances: [],
    response_deliveries: [],
    protected_effects: [],
    external_writes: [],
    current_state_observations: [],
    reconciliations: [],
    signals: [],
    anomalies: [],
    faults: [],
    bypass_attempts: [],
  };

  function nowIso() {
    return new Date(nowMs).toISOString();
  }

  function takeFault(type) {
    const index = scheduledFaults.findIndex((fault) => fault.type === type);
    if (index === -1) return null;
    const [fault] = scheduledFaults.splice(index, 1);
    const applied = {
      ...detached(fault),
      event: "applied",
      applied_at: nowIso(),
      protected_effect_count: ledgers.protected_effects.length,
    };
    ledgers.faults.push(applied);
    return fault;
  }

  function lineageFor(binding) {
    const executionId = binding.envelope.execution_id;
    if (!lineages.has(executionId)) {
      lineages.set(executionId, {
        execution_id: executionId,
        binding_digest: binding.execution_binding_digest,
        outcome: null,
        dispatch_status: "not_dispatched",
        response_may_be_lost: false,
        events: [],
        anomalies: [],
        evidence: [],
      });
    }
    return lineages.get(executionId);
  }

  function transitionLineage(lineage, outcome, event) {
    const previous = lineage.outcome;
    if (previous && CONFIRMED_OUTCOMES.has(previous)) {
      if (outcome !== previous) {
        const anomaly = {
          code: "CONFIRMED_OUTCOME_CONFLICT",
          previous,
          proposed: outcome,
          observed_at: nowIso(),
        };
        addAnomaly(lineage, anomaly);
        ledgers.anomalies.push({ execution_id: lineage.execution_id, ...anomaly });
      } else {
        recordLineageEvent(lineage, event);
      }
      return lineage.outcome;
    }
    if (previous === "unknown" && !CONFIRMED_OUTCOMES.has(outcome) && outcome !== "unknown") {
      const anomaly = {
        code: "NON_DISCRIMINATING_TRANSITION_BLOCKED",
        previous,
        proposed: outcome,
        observed_at: nowIso(),
      };
      addAnomaly(lineage, anomaly);
      ledgers.anomalies.push({ execution_id: lineage.execution_id, ...anomaly });
      return lineage.outcome;
    }
    lineage.outcome = outcome;
    recordLineageEvent(lineage, event);
    return outcome;
  }

  function localRejection(rawEnvelope, error) {
    const executionId = typeof rawEnvelope?.execution_id === "string" ? rawEnvelope.execution_id : null;
    const entry = {
      execution_id: executionId,
      rejected_at: nowIso(),
      reason_code: error?.code ?? "CLOSED_ENVELOPE_INVALID",
      path: error?.path ?? null,
      candidate_action_digest: error?.candidate_action_digest ?? null,
    };
    ledgers.rejections.push(entry);
    const fixedPolicyDivergence = new Set([
      "UNSUPPORTED_QUANTITY_NAME",
      "UNSUPPORTED_REASON",
      "LEDGER_NULL_POLICY",
      "INTERNAL_BINDING_MISMATCH",
    ]).has(entry.reason_code);
    return makeResult({
      executionId,
      outcome: fixedPolicyDivergence ? "preflight_divergent" : "preflight_rejected",
      dispatchStatus: "not_dispatched",
      reasonCode: entry.reason_code,
      evidence: entry,
      differences: error?.path ? [{ field: error.path, expected: error.expected ?? null, actual: error.actual ?? null }] : [],
    });
  }

  function reserveAuthority(binding) {
    const executionId = binding.envelope.execution_id;
    const validFrom = Date.parse(binding.envelope.claim_binding.validity.not_before);
    const expiresAt = Date.parse(binding.envelope.claim_binding.validity.expires_at);
    if (authority.revoked || nowMs < validFrom || nowMs >= expiresAt) {
      return { ok: false, reason: authority.revoked ? "AUTHORITY_REVOKED" : "AUTHORITY_EXPIRED" };
    }
    if (authority.state === "available") {
      authority.state = "reserved";
      authority.reserved_execution_id = executionId;
      authority.reservation_count += 1;
      authority.log.push({
        state: "reserved",
        execution_id: executionId,
        binding_digest: binding.execution_binding_digest,
        target_digest: binding.target_digest,
        audience_digest: binding.audience_digest,
        at: nowIso(),
      });
      return { ok: true };
    }
    if (authority.reserved_execution_id === executionId && ["reserved", "consumed"].includes(authority.state)) {
      return { ok: true };
    }
    return { ok: false, reason: "AUTHORITY_UNAVAILABLE" };
  }

  function consumeAuthority(executionId) {
    if (authority.state === "consumed" && authority.reserved_execution_id === executionId) return;
    if (authority.state !== "reserved" || authority.reserved_execution_id !== executionId) {
      fail("AUTHORITY_LIFECYCLE_VIOLATION", "Authority must be reserved for this execution before consumption.");
    }
    authority.state = "consumed";
    authority.consumption_count += 1;
    authority.log.push({
      state: "consumed",
      execution_id: executionId,
      binding_digest: authorized.execution_binding_digest,
      target_digest: authorized.target_digest,
      audience_digest: authorized.audience_digest,
      at: nowIso(),
    });
  }

  function makeOperationRecord(binding, outcome, committedState, effectReference = null) {
    return {
      schema_revision: "synthetic-operation-record/0.1",
      execution_id: binding.envelope.execution_id,
      binding_digest: binding.execution_binding_digest,
      target_digest: binding.target_digest,
      audience_digest: binding.audience_digest,
      authenticity: "fixture_authenticated",
      observed_at: nowIso(),
      fresh_until: new Date(nowMs + (7 * 24 * 60 * 60 * 1000)).toISOString(),
      outcome,
      effect_reference: effectReference,
      committed_state: committedState ? detached(committedState) : null,
    };
  }

  function applyProtectedMutation(capability, binding) {
    if (capability !== commitMutationCapability) {
      const entry = {
        attempted_at: nowIso(),
        code: "ALTERNATE_MUTATION_PATH_BLOCKED",
        protected_effect_count: ledgers.protected_effects.length,
        boundary: "non_commit_fault_helper",
      };
      ledgers.bypass_attempts.push(entry);
      fail(
        "ALTERNATE_MUTATION_PATH_BLOCKED",
        "Only commitGateway.commit() holds the synthetic target mutation capability.",
      );
    }
    const executionId = binding.envelope.execution_id;
    const change = binding.envelope.action.changes[0];
    const before = detached(inventory);
    ledgers.acceptances.push({ execution_id: executionId, accepted_at: nowIso() });

    if (inventory.available !== change.change_from_quantity) {
      const record = makeOperationRecord(binding, "preflight_rejected", null);
      operationRecords.set(executionId, record);
      return {
        outcome: "preflight_rejected",
        reason_code: "STALE_EXPECTED_QUANTITY",
        evidence: record,
      };
    }

    const divergentFault = takeFault("divergent_effect");
    const availableDelta = divergentFault?.available_delta ?? change.delta;
    const onHandDelta = divergentFault?.on_hand_delta ?? change.delta;
    inventory.available += availableDelta;
    inventory.on_hand += onHandDelta;
    const after = detached(inventory);
    const expected = binding.envelope.action.expected_effect;
    const exact = before.available === expected.available_before
      && before.on_hand === expected.on_hand_before
      && after.available === expected.available_after
      && after.on_hand === expected.on_hand_after;
    const outcome = exact ? "committed_exact" : "committed_divergent";
    const effectReference = `synthetic-effect:${executionId}:1`;
    const effect = {
      effect_reference: effectReference,
      execution_id: executionId,
      operation: OPERATION,
      inventory_item: change.inventory_item,
      location: change.location,
      delta: change.delta,
      applied_available_delta: availableDelta,
      applied_on_hand_delta: onHandDelta,
      before,
      after,
      applied_at: nowIso(),
    };
    ledgers.protected_effects.push(effect);
    const record = makeOperationRecord(binding, outcome, after, effectReference);
    operationRecords.set(executionId, record);
    return { outcome, reason_code: null, evidence: record };
  }

  function deliverTargetResult(lineage, targetResult, { retry = false } = {}) {
    const delivery = {
      execution_id: lineage.execution_id,
      delivered_at: nowIso(),
      retry,
      outcome: targetResult.outcome,
    };
    ledgers.response_deliveries.push(delivery);
    if (takeFault("duplicate_response")) ledgers.response_deliveries.push({ ...delivery, duplicate: true });
    lineage.dispatch_status = "response_received";
    lineage.response_may_be_lost = false;
    transitionLineage(lineage, targetResult.outcome, {
      type: "target_response",
      observed_at: nowIso(),
      outcome: targetResult.outcome,
      retry,
    });
    if (targetResult.evidence) lineage.evidence.push(detached(targetResult.evidence));
    return makeResult({
      executionId: lineage.execution_id,
      outcome: lineage.outcome,
      dispatchStatus: lineage.dispatch_status,
      reasonCode: targetResult.reason_code,
      evidence: targetResult.evidence,
    });
  }

  async function commit(rawEnvelope) {
    const attemptedExecutionId = typeof rawEnvelope?.execution_id === "string" ? rawEnvelope.execution_id : null;
    ledgers.gateway_attempts.push({ execution_id: attemptedExecutionId, attempted_at: nowIso() });

    if (takeFault("before_lineage_timeout")) {
      return makeResult({
        executionId: attemptedExecutionId,
        outcome: "pre_adapter_not_attempted",
        dispatchStatus: "not_dispatched",
        reasonCode: "FIXTURE_TIMEOUT_BEFORE_EXECUTABLE_LINEAGE",
        evidence: { local_dispatch_proof: true, observed_at: nowIso() },
      });
    }

    let binding;
    try {
      binding = await bindExecutionEnvelope(rawEnvelope);
    } catch (error) {
      return localRejection(rawEnvelope, error);
    }

    if (binding.execution_binding_digest !== authorized.execution_binding_digest) {
      const differences = diffValues(authorized.envelope, binding.envelope);
      const conflict = idempotencyRecords.has(binding.envelope.execution_id);
      const entry = {
        execution_id: binding.envelope.execution_id,
        rejected_at: nowIso(),
        reason_code: conflict ? "EXECUTION_ID_BINDING_CONFLICT" : "AUTHORIZED_BINDING_DIVERGENCE",
        differences,
        authorized_binding_digest: authorized.execution_binding_digest,
        candidate_binding_digest: binding.execution_binding_digest,
      };
      ledgers.rejections.push(entry);
      return makeResult({
        executionId: binding.envelope.execution_id,
        outcome: "preflight_divergent",
        dispatchStatus: "not_dispatched",
        reasonCode: entry.reason_code,
        evidence: entry,
        differences,
      });
    }

    const validityNotBefore = Date.parse(binding.envelope.claim_binding.validity.not_before);
    const validityExpiresAt = Date.parse(binding.envelope.claim_binding.validity.expires_at);
    if (authority.revoked || nowMs < validityNotBefore || nowMs >= validityExpiresAt) {
      const reasonCode = authority.revoked ? "AUTHORITY_REVOKED" : "AUTHORITY_EXPIRED";
      const invalidAuthorityLineage = lineageFor(binding);
      transitionLineage(invalidAuthorityLineage, "pre_adapter_not_attempted", {
        type: "authority_rejection",
        observed_at: nowIso(),
        reason_code: reasonCode,
      });
      return makeResult({
        executionId: binding.envelope.execution_id,
        outcome: "pre_adapter_not_attempted",
        dispatchStatus: "not_dispatched",
        reasonCode,
      });
    }

    if (nowMs >= Date.parse(binding.envelope.deadline)) {
      const entry = {
        execution_id: binding.envelope.execution_id,
        rejected_at: nowIso(),
        reason_code: "ENVELOPE_DEADLINE_REACHED",
        deadline: binding.envelope.deadline,
      };
      ledgers.rejections.push(entry);
      return makeResult({
        executionId: binding.envelope.execution_id,
        outcome: "pre_adapter_not_attempted",
        dispatchStatus: "not_dispatched",
        reasonCode: entry.reason_code,
        evidence: entry,
      });
    }

    const executionId = binding.envelope.execution_id;
    const lineage = lineageFor(binding);
    const reservation = reserveAuthority(binding);
    if (!reservation.ok) {
      transitionLineage(lineage, "pre_adapter_not_attempted", {
        type: "authority_rejection",
        observed_at: nowIso(),
        reason_code: reservation.reason,
      });
      return makeResult({
        executionId,
        outcome: "pre_adapter_not_attempted",
        dispatchStatus: "not_dispatched",
        reasonCode: reservation.reason,
      });
    }

    if (takeFault("revoke_authority_before_dispatch")) {
      authority.revoked = true;
      authority.log.push({ state: "revoked_while_reserved", execution_id: executionId, at: nowIso() });
      transitionLineage(lineage, "pre_adapter_not_attempted", {
        type: "authority_rejection",
        observed_at: nowIso(),
        reason_code: "AUTHORITY_REVOKED_BEFORE_DISPATCH",
      });
      return makeResult({
        executionId,
        outcome: "pre_adapter_not_attempted",
        dispatchStatus: "not_dispatched",
        reasonCode: "AUTHORITY_REVOKED_BEFORE_DISPATCH",
      });
    }

    const existing = idempotencyRecords.get(executionId);
    if (existing) {
      if (binding.execution_binding_digest !== existing.binding_digest) {
        return makeResult({
          executionId,
          outcome: "preflight_divergent",
          dispatchStatus: "not_dispatched",
          reasonCode: "EXECUTION_ID_BINDING_CONFLICT",
        });
      }
      if (nowMs >= existing.deadline_ms) {
        return makeResult({
          executionId,
          outcome: "preflight_rejected",
          dispatchStatus: "not_dispatched",
          reasonCode: "IDEMPOTENCY_DEADLINE_REACHED",
          evidence: { deadline: new Date(existing.deadline_ms).toISOString(), observed_at: nowIso() },
        });
      }
      if (lineage.response_may_be_lost || lineage.outcome === "unknown") {
        return makeResult({
          executionId,
          outcome: "unknown",
          dispatchStatus: lineage.dispatch_status,
          reasonCode: "UNRESOLVED_LINEAGE_RETRY_BLOCKED",
        });
      }

      ledgers.dispatches.push({
        execution_id: executionId,
        binding_digest: binding.execution_binding_digest,
        dispatched_at: nowIso(),
        retry: true,
      });
      if (existing.status === "in_progress") {
        return makeResult({
          executionId,
          outcome: "unknown",
          dispatchStatus: "dispatched_in_progress",
          reasonCode: "EXECUTION_IN_PROGRESS",
        });
      }
      return deliverTargetResult(lineage, existing.target_result, { retry: true });
    }

    consumeAuthority(executionId);
    lineage.dispatch_status = "dispatched";
    recordLineageEvent(lineage, { type: "commit_dispatch", observed_at: nowIso() });
    ledgers.dispatches.push({
      execution_id: executionId,
      binding_digest: binding.execution_binding_digest,
      dispatched_at: nowIso(),
      retry: false,
    });
    const idempotencyRecord = {
      execution_id: executionId,
      binding_digest: binding.execution_binding_digest,
      first_dispatched_at: nowIso(),
      deadline_ms: nowMs + idempotencyWindowMs,
      deadline: new Date(nowMs + idempotencyWindowMs).toISOString(),
      status: "in_progress",
      target_result: null,
    };
    idempotencyRecords.set(executionId, idempotencyRecord);

    await Promise.resolve();
    const targetResult = applyProtectedMutation(commitMutationCapability, binding);
    idempotencyRecord.status = "complete";
    idempotencyRecord.target_result = detached(targetResult);

    const responseLoss = takeFault("drop_response_after_effect") ?? takeFault("post_dispatch_timeout");
    if (responseLoss) {
      lineage.dispatch_status = "response_unknown";
      lineage.response_may_be_lost = true;
      transitionLineage(lineage, "unknown", {
        type: "response_unknown",
        observed_at: nowIso(),
        reason_code: responseLoss.type === "post_dispatch_timeout"
          ? "POST_DISPATCH_TIMEOUT"
          : "TARGET_RESPONSE_LOST",
      });
      return makeResult({
        executionId,
        outcome: "unknown",
        dispatchStatus: "response_unknown",
        reasonCode: responseLoss.type === "post_dispatch_timeout"
          ? "POST_DISPATCH_TIMEOUT"
          : "TARGET_RESPONSE_LOST",
      });
    }

    return deliverTargetResult(lineage, targetResult);
  }

  function readCurrentState() {
    const observation = {
      kind: "current_state_observation",
      target_digest: authorized.target_digest,
      observed_at: nowIso(),
      state: detached(inventory),
      causal_execution_result: false,
    };
    ledgers.current_state_observations.push(observation);
    return deepFreeze(detached(observation));
  }

  function validateOperationEvidence(evidence, executionId) {
    if (!isPlainObject(evidence)) return { valid: false, reason: "MALFORMED_EVIDENCE" };
    if (evidence.kind === "not_found") return { valid: false, reason: "NON_AUTHORITATIVE_ABSENCE" };
    const keys = [
      "schema_revision",
      "execution_id",
      "binding_digest",
      "target_digest",
      "audience_digest",
      "authenticity",
      "observed_at",
      "fresh_until",
      "outcome",
      "effect_reference",
      "committed_state",
    ];
    if (Object.keys(evidence).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(evidence, key))) {
      return { valid: false, reason: "EVIDENCE_SCHEMA_MISMATCH" };
    }
    if (evidence.schema_revision !== "synthetic-operation-record/0.1") {
      return { valid: false, reason: "EVIDENCE_SCHEMA_MISMATCH" };
    }
    if (evidence.authenticity !== "fixture_authenticated") return { valid: false, reason: "UNAUTHENTICATED_EVIDENCE" };
    if (evidence.execution_id !== executionId) return { valid: false, reason: "WRONG_EXECUTION_EVIDENCE" };
    if (evidence.binding_digest !== authorized.execution_binding_digest) return { valid: false, reason: "UNBOUND_EVIDENCE" };
    if (evidence.target_digest !== authorized.target_digest) return { valid: false, reason: "WRONG_TARGET_EVIDENCE" };
    if (evidence.audience_digest !== authorized.audience_digest) return { valid: false, reason: "WRONG_AUDIENCE_EVIDENCE" };
    const observedAtMs = Date.parse(evidence.observed_at);
    const freshUntilMs = Date.parse(evidence.fresh_until);
    if (!Number.isFinite(observedAtMs) || !Number.isFinite(freshUntilMs)) {
      return { valid: false, reason: "MALFORMED_EVIDENCE" };
    }
    if (observedAtMs > nowMs + MAX_EVIDENCE_FUTURE_SKEW_MS) {
      return { valid: false, reason: "FUTURE_EVIDENCE" };
    }
    if (freshUntilMs <= observedAtMs) return { valid: false, reason: "INVALID_EVIDENCE_INTERVAL" };
    if (freshUntilMs - observedAtMs > MAX_OPERATION_EVIDENCE_LIFETIME_MS) {
      return { valid: false, reason: "EVIDENCE_LIFETIME_EXCEEDED" };
    }
    if (nowMs >= freshUntilMs) return { valid: false, reason: "STALE_EVIDENCE" };
    const firstDispatchAt = Date.parse(idempotencyRecords.get(executionId)?.first_dispatched_at ?? "");
    if (!Number.isFinite(firstDispatchAt) || observedAtMs < firstDispatchAt) {
      return { valid: false, reason: "EVIDENCE_PREDATES_DISPATCH" };
    }
    if (evidence.outcome === "confirmed_nonexecution") {
      return { valid: false, reason: "AUTHORITATIVE_NONEXECUTION_PROOF_UNAVAILABLE" };
    }
    if (!CONFIRMED_OUTCOMES.has(evidence.outcome)) return { valid: false, reason: "NON_DISCRIMINATING_EVIDENCE" };
    if (["committed_exact", "committed_divergent"].includes(evidence.outcome)) {
      if (!isPlainObject(evidence.committed_state)) return { valid: false, reason: "INCOMPLETE_EVIDENCE" };
      if (
        Object.keys(evidence.committed_state).length !== 2
        || !Object.hasOwn(evidence.committed_state, "available")
        || !Object.hasOwn(evidence.committed_state, "on_hand")
        || !Number.isSafeInteger(evidence.committed_state.available)
        || !Number.isSafeInteger(evidence.committed_state.on_hand)
      ) {
        return { valid: false, reason: "COMMITTED_STATE_SCHEMA_MISMATCH" };
      }
      if (typeof evidence.effect_reference !== "string" || evidence.effect_reference.trim() === "") {
        return { valid: false, reason: "MISSING_EFFECT_REFERENCE" };
      }
      const expected = authorized.envelope.action.expected_effect;
      const derivedOutcome = evidence.committed_state.available === expected.available_after
        && evidence.committed_state.on_hand === expected.on_hand_after
        ? "committed_exact"
        : "committed_divergent";
      return { valid: true, derived_outcome: derivedOutcome };
    }
    return { valid: true };
  }

  function reconcileExecution(executionId) {
    assertNonEmptyString(executionId, "$.executionId");
    const lineage = lineages.get(executionId);
    const overrideFault = takeFault("reconcile_override");
    const evidence = overrideFault ? detached(overrideFault.evidence) : detached(operationRecords.get(executionId) ?? {
      kind: "not_found",
      execution_id: executionId,
      consistency: "eventual",
      authenticity: "fixture_authenticated",
    });
    const validation = validateOperationEvidence(evidence, executionId);
    const entry = {
      execution_id: executionId,
      observed_at: nowIso(),
      kind: "execution_id_reconciliation",
      valid: validation.valid,
      reason_code: validation.reason ?? null,
      evidence,
    };
    ledgers.reconciliations.push(entry);
    if (!lineage) {
      return deepFreeze({ outcome: "unknown", ...detached(entry) });
    }
    recordLineageEvent(lineage, {
      type: "reconciliation_read",
      observed_at: nowIso(),
      valid: validation.valid,
      reason_code: validation.reason ?? null,
    });
    if (!validation.valid) {
      const anomaly = { code: validation.reason, observed_at: nowIso(), source: "reconciliation" };
      addAnomaly(lineage, anomaly);
      ledgers.anomalies.push({ execution_id: executionId, ...anomaly });
      return deepFreeze({ outcome: lineage.outcome ?? "unknown", ...detached(entry) });
    }
    lineage.evidence.push(detached(evidence));
    const derivedOutcome = validation.derived_outcome ?? evidence.outcome;
    if (derivedOutcome !== evidence.outcome) {
      const anomaly = {
        code: "EVIDENCE_OUTCOME_LABEL_MISMATCH",
        observed_at: nowIso(),
        source: "reconciliation",
        claimed_outcome: evidence.outcome,
        derived_outcome: derivedOutcome,
      };
      addAnomaly(lineage, anomaly);
      ledgers.anomalies.push({ execution_id: executionId, ...anomaly });
    }
    transitionLineage(lineage, derivedOutcome, {
      type: "reconciliation_evidence",
      observed_at: nowIso(),
      claimed_outcome: evidence.outcome,
      outcome: derivedOutcome,
    });
    return deepFreeze({ outcome: lineage.outcome, ...detached(entry) });
  }

  function receiveSignal(signal) {
    if (takeFault("webhook_mutation_attempt")) {
      applyProtectedMutation(null, authorized);
    }
    let reason = null;
    try {
      validateClosedJson(signal, "$.signal");
      assertClosedObject(signal, "$.signal", [
        "delivery_id",
        "execution_id",
        "binding_digest",
        "target_digest",
        "audience_digest",
        "target_time",
        "signature",
        "status",
      ]);
      for (const key of Object.keys(signal)) assertNonEmptyString(signal[key], `$.signal.${key}`);
    } catch (error) {
      reason = error.code ?? "MALFORMED_SIGNAL";
    }

    const executionId = typeof signal?.execution_id === "string" ? signal.execution_id : null;
    const lineage = executionId ? lineages.get(executionId) : null;
    if (!reason && acceptedDeliveryIds.has(signal.delivery_id)) reason = "DUPLICATE_DELIVERY";
    if (!reason && (verifyTestSignal ? !verifyTestSignal(detached(signal)) : signal.signature !== "fixture-valid")) {
      reason = "INVALID_TEST_SIGNATURE";
    }
    if (!reason && signal.execution_id !== authorized.envelope.execution_id) reason = "WRONG_EXECUTION_SIGNAL";
    if (!reason && signal.binding_digest !== authorized.execution_binding_digest) reason = "UNBOUND_SIGNAL";
    if (!reason && signal.target_digest !== authorized.target_digest) reason = "WRONG_TARGET_SIGNAL";
    if (!reason && signal.audience_digest !== authorized.audience_digest) reason = "WRONG_AUDIENCE_SIGNAL";
    if (!reason && !Number.isFinite(Date.parse(signal.target_time))) reason = "MALFORMED_SIGNAL_TIME";
    if (
      !reason
      && (Date.parse(signal.target_time) > nowMs + 60_000 || nowMs - Date.parse(signal.target_time) > SIGNAL_FRESHNESS_MS)
    ) {
      reason = "STALE_OR_FUTURE_SIGNAL";
    }

    const entry = {
      delivery_id: signal?.delivery_id ?? null,
      execution_id: executionId,
      target_time: signal?.target_time ?? null,
      received_at: nowIso(),
      accepted: !reason,
      reason_code: reason,
      corroborating_only: true,
    };
    ledgers.signals.push(entry);
    if (!reason) acceptedDeliveryIds.add(signal.delivery_id);
    else {
      const anomaly = { code: reason, observed_at: nowIso(), source: "webhook", delivery_id: entry.delivery_id };
      ledgers.anomalies.push({ execution_id: executionId, ...anomaly });
      if (lineage) addAnomaly(lineage, anomaly);
    }
    if (lineage) {
      recordLineageEvent(lineage, {
        type: "corroborating_signal",
        delivery_id: entry.delivery_id,
        target_time: entry.target_time,
        received_at: entry.received_at,
        accepted: entry.accepted,
      });
    }
    return deepFreeze(detached(entry));
  }

  function scheduleFault(fault) {
    validateClosedJson(fault, "$.fault");
    if (!isPlainObject(fault)) throw new TypeError("fault must be a plain object.");
    assertNonEmptyString(fault.type, "$.fault.type");
    const allowed = new Set([
      "before_lineage_timeout",
      "revoke_authority_before_dispatch",
      "drop_response_after_effect",
      "post_dispatch_timeout",
      "duplicate_response",
      "divergent_effect",
      "reconcile_override",
      "webhook_mutation_attempt",
    ]);
    if (!allowed.has(fault.type)) fail("UNKNOWN_FAULT", `Unknown deterministic fault: ${fault.type}`);
    const normalized = { ...detached(fault), position: FAULT_POSITIONS[fault.type] };
    const scheduled = { ...normalized, event: "scheduled", scheduled_at: nowIso() };
    scheduledFaults.push(normalized);
    ledgers.faults.push(scheduled);
    return deepFreeze(detached(scheduled));
  }

  function advance(milliseconds) {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new TypeError("advance() requires a non-negative safe integer.");
    }
    nowMs += milliseconds;
    return nowIso();
  }

  function competingWrite({ availableDelta = 0, onHandDelta = availableDelta, actor = "explicit-test-writer" } = {}) {
    assertSafeInteger(availableDelta, "$.availableDelta");
    assertSafeInteger(onHandDelta, "$.onHandDelta");
    assertNonEmptyString(actor, "$.actor");
    const before = detached(inventory);
    inventory.available += availableDelta;
    inventory.on_hand += onHandDelta;
    const entry = { actor, before, after: detached(inventory), written_at: nowIso() };
    ledgers.external_writes.push(entry);
    return deepFreeze(detached(entry));
  }

  function revokeAuthority() {
    authority.revoked = true;
    authority.log.push({ state: "revoked", execution_id: authority.reserved_execution_id, at: nowIso() });
  }

  function snapshotEvidence() {
    return detached({
      fixture: {
        kind: "synthetic_mock_only",
        contract_revision: CONTRACT_REVISION,
        target_context: context,
        idempotency_window_ms: idempotencyWindowMs,
        deadline_policy: "first_dispatch_plus_window_block_at_or_after",
        on_hand_policy: "synthetic_delta_matches_available_delta",
        provider_conformance: "unknown",
      },
      clock: nowIso(),
      inventory,
      authority,
      idempotency_records: mapValues(idempotencyRecords),
      operation_records: mapValues(operationRecords),
      lineages: mapValues(lineages),
      ledgers,
      pending_faults: detached(scheduledFaults),
      counters: {
        gateway_attempts: ledgers.gateway_attempts.length,
        dispatches: ledgers.dispatches.length,
        protected_effects: ledgers.protected_effects.length,
        authority_reservations: authority.reservation_count,
        authority_consumptions: authority.consumption_count,
        current_state_reads: ledgers.current_state_observations.length,
        reconciliation_reads: ledgers.reconciliations.length,
        accepted_signals: ledgers.signals.filter((entry) => entry.accepted).length,
        bypass_attempts: ledgers.bypass_attempts.length,
      },
    });
  }

  return deepFreeze({
    commitGateway: deepFreeze({ commit }),
    currentStateObserver: deepFreeze({ readCurrentState }),
    executionReconciler: deepFreeze({ reconcileExecution }),
    webhookSignalIntake: deepFreeze({ receive: receiveSignal }),
    faultController: deepFreeze({ schedule: scheduleFault, advance }),
    testActors: deepFreeze({ competingWrite, revokeAuthority }),
    snapshotEvidence,
  });
}
