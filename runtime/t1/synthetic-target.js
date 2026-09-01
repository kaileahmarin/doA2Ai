const DOCUMENT_IDS = Object.freeze(["before_read", "commit", "verification_read"]);
const EVIDENCE_PROFILES = Object.freeze([
  "consistent",
  "verification_conflict",
  "commit_response_missing_after_effect",
  "commit_response_malformed_after_effect",
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertClosedObject(value, requiredKeys, optionalKeys = []) {
  if (!isPlainObject(value)) throw new TypeError("A closed synthetic target fixture object is required.");
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError("The synthetic target fixture contains an unknown field.");
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) throw new TypeError("The synthetic target fixture is missing a required field.");
  }
}

function assertInteger(value, message) {
  if (!Number.isSafeInteger(value)) throw new TypeError(message);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function createT1SyntheticFixture(raw = {}) {
  assertClosedObject(raw, ["initialInventory", "requestedCosts"], ["evidenceProfile"]);
  assertClosedObject(raw.initialInventory, ["available", "on_hand"]);
  assertInteger(raw.initialInventory.available, "Synthetic available inventory must be a safe integer.");
  assertInteger(raw.initialInventory.on_hand, "Synthetic on-hand inventory must be a safe integer.");

  assertClosedObject(raw.requestedCosts, DOCUMENT_IDS);
  for (const id of DOCUMENT_IDS) {
    assertInteger(raw.requestedCosts[id], "Synthetic request costs must be safe integers.");
    if (raw.requestedCosts[id] < 0) {
      throw new TypeError("Synthetic request costs must be non-negative.");
    }
  }

  const evidenceProfile = raw.evidenceProfile ?? "consistent";
  if (!EVIDENCE_PROFILES.includes(evidenceProfile)) {
    throw new TypeError("The synthetic evidence profile is outside the closed fixture set.");
  }

  return deepFreeze({
    kind: "synthetic_t1_data_fixture",
    initial_inventory: structuredClone(raw.initialInventory),
    requested_costs: structuredClone(raw.requestedCosts),
    evidence_profile: evidenceProfile,
  });
}
