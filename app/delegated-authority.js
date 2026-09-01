const ACTIVE_GRANT_STATE = "active";
const CONSUMED_GRANT_STATE = "consumed";
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const CLAIM_KEYS = new Set(["grant_id", "proposed_action"]);
const ACTION_KEYS = new Set(["operation", "resource", "terms"]);
const GRANT_KEYS = new Set([
  "grant_id",
  "state",
  "valid_from",
  "expires_at",
  "single_use",
  "scope",
  "consumed_at",
]);
const SCOPE_KEYS = new Set(["operation", "resource", "terms"]);
const KNOWN_TERM_KEYS = new Set(["status", "value"]);
const UNKNOWN_TERM_KEYS = new Set(["status"]);
const RULE_KEYS = new Set(["match", "value"]);

function isRecord(value) {
  try {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function isJsonValue(value, ancestors = new Set()) {
  if (value == null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!Array.isArray(value) && !isRecord(value)) return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  try {
    const enumerableKeys = Object.keys(value);
    const ownKeys = Reflect.ownKeys(value).filter((key) => !(Array.isArray(value) && key === "length"));
    if (ownKeys.length !== enumerableKeys.length || ownKeys.some((key) => typeof key !== "string")) return false;

    if (Array.isArray(value)) {
      if (enumerableKeys.length !== value.length) return false;
      for (let index = 0; index < value.length; index += 1) {
        if (enumerableKeys[index] !== String(index)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !isJsonValue(descriptor.value, ancestors)) return false;
      }
      return true;
    }

    for (const key of enumerableKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !isJsonValue(descriptor.value, ancestors)) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

function cloneJson(value) {
  if (!isJsonValue(value)) return null;
  try {
    return structuredClone(value);
  } catch {
    return null;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameJson(left, right) {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
}

function difference(field, semantic_difference, delegated, proposed) {
  return {
    field,
    semantic_difference,
    delegated: cloneJson(delegated),
    proposed: cloneJson(proposed),
  };
}

function docket(grantId, differences) {
  return {
    status: "docket_required",
    docket: {
      type: "delegated_authority_boundary",
      grant_id: isNonEmptyString(grantId) ? grantId : null,
      differences,
    },
  };
}

function unexpectedKeys(record, allowed) {
  return Object.keys(record).filter((key) => !allowed.has(key)).sort();
}

function parseUtcInstant(value) {
  if (typeof value !== "string" || !UTC_INSTANT.test(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) return null;
  return date;
}

function readClock(clock) {
  try {
    const value = clock();
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
    }
    return parseUtcInstant(value);
  } catch {
    return null;
  }
}

function readGrantId(value) {
  try {
    return isRecord(value) && isNonEmptyString(value.grant_id) ? value.grant_id : null;
  } catch {
    return null;
  }
}

function hasExactKeys(record, expected) {
  const keys = Object.keys(record);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function isKnownTerm(term) {
  return (
    isRecord(term) &&
    hasExactKeys(term, KNOWN_TERM_KEYS) &&
    term.status === "known" &&
    isJsonValue(term.value)
  );
}

function isUnknownTerm(term) {
  return isRecord(term) && hasExactKeys(term, UNKNOWN_TERM_KEYS) && term.status === "unknown";
}

function claimShapeDifferences(claim) {
  const differences = unexpectedKeys(claim, CLAIM_KEYS).map((key) =>
    difference(`claim.${key}`, "not_in_contract", "closed claim envelope", claim[key]),
  );
  if (!isNonEmptyString(claim.grant_id)) {
    differences.push(difference("grant_id", "uncertain", "recorded grant identifier", claim.grant_id ?? null));
  }
  if (!Object.hasOwn(claim, "proposed_action")) {
    differences.push(difference("proposed_action", "uncertain", "exact action envelope", null));
  }
  return differences;
}

function actionShapeDifferences(action) {
  if (!isRecord(action)) {
    return [difference("proposed_action", "uncertain", "closed action envelope", null)];
  }

  const differences = unexpectedKeys(action, ACTION_KEYS).map((key) =>
    difference(`proposed_action.${key}`, "not_in_contract", "closed action envelope", action[key]),
  );
  if (!isNonEmptyString(action.operation)) {
    differences.push(difference("operation", "uncertain", "exact operation", action.operation ?? null));
  }
  if (!isNonEmptyString(action.resource)) {
    differences.push(difference("resource", "uncertain", "exact resource", action.resource ?? null));
  }
  if (!isRecord(action.terms) || Object.keys(action.terms).length === 0) {
    differences.push(difference("terms", "uncertain", "known terms", action.terms ?? null));
    return differences;
  }

  for (const termName of Object.keys(action.terms).sort()) {
    const term = action.terms[termName];
    if (!isNonEmptyString(termName) || (!isKnownTerm(term) && !isUnknownTerm(term))) {
      differences.push(difference(`terms.${termName}`, "uncertain", "closed known or unknown term", term ?? null));
    }
  }
  return differences;
}

function isDelegatedRule(rule) {
  if (!isRecord(rule) || !hasExactKeys(rule, RULE_KEYS)) return false;
  if (rule.match === "exact") return isJsonValue(rule.value);
  return rule.match === "at_most" && Number.isFinite(rule.value);
}

function grantContractDifferences(grant, grantId) {
  const differences = unexpectedKeys(grant, GRANT_KEYS).map((key) =>
    difference(`grant.${key}`, "invalid_grant", "closed grant envelope", grant[key]),
  );
  if (grant.grant_id !== grantId) {
    differences.push(difference("grant_id", "invalid_grant", grantId, grant.grant_id ?? null));
  }
  if (
    Object.hasOwn(grant, "consumed_at") &&
    grant.consumed_at != null &&
    !parseUtcInstant(grant.consumed_at)
  ) {
    differences.push(difference("consumed_at", "invalid_grant", "strict UTC instant", grant.consumed_at));
  }
  return differences;
}

function scopeShapeDifferences(scope) {
  if (!isRecord(scope)) {
    return [difference("scope", "invalid_grant", "closed action scope", null)];
  }

  const differences = unexpectedKeys(scope, SCOPE_KEYS).map((key) =>
    difference(`scope.${key}`, "invalid_grant", "closed action scope", scope[key]),
  );
  if (!isNonEmptyString(scope.operation)) {
    differences.push(difference("scope.operation", "invalid_grant", "exact operation", scope.operation ?? null));
  }
  if (!isNonEmptyString(scope.resource)) {
    differences.push(difference("scope.resource", "invalid_grant", "exact resource", scope.resource ?? null));
  }
  if (!isRecord(scope.terms) || Object.keys(scope.terms).length === 0) {
    differences.push(difference("scope.terms", "invalid_grant", "precise term rules", scope.terms ?? null));
    return differences;
  }

  for (const termName of Object.keys(scope.terms).sort()) {
    if (!isNonEmptyString(termName) || !isDelegatedRule(scope.terms[termName])) {
      differences.push(
        difference(`scope.terms.${termName}`, "invalid_grant", "closed exact or at_most rule", scope.terms[termName] ?? null),
      );
    }
  }
  return differences;
}

function grantStateDifference(grant) {
  if (grant.state === CONSUMED_GRANT_STATE || grant.consumed_at != null) {
    return difference("state", "replayed", ACTIVE_GRANT_STATE, grant.state ?? null);
  }
  if (grant.state !== ACTIVE_GRANT_STATE) {
    return difference("state", "invalid_grant_state", ACTIVE_GRANT_STATE, grant.state ?? null);
  }
  if (grant.single_use !== true) {
    return difference("single_use", "invalid_grant", true, grant.single_use ?? null);
  }
  return null;
}

function grantFreshnessDifference(grant, now) {
  const validFrom = parseUtcInstant(grant.valid_from);
  const expiresAt = parseUtcInstant(grant.expires_at);
  if (!validFrom) {
    return difference("valid_from", "invalid_grant", "strict UTC instant", grant.valid_from ?? null);
  }
  if (!expiresAt || validFrom >= expiresAt) {
    return difference("expires_at", "invalid_grant", "later strict UTC instant", grant.expires_at ?? null);
  }
  if (now < validFrom) {
    return difference("valid_from", "not_current", grant.valid_from, now.toISOString());
  }
  if (now >= expiresAt) {
    return difference("expires_at", "stale", grant.expires_at, now.toISOString());
  }
  return null;
}

function actionScopeDifferences(scope, action) {
  const differences = [];
  if (scope.operation !== action.operation) {
    differences.push(difference("operation", "changed", scope.operation, action.operation));
  }
  if (scope.resource !== action.resource) {
    differences.push(difference("resource", "changed", scope.resource, action.resource));
  }

  for (const termName of Object.keys(scope.terms).sort()) {
    const rule = scope.terms[termName];
    if (!Object.hasOwn(action.terms, termName) || !isKnownTerm(action.terms[termName])) {
      differences.push(difference(`terms.${termName}`, "uncertain", rule, null));
      continue;
    }

    const value = action.terms[termName].value;
    if (rule.match === "exact" && !sameJson(rule.value, value)) {
      differences.push(difference(`terms.${termName}`, "changed", rule, value));
    }
    if (rule.match === "at_most") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        differences.push(difference(`terms.${termName}`, "uncertain", rule, value));
      } else if (value > rule.value) {
        differences.push(difference(`terms.${termName}`, "exceeded", rule, value));
      }
    }
  }

  for (const termName of Object.keys(action.terms).sort()) {
    if (!Object.hasOwn(scope.terms, termName)) {
      const term = action.terms[termName];
      differences.push(
        difference(`terms.${termName}`, "not_delegated", "no delegated rule", isKnownTerm(term) ? term.value : null),
      );
    }
  }

  return differences;
}

/**
 * A site-owned, domain-agnostic, in-memory proof of one delegated-authority
 * comparison-and-consumption path. Decisions can contain authority values and
 * must not be exposed as an agent tool. An eligible decision is not an
 * execution credential and this class models neither execution nor receipts.
 */
export class DelegatedAuthorityGate {
  #ambiguousGrantIds = new Set();
  #clock;
  #grants = new Map();
  #invalidGrantIds = new Set();

  constructor({ grants = [], clock = () => new Date() } = {}) {
    if (!Array.isArray(grants)) throw new TypeError("grants must be an array");
    if (typeof clock !== "function") throw new TypeError("clock must be a function");

    this.#clock = clock;
    const seenGrantIds = new Set();
    for (const candidate of grants) {
      const grantId = readGrantId(candidate);
      if (!grantId) continue;
      if (seenGrantIds.has(grantId)) {
        this.#grants.delete(grantId);
        this.#invalidGrantIds.delete(grantId);
        this.#ambiguousGrantIds.add(grantId);
        continue;
      }
      seenGrantIds.add(grantId);

      const grant = cloneJson(candidate);
      if (!grant) {
        this.#invalidGrantIds.add(grantId);
        continue;
      }
      this.#grants.set(grantId, grant);
    }
  }

  claim(input) {
    const grantId = readGrantId(input);
    if (!isRecord(input)) {
      return docket(grantId, [difference("claim", "uncertain", "closed JSON claim envelope", null)]);
    }

    const claim = cloneJson(input);
    if (!claim) {
      return docket(grantId, [difference("claim", "invalid_json", "closed JSON claim envelope", null)]);
    }

    const claimDifferences = claimShapeDifferences(claim);
    if (claimDifferences.length > 0) return docket(grantId, claimDifferences);
    if (this.#ambiguousGrantIds.has(grantId)) {
      return docket(grantId, [difference("grant_id", "invalid_grant", "one recorded grant", grantId)]);
    }
    if (this.#invalidGrantIds.has(grantId)) {
      return docket(grantId, [difference("grant_id", "invalid_grant", "closed JSON grant", grantId)]);
    }

    const grant = this.#grants.get(grantId);
    if (!grant) {
      return docket(grantId, [difference("grant_id", "unavailable", "current recorded grant", null)]);
    }

    const now = readClock(this.#clock);
    if (!now) {
      return docket(grantId, [difference("current_time", "uncertain", "valid clock value", null)]);
    }

    const contractDifferences = grantContractDifferences(grant, grantId);
    if (contractDifferences.length > 0) return docket(grantId, contractDifferences);

    const stateDifference = grantStateDifference(grant);
    if (stateDifference) return docket(grantId, [stateDifference]);

    const freshnessDifference = grantFreshnessDifference(grant, now);
    if (freshnessDifference) return docket(grantId, [freshnessDifference]);

    const scopeDifferences = scopeShapeDifferences(grant.scope);
    if (scopeDifferences.length > 0) return docket(grantId, scopeDifferences);

    const proposedActionDifferences = actionShapeDifferences(claim.proposed_action);
    if (proposedActionDifferences.length > 0) return docket(grantId, proposedActionDifferences);

    const differences = actionScopeDifferences(grant.scope, claim.proposed_action);
    if (differences.length > 0) return docket(grantId, differences);

    const consumedAt = now.toISOString();
    grant.state = CONSUMED_GRANT_STATE;
    grant.consumed_at = consumedAt;
    return {
      status: "eligible",
      authority: "delegated",
      grant_id: grant.grant_id,
      consumed_at: consumedAt,
      checked_action: cloneJson(claim.proposed_action),
    };
  }
}
