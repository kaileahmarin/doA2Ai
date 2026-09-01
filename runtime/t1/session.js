import { createHash } from "node:crypto";

import { T1_REQUEST_MANIFEST } from "./request-manifest.js";

const CONTRACT_REVISION = "t1-offline-0.1";
const RUN_MODE = "synthetic_offline";
const AUTHORITY_MODE = "transaction_authorized";
const PROVIDER = "synthetic-shopify-like-fixture";
const OPERATION = "inventoryAdjustQuantities";
const QUANTITY_NAME = "available";
const REASON = "correction";
const DOCUMENT_IDS = Object.freeze(["before_read", "commit", "verification_read"]);
const MAX_ACTIVE_WINDOW_MS = 30 * 60 * 1000;
const SYNTHETIC_TIME_PHASES = Object.freeze([
  "opened_at",
  "prepare_started_at",
  "prepared_at",
  "authority_recorded_at",
  "dispatch_at",
  "commit_response_at",
  "verification_response_at",
]);
const EXECUTION_REGISTRY_KEY = Symbol.for("bounded-authorization-webmcp-demo.t1.execution-registry.v1");
if (!Object.hasOwn(globalThis, EXECUTION_REGISTRY_KEY)) {
  Object.defineProperty(globalThis, EXECUTION_REGISTRY_KEY, {
    value: new Set(),
    configurable: false,
    enumerable: false,
    writable: false,
  });
}
const CLAIMED_EXECUTION_IDS = globalThis[EXECUTION_REGISTRY_KEY];
if (!(CLAIMED_EXECUTION_IDS instanceof Set)) {
  throw new TypeError("The process-realm T1 execution registry is unavailable.");
}

export class T1SessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "T1SessionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new T1SessionError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertClosedObject(value, keys, code = "INVALID_SHAPE") {
  if (!isPlainObject(value)) fail(code, "A required closed object is invalid.");
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail("UNKNOWN_FIELD", "The closed T1 contract contains an unknown field.");
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail("MISSING_FIELD", "The closed T1 contract is missing a required field.");
  }
}

function assertString(value, code = "INVALID_STRING") {
  if (typeof value !== "string" || value.trim() === "") fail(code, "A required T1 string is invalid.");
}

function assertSyntheticReference(value) {
  assertString(value, "INVALID_SYNTHETIC_REFERENCE");
  if (!/^synthetic-[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/.test(value)) {
    fail("LIVE_REFERENCE_FORBIDDEN", "The offline T1 runtime accepts synthetic references only.");
  }
}

function assertSyntheticExecutionId(value) {
  assertString(value, "INVALID_SYNTHETIC_REFERENCE");
  if (!/^synthetic-execution-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    fail("LIVE_EXECUTION_ID_FORBIDDEN", "The offline T1 runtime requires a closed synthetic execution identifier.");
  }
}

function assertInteger(value, { minimum = Number.MIN_SAFE_INTEGER, code = "INVALID_INTEGER" } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(code, "A required T1 integer is invalid.");
}

function parseIso(value, code = "INVALID_TIMESTAMP") {
  assertString(value, code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail(code, "A required T1 timestamp is invalid.");
  }
  return milliseconds;
}

function validateSyntheticTime(rawTime) {
  if (rawTime === null) return null;
  if (typeof rawTime === "string") {
    const milliseconds = parseIso(rawTime, "INVALID_CLOCK");
    return deepFreeze(Object.fromEntries(SYNTHETIC_TIME_PHASES.map((phase) => [phase, milliseconds])));
  }
  assertClosedObject(rawTime, SYNTHETIC_TIME_PHASES, "INVALID_CLOCK");
  const timeline = {};
  let previous = Number.NEGATIVE_INFINITY;
  for (const phase of SYNTHETIC_TIME_PHASES) {
    const milliseconds = parseIso(rawTime[phase], "INVALID_CLOCK");
    if (milliseconds < previous) {
      fail("INVALID_CLOCK", "Synthetic T1 time phases must be monotonic.");
    }
    timeline[phase] = milliseconds;
    previous = milliseconds;
  }
  return deepFreeze(timeline);
}

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
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

function validatePlan(rawPlan) {
  assertClosedObject(rawPlan, [
    "contract_revision",
    "run_mode",
    "execution_id",
    "owner_direction_ref",
    "authority_mode",
    "target_context",
    "audience",
    "action",
    "deadline",
  ]);
  const plan = clone(rawPlan);

  if (plan.contract_revision !== CONTRACT_REVISION) fail("UNSUPPORTED_CONTRACT_REVISION", "Unsupported T1 revision.");
  if (plan.run_mode !== RUN_MODE) fail("LIVE_MODE_FORBIDDEN", "Only synthetic offline T1 mode is implemented.");
  if (plan.authority_mode !== AUTHORITY_MODE) fail("UNSUPPORTED_AUTHORITY_MODE", "Phase A requires transaction authority.");
  assertSyntheticExecutionId(plan.execution_id);
  assertSyntheticReference(plan.owner_direction_ref);

  assertClosedObject(plan.target_context, [
    "provider",
    "api_version",
    "store_ref",
    "inventory_level_id",
    "inventory_item_id",
    "location_id",
  ]);
  if (plan.target_context.provider !== PROVIDER) fail("LIVE_PROVIDER_FORBIDDEN", "Only the synthetic provider is allowed.");
  if (plan.target_context.api_version !== T1_REQUEST_MANIFEST.api_version) {
    fail("API_VERSION_MISMATCH", "The T1 API version does not match the frozen request manifest.");
  }
  for (const field of ["store_ref", "inventory_level_id", "inventory_item_id", "location_id"]) {
    assertSyntheticReference(plan.target_context[field]);
  }

  assertClosedObject(plan.audience, ["issuer_ref", "adapter_ref", "verifier_ref"]);
  for (const field of Object.keys(plan.audience)) assertSyntheticReference(plan.audience[field]);

  assertClosedObject(plan.action, [
    "operation",
    "quantity_name",
    "delta",
    "change_from_quantity",
    "reason",
    "reference_document_uri",
    "ledger_document_uri",
    "expected_effect",
  ]);
  if (plan.action.operation !== OPERATION) fail("UNSUPPORTED_OPERATION", "The T1 operation is outside the closed surface.");
  if (plan.action.quantity_name !== QUANTITY_NAME) fail("UNSUPPORTED_QUANTITY", "The T1 quantity is outside the closed surface.");
  if (plan.action.reason !== REASON) fail("UNSUPPORTED_REASON", "The T1 reason is outside the closed surface.");
  assertInteger(plan.action.delta);
  assertInteger(plan.action.change_from_quantity);
  const expectedReferenceDocumentUri = `urn:synthetic-t1:execution:${plan.execution_id}`;
  if (plan.action.reference_document_uri !== expectedReferenceDocumentUri) {
    fail("UNBOUND_REFERENCE", "The action reference must be the exact synthetic execution URI.");
  }
  if (plan.action.ledger_document_uri !== null) {
    fail("LEDGER_URI_POLICY", "The offline T1 request requires an explicit null ledger document URI.");
  }

  assertClosedObject(plan.action.expected_effect, [
    "available_before",
    "available_after",
    "on_hand_before",
    "on_hand_after",
  ]);
  for (const field of Object.keys(plan.action.expected_effect)) assertInteger(plan.action.expected_effect[field]);
  const expected = plan.action.expected_effect;
  if (expected.available_before !== plan.action.change_from_quantity
    || expected.available_after !== expected.available_before + plan.action.delta
    || expected.on_hand_after !== expected.on_hand_before + plan.action.delta) {
    fail("INVALID_EXPECTED_EFFECT", "The exact synthetic consequence is internally inconsistent.");
  }
  parseIso(plan.deadline, "INVALID_DEADLINE");
  return deepFreeze(plan);
}

function validateBudget(rawBudget) {
  if (!rawBudget) fail("QUERY_COST_BUDGET_HOLD", "The exact query-cost budget remains on HOLD.");
  assertClosedObject(rawBudget, ["status", "decision_ref", "documents", "max_total_requested_cost"]);
  const budget = clone(rawBudget);
  if (budget.status !== "synthetic_fixture_only") {
    fail("QUERY_COST_BUDGET_HOLD", "Only a synthetic fixture cost budget is accepted by this offline runtime.");
  }
  assertSyntheticReference(budget.decision_ref);
  assertClosedObject(budget.documents, DOCUMENT_IDS);
  let maximumSum = 0;
  for (const id of DOCUMENT_IDS) {
    const entry = budget.documents[id];
    assertClosedObject(entry, ["static_requested_cost", "max_requested_cost"]);
    assertInteger(entry.static_requested_cost, { minimum: 1, code: "INVALID_QUERY_COST" });
    assertInteger(entry.max_requested_cost, { minimum: 1, code: "INVALID_QUERY_COST" });
    if (entry.static_requested_cost > entry.max_requested_cost) {
      fail("QUERY_COST_BUDGET_HOLD", "A static request cost exceeds its selected synthetic ceiling.");
    }
    maximumSum += entry.max_requested_cost;
  }
  assertInteger(budget.max_total_requested_cost, { minimum: 1, code: "INVALID_QUERY_COST" });
  if (maximumSum > budget.max_total_requested_cost) {
    fail("QUERY_COST_BUDGET_HOLD", "The aggregate synthetic query-cost ceiling is internally inconsistent.");
  }
  return deepFreeze({ ...budget, budget_digest: digest(budget) });
}

function validateTargetFixture(rawFixture) {
  assertClosedObject(rawFixture, [
    "kind",
    "initial_inventory",
    "requested_costs",
    "evidence_profile",
  ], "INVALID_SYNTHETIC_FIXTURE");
  const fixture = clone(rawFixture);
  if (fixture.kind !== "synthetic_t1_data_fixture") {
    fail("INVALID_SYNTHETIC_FIXTURE", "The offline runtime accepts one data-only synthetic fixture.");
  }
  assertClosedObject(fixture.initial_inventory, ["available", "on_hand"], "INVALID_SYNTHETIC_FIXTURE");
  for (const quantity of Object.values(fixture.initial_inventory)) {
    assertInteger(quantity, { code: "INVALID_SYNTHETIC_FIXTURE" });
  }
  assertClosedObject(fixture.requested_costs, DOCUMENT_IDS, "INVALID_SYNTHETIC_FIXTURE");
  for (const cost of Object.values(fixture.requested_costs)) {
    assertInteger(cost, { minimum: 0, code: "INVALID_SYNTHETIC_FIXTURE" });
  }
  if (!["consistent", "verification_conflict", "commit_response_missing_after_effect", "commit_response_malformed_after_effect"]
    .includes(fixture.evidence_profile)) {
    fail("INVALID_SYNTHETIC_FIXTURE", "The synthetic evidence profile is outside the closed fixture set.");
  }
  return deepFreeze(fixture);
}

function syntheticIsolationStatus() {
  return deepFreeze({
    scope: "same_process_synthetic_interface_only",
    secret_store: "not_implemented",
    protected_ledger: "not_implemented",
    alternate_commit_interface: "absent",
    windows_acl: "not_proven",
  });
}

function documentFor(id) {
  const descriptor = T1_REQUEST_MANIFEST.documents.find((entry) => entry.id === id);
  if (!descriptor) fail("UNKNOWN_REQUEST_DOCUMENT", "The T1 request document is not in the frozen manifest.");
  return descriptor;
}

function requestFor(plan, id) {
  const descriptor = documentFor(id);
  let variables;
  if (id === "before_read" || id === "verification_read") {
    variables = { inventoryLevelId: plan.target_context.inventory_level_id };
  } else {
    variables = {
      input: {
        name: QUANTITY_NAME,
        reason: REASON,
        referenceDocumentUri: plan.action.reference_document_uri,
        ledgerDocumentUri: null,
        changes: [{
          inventoryItemId: plan.target_context.inventory_item_id,
          locationId: plan.target_context.location_id,
          delta: plan.action.delta,
          changeFromQuantity: plan.action.change_from_quantity,
        }],
      },
      idempotencyKey: plan.execution_id,
    };
  }
  return deepFreeze({
    request_id: descriptor.id,
    manifest_digest: T1_REQUEST_MANIFEST.manifest_digest,
    document_digest: descriptor.document_digest,
    operation_name: descriptor.operation_name,
    commit_capable: descriptor.commit_capable,
    document: descriptor.document,
    variables,
  });
}

function validateAuthorityRecord(rawRecord, {
  executionId,
  bindingDigest,
  preparedAtMs,
  deadlineMs,
  nowMs,
}) {
  assertClosedObject(rawRecord, [
    "authority_ref",
    "execution_id",
    "binding_digest",
    "operator_mode",
    "authorized_at",
    "expires_at",
  ]);
  const record = clone(rawRecord);
  assertSyntheticReference(record.authority_ref);
  for (const field of ["execution_id", "binding_digest", "operator_mode"]) assertString(record[field]);
  if (record.execution_id !== executionId || record.binding_digest !== bindingDigest) {
    fail("AUTHORITY_BINDING_MISMATCH", "The transaction authority does not match the prepared T1 binding.");
  }
  if (record.operator_mode !== "human_foreground_declared") {
    fail("OPERATOR_MODE_REQUIRED", "The T1 record requires the declared foreground operator mode.");
  }
  const authorizedAt = parseIso(record.authorized_at, "INVALID_AUTHORITY_TIME");
  const expiresAt = parseIso(record.expires_at, "INVALID_AUTHORITY_TIME");
  if (authorizedAt < preparedAtMs) {
    fail("AUTHORITY_PREDATES_PREPARATION", "Transaction authority must follow the exact prepared review state.");
  }
  if (authorizedAt > nowMs
    || nowMs - authorizedAt > MAX_ACTIVE_WINDOW_MS
    || expiresAt <= nowMs
    || authorizedAt >= expiresAt
    || expiresAt - authorizedAt > MAX_ACTIVE_WINDOW_MS
    || expiresAt > deadlineMs) {
    fail("AUTHORITY_EXPIRED", "The transaction authority is outside its closed validity interval.");
  }
  return deepFreeze({ ...record, authority_digest: digest(record) });
}

function validateCommonResponse(raw, { request, plan, budget, requestedCosts }) {
  assertClosedObject(raw, [
    "request_id",
    "document_digest",
    "response_api_version",
    "requested_query_cost",
    "actual_query_cost",
    "result",
  ], "INVALID_TARGET_EVIDENCE");
  if (raw.request_id !== request.request_id || raw.document_digest !== request.document_digest) {
    fail("REQUEST_EVIDENCE_MISMATCH", "The synthetic response is not bound to the fixed request document.");
  }
  if (raw.response_api_version !== plan.target_context.api_version) {
    fail("API_VERSION_MISMATCH", "The synthetic response API version does not match the authorized plan.");
  }
  assertInteger(raw.requested_query_cost, { minimum: 0, code: "INVALID_QUERY_COST_EVIDENCE" });
  assertInteger(raw.actual_query_cost, { minimum: 0, code: "INVALID_QUERY_COST_EVIDENCE" });
  if (raw.actual_query_cost > raw.requested_query_cost) {
    fail("INVALID_QUERY_COST_EVIDENCE", "Actual query cost exceeds requested query cost.");
  }
  const ceiling = budget.documents[request.request_id].max_requested_cost;
  requestedCosts[request.request_id] = raw.requested_query_cost;
  const total = Object.values(requestedCosts).reduce((sum, value) => sum + value, 0);
  if (raw.requested_query_cost > ceiling || total > budget.max_total_requested_cost) {
    fail("QUERY_COST_CEILING_EXCEEDED", "Reported query cost exceeds the synthetic fixture ceiling.");
  }
  return raw.result;
}

function validateReadResult(rawResult, plan) {
  assertClosedObject(rawResult, [
    "inventory_level_id",
    "inventory_item_id",
    "location_id",
    "quantities",
  ], "INVALID_TARGET_EVIDENCE");
  if (rawResult.inventory_level_id !== plan.target_context.inventory_level_id
    || rawResult.inventory_item_id !== plan.target_context.inventory_item_id
    || rawResult.location_id !== plan.target_context.location_id) {
    fail("TARGET_CONTEXT_MISMATCH", "The synthetic observation target does not match the authorized plan.");
  }
  if (!Array.isArray(rawResult.quantities) || rawResult.quantities.length !== 2) {
    fail("INVALID_TARGET_EVIDENCE", "The synthetic observation must contain exactly two quantities.");
  }
  const quantities = new Map();
  for (const entry of rawResult.quantities) {
    assertClosedObject(entry, ["name", "quantity"], "INVALID_TARGET_EVIDENCE");
    if (!["available", "on_hand"].includes(entry.name) || quantities.has(entry.name)) {
      fail("INVALID_TARGET_EVIDENCE", "The synthetic quantity observation is outside the closed set.");
    }
    assertInteger(entry.quantity, { code: "INVALID_TARGET_EVIDENCE" });
    quantities.set(entry.name, entry.quantity);
  }
  if (!quantities.has("available") || !quantities.has("on_hand")) {
    fail("INVALID_TARGET_EVIDENCE", "The synthetic quantity observation is incomplete.");
  }
  return deepFreeze({ available: quantities.get("available"), on_hand: quantities.get("on_hand") });
}

function validateCommitResult(rawResult, plan) {
  assertClosedObject(rawResult, ["accepted", "user_errors", "adjustment"], "INVALID_TARGET_EVIDENCE");
  if (typeof rawResult.accepted !== "boolean" || !Array.isArray(rawResult.user_errors)) {
    fail("INVALID_TARGET_EVIDENCE", "The synthetic commit result is malformed.");
  }
  for (const error of rawResult.user_errors) {
    assertClosedObject(error, ["field", "message", "code"], "INVALID_TARGET_EVIDENCE");
    for (const field of ["field", "message", "code"]) assertString(error[field], "INVALID_TARGET_EVIDENCE");
  }
  if (!rawResult.accepted) {
    if (rawResult.adjustment !== null || rawResult.user_errors.length === 0) {
      fail("INVALID_TARGET_EVIDENCE", "A rejected synthetic commit must contain a closed error and no adjustment.");
    }
    return deepFreeze({ accepted: false });
  }
  if (rawResult.user_errors.length !== 0) {
    fail("INVALID_TARGET_EVIDENCE", "An accepted synthetic commit cannot also contain user errors.");
  }
  assertClosedObject(rawResult.adjustment, ["reason", "reference_document_uri", "changes"], "INVALID_TARGET_EVIDENCE");
  if (rawResult.adjustment.reason !== plan.action.reason
    || rawResult.adjustment.reference_document_uri !== plan.action.reference_document_uri
    || !Array.isArray(rawResult.adjustment.changes)
    || rawResult.adjustment.changes.length !== 1) {
    fail("COMMIT_EVIDENCE_MISMATCH", "The synthetic commit evidence is not bound to the exact action.");
  }
  const [change] = rawResult.adjustment.changes;
  assertClosedObject(change, ["name", "delta"], "INVALID_TARGET_EVIDENCE");
  if (change.name !== QUANTITY_NAME || change.delta !== plan.action.delta) {
    fail("COMMIT_EVIDENCE_MISMATCH", "The synthetic commit evidence contains a different change.");
  }
  return deepFreeze({ accepted: true });
}

function sameObservation(left, right) {
  return left.available === right.available && left.on_hand === right.on_hand;
}

export function createT1OfflineRuntime(rawOptions = {}) {
  assertClosedObject(rawOptions, ["plan", "costBudget", "targetFixture", "syntheticNow"]);
  const plan = validatePlan(rawOptions.plan);
  const budget = validateBudget(rawOptions.costBudget);
  const targetFixture = validateTargetFixture(rawOptions.targetFixture);
  const syntheticTimeline = validateSyntheticTime(rawOptions.syntheticNow);
  if (CLAIMED_EXECUTION_IDS.has(plan.execution_id)) {
    fail("DUPLICATE_EXECUTION_ID", "The synthetic execution identifier is already claimed in this process.");
  }
  CLAIMED_EXECUTION_IDS.add(plan.execution_id);

  const timeFixture = syntheticTimeline === null
    ? deepFreeze({ mode: "runtime_clock" })
    : deepFreeze({ mode: "closed_synthetic_timeline", timeline: syntheticTimeline });
  const operatorTimeFixture = deepFreeze({
    mode: timeFixture.mode,
    timeline: syntheticTimeline === null
      ? null
      : Object.fromEntries(Object.entries(syntheticTimeline)
        .map(([phase, milliseconds]) => [phase, new Date(milliseconds).toISOString()])),
  });
  const fixtureDigest = digest({ target_fixture: targetFixture, time_fixture: timeFixture });
  const bindingPreimage = {
    plan,
    manifest_digest: T1_REQUEST_MANIFEST.manifest_digest,
    budget_digest: budget.budget_digest,
    fixture_digest: fixtureDigest,
  };
  const bindingDigest = digest(bindingPreimage);
  const deadlineMs = parseIso(plan.deadline, "INVALID_DEADLINE");
  const inventory = clone(targetFixture.initial_inventory);
  let syntheticEffects = 0;
  const requestedCosts = {};
  const events = [];
  const requestCounts = { total: 0, reads: 0, commit_capable: 0 };
  let state = "created";
  let inFlight = false;
  let attempted = false;
  let authorityLifecycle = "unrecorded";
  let authorityValidity = "not_assessed";
  let authorityRecord = null;
  let preparedAtMs = null;
  const isolation = syntheticIsolationStatus();
  let beforeObservation = null;
  let commitResponseReceived = false;
  let commitResponseValidated = false;
  let verificationObservation = null;
  let dispatchStatus = "not_dispatched";
  let receipt = null;

  function nowMs(phase) {
    return syntheticTimeline?.[phase] ?? Date.now();
  }

  const openedAtMs = nowMs("opened_at");

  function recordEvent(type) {
    events.push({ type, sequence: events.length + 1 });
  }

  function finalize(outcome, reasonCode) {
    state = outcome === "unknown" || outcome === "committed_divergent" ? "quarantined" : "terminal";
    recordEvent("terminal_outcome");
    const receiptPreimage = {
      receipt_revision: CONTRACT_REVISION,
      projection: "agent_safe_allowlist",
      execution_id: plan.execution_id,
      binding_digest: bindingDigest,
      manifest_digest: T1_REQUEST_MANIFEST.manifest_digest,
      synthetic_fixture: {
        fixture_digest: fixtureDigest,
        evidence_profile: targetFixture.evidence_profile,
        time_mode: timeFixture.mode,
      },
      outcome,
      reason_code: reasonCode,
      dispatch_status: dispatchStatus,
      request_counts: clone(requestCounts),
      effecting_lineages: requestCounts.commit_capable === 0 ? 0 : 1,
      authority: {
        lifecycle_state: authorityLifecycle,
        validity: authorityValidity,
        record_digest: authorityRecord?.authority_digest ?? null,
        operator_mode: authorityRecord?.operator_mode ?? null,
        authorized_at: authorityRecord?.authorized_at ?? null,
        expires_at: authorityRecord?.expires_at ?? null,
        reservation_count: attempted ? 1 : 0,
        consumption_count: requestCounts.commit_capable > 0 ? 1 : 0,
      },
      evidence: {
        before_observed: beforeObservation !== null,
        prepared_at: preparedAtMs === null ? null : new Date(preparedAtMs).toISOString(),
        commit_response_received: commitResponseReceived,
        commit_response_validated: commitResponseValidated,
        verification_observed: verificationObservation !== null,
        event_types: events.map((entry) => entry.type),
      },
      query_cost: {
        budget_mode: budget.status,
        budget_digest: budget.budget_digest,
        requested_by_document: clone(requestedCosts),
        requested_total: Object.values(requestedCosts).reduce((sum, value) => sum + value, 0),
      },
      isolation,
      trust: {
        human_operation: "not_verified",
        agent_mediation: "not_tested",
        provider_conformance: "unknown",
        windows_acl: "not_proven",
        credential_custody: "not_implemented",
        protected_ledger: "not_implemented",
        replay_exclusion: "unprotected_process_realm_only",
        receipt_authenticity: "unsigned",
        gate_9: "not_proven",
      },
    };
    receipt = deepFreeze({ ...receiptPreimage, receipt_digest: digest(receiptPreimage) });
    return clone(receipt);
  }

  function targetReadResult() {
    return {
      inventory_level_id: plan.target_context.inventory_level_id,
      inventory_item_id: plan.target_context.inventory_item_id,
      location_id: plan.target_context.location_id,
      quantities: [
        { name: "available", quantity: inventory.available },
        { name: "on_hand", quantity: inventory.on_hand },
      ],
    };
  }

  function targetResponse(request, result) {
    return {
      request_id: request.request_id,
      document_digest: request.document_digest,
      response_api_version: plan.target_context.api_version,
      requested_query_cost: targetFixture.requested_costs[request.request_id],
      actual_query_cost: targetFixture.requested_costs[request.request_id],
      result,
    };
  }

  async function dispatchSyntheticRequest(request) {
    const descriptor = documentFor(request?.request_id);
    if (!descriptor
      || request.manifest_digest !== T1_REQUEST_MANIFEST.manifest_digest
      || request.document_digest !== descriptor.document_digest
      || request.operation_name !== descriptor.operation_name
      || request.document !== descriptor.document
      || request.commit_capable !== descriptor.commit_capable) {
      throw new TypeError("The private synthetic dispatcher received a request outside the frozen manifest.");
    }

    await Promise.resolve();
    if (request.request_id === "before_read" || request.request_id === "verification_read") {
      if (request.variables?.inventoryLevelId !== plan.target_context.inventory_level_id) {
        throw new TypeError("The synthetic inventory-level variable is not bound to the plan.");
      }
      const result = targetReadResult();
      if (request.request_id === "verification_read"
        && targetFixture.evidence_profile === "verification_conflict") {
        result.quantities.find((entry) => entry.name === "on_hand").quantity += 1;
      }
      return targetResponse(request, result);
    }

    const input = request.variables?.input;
    const change = input?.changes?.[0];
    const bound = request.variables?.idempotencyKey === plan.execution_id
      && input?.name === plan.action.quantity_name
      && input?.reason === plan.action.reason
      && input?.referenceDocumentUri === plan.action.reference_document_uri
      && input?.ledgerDocumentUri === null
      && Array.isArray(input?.changes)
      && input.changes.length === 1
      && change?.inventoryItemId === plan.target_context.inventory_item_id
      && change?.locationId === plan.target_context.location_id
      && change?.delta === plan.action.delta
      && change?.changeFromQuantity === plan.action.change_from_quantity;
    if (!bound) throw new TypeError("The synthetic commit request is not bound to the closed plan.");

    if (syntheticEffects !== 0 || inventory.available !== change.changeFromQuantity) {
      return targetResponse(request, {
        accepted: false,
        user_errors: [{
          field: "changes[0].changeFromQuantity",
          message: "Synthetic conditional quantity rejected.",
          code: "SYNTHETIC_CONDITIONAL_REJECTED",
        }],
        adjustment: null,
      });
    }

    inventory.available += change.delta;
    inventory.on_hand += change.delta;
    syntheticEffects += 1;
    const response = targetResponse(request, {
      accepted: true,
      user_errors: [],
      adjustment: {
        reason: input.reason,
        reference_document_uri: input.referenceDocumentUri,
        changes: [{ name: input.name, delta: change.delta }],
      },
    });
    if (targetFixture.evidence_profile === "commit_response_missing_after_effect") {
      throw new Error("Synthetic commit response unavailable after effect.");
    }
    if (targetFixture.evidence_profile === "commit_response_malformed_after_effect") {
      response.result.adjustment.changes[0].delta += 1;
    }
    return response;
  }

  async function send(id) {
    const request = requestFor(plan, id);
    requestCounts.total += 1;
    if (request.commit_capable) requestCounts.commit_capable += 1;
    else requestCounts.reads += 1;
    recordEvent(`request_${id}`);
    const response = await dispatchSyntheticRequest(request);
    return { request, response };
  }

  async function prepare() {
    if (inFlight) fail("RUN_IN_PROGRESS", "The T1 session already has one request in flight.");
    if (state !== "created") fail("INVALID_PHASE", "The T1 session is not awaiting preparation.");
    inFlight = true;
    try {
      const current = nowMs("prepare_started_at");
      if (deadlineMs <= current || deadlineMs - openedAtMs > MAX_ACTIVE_WINDOW_MS) {
        fail("TRIAL_WINDOW_INVALID", "The synthetic T1 plan is expired or exceeds the 30-minute active window.");
      }
      recordEvent("same_process_interface_boundary_recorded");
      const { request, response } = await send("before_read");
      const result = validateCommonResponse(response, { request, plan, budget, requestedCosts });
      beforeObservation = validateReadResult(result, plan);
      const expectedBefore = {
        available: plan.action.expected_effect.available_before,
        on_hand: plan.action.expected_effect.on_hand_before,
      };
      if (!sameObservation(beforeObservation, expectedBefore)) {
        finalize("not_attempted", "BEFORE_STATE_DIVERGENT");
        fail("BEFORE_STATE_DIVERGENT", "The synthetic before-state differs from the closed action.");
      }
      preparedAtMs = nowMs("prepared_at");
      if (preparedAtMs >= deadlineMs) {
        fail("TRIAL_WINDOW_EXPIRED_DURING_PREPARE", "The active window expired during synthetic preparation.");
      }
      state = "prepared";
      recordEvent("prepared_for_exact_transaction_authority");
      return deepFreeze({
        projection: "protected_operator_only_synthetic",
        execution_id: plan.execution_id,
        owner_direction_ref: plan.owner_direction_ref,
        binding_digest: bindingDigest,
        manifest_digest: T1_REQUEST_MANIFEST.manifest_digest,
        synthetic_fixture: {
          fixture_digest: fixtureDigest,
          evidence_profile: targetFixture.evidence_profile,
          time_mode: timeFixture.mode,
          time_fixture: clone(operatorTimeFixture),
        },
        target_context: clone(plan.target_context),
        action: clone(plan.action),
        observed_before: clone(beforeObservation),
        prepared_at: new Date(preparedAtMs).toISOString(),
        deadline: plan.deadline,
        operator_provenance: "not_verified",
        evidence_scope: "synthetic_offline_only",
      });
    } catch (error) {
      if (!receipt) finalize("not_attempted", error instanceof T1SessionError ? error.code : "BEFORE_READ_TRANSPORT_FAILURE");
      if (error instanceof T1SessionError) throw error;
      throw new T1SessionError("BEFORE_READ_TRANSPORT_FAILURE", "The synthetic before-state request failed.");
    } finally {
      inFlight = false;
    }
  }

  function recordTransactionAuthority(rawRecord) {
    if (inFlight) fail("RUN_IN_PROGRESS", "The T1 session already has one request in flight.");
    if (state !== "prepared") fail("INVALID_PHASE", "The T1 session is not awaiting transaction authority.");
    authorityRecord = validateAuthorityRecord(rawRecord, {
      executionId: plan.execution_id,
      bindingDigest,
      preparedAtMs,
      deadlineMs,
      nowMs: nowMs("authority_recorded_at"),
    });
    authorityLifecycle = "available";
    authorityValidity = "valid";
    state = "authorized";
    recordEvent("transaction_authority_recorded");
    return deepFreeze({
      recorded: true,
      execution_id: plan.execution_id,
      binding_digest: bindingDigest,
      authority_digest: authorityRecord.authority_digest,
      operator_provenance: "not_verified",
    });
  }

  async function runAuthorized() {
    if (inFlight) fail("RUN_IN_PROGRESS", "The T1 session already has one request in flight.");
    if (attempted) fail("RETRY_FORBIDDEN", "The P1 session permits no retry or second effecting attempt.");
    if (state !== "authorized" || !authorityRecord) {
      fail("TRANSACTION_AUTHORITY_REQUIRED", "Exact transaction authority must be recorded before dispatch.");
    }
    const current = nowMs("dispatch_at");
    const authorityExpiresAtMs = parseIso(authorityRecord.expires_at, "INVALID_AUTHORITY_TIME");
    if (current >= authorityExpiresAtMs) {
      authorityValidity = "expired_before_dispatch";
      recordEvent("authority_expired_before_dispatch");
      return finalize("not_attempted", "AUTHORITY_EXPIRED");
    }
    if (current >= deadlineMs) {
      authorityValidity = "plan_window_expired_before_dispatch";
      recordEvent("plan_window_expired_before_dispatch");
      return finalize("not_attempted", "ACTIVE_WINDOW_EXPIRED_BEFORE_DISPATCH");
    }

    attempted = true;
    inFlight = true;
    state = "running";
    authorityLifecycle = "reserved";
    authorityValidity = "valid_at_dispatch";
    recordEvent("authority_reserved");

    let commitResult;
    try {
      authorityLifecycle = "consumed";
      dispatchStatus = "dispatched";
      recordEvent("authority_consumed_for_commit_dispatch");
      const { request, response } = await send("commit");
      commitResponseReceived = true;
      const result = validateCommonResponse(response, { request, plan, budget, requestedCosts });
      commitResult = validateCommitResult(result, plan);
      commitResponseValidated = true;
    } catch {
      inFlight = false;
      return finalize("unknown", "COMMIT_DISPATCH_OR_EVIDENCE_UNKNOWN");
    }

    if (!commitResult.accepted) {
      inFlight = false;
      return finalize("not_committed", "SYNTHETIC_TARGET_REJECTED");
    }

    const activeUntilMs = Math.min(deadlineMs, authorityExpiresAtMs);
    if (nowMs("commit_response_at") >= activeUntilMs) {
      inFlight = false;
      return finalize("unknown", "ACTIVE_WINDOW_CROSSED_AFTER_COMMIT");
    }

    try {
      const { request, response } = await send("verification_read");
      const result = validateCommonResponse(response, { request, plan, budget, requestedCosts });
      verificationObservation = validateReadResult(result, plan);
    } catch {
      inFlight = false;
      return finalize("unknown", "VERIFICATION_EVIDENCE_UNKNOWN");
    }

    inFlight = false;
    if (nowMs("verification_response_at") >= activeUntilMs) {
      return finalize("unknown", "ACTIVE_WINDOW_CROSSED_DURING_VERIFICATION");
    }
    const expectedAfter = {
      available: plan.action.expected_effect.available_after,
      on_hand: plan.action.expected_effect.on_hand_after,
    };
    if (!sameObservation(verificationObservation, expectedAfter)) {
      return finalize("committed_divergent", "SYNTHETIC_VERIFICATION_DIVERGED");
    }
    return finalize("committed_exact", "SYNTHETIC_VERIFICATION_MATCHED");
  }

  function exportReceipt() {
    if (!receipt) fail("RECEIPT_NOT_READY", "No terminal T1 receipt is available.");
    return clone(receipt);
  }

  const session = deepFreeze({ prepare, runAuthorized, exportReceipt });
  const operator = deepFreeze({ recordTransactionAuthority });
  return deepFreeze({ session, operator });
}
