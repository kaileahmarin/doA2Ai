const OUTCOME_COPY = Object.freeze({
  executed: Object.freeze({
    tone: "success",
    eyebrow: "Verified match",
    title: "Local fixture complete",
    subtitle: "The local fixture recorded exactly what you authorized.",
    consequenceLabel: "Authorized brief length · local fixture",
    consequenceKind: "authorized",
    consequenceDetail: "Recorded after exact-state verification",
    comparedState: "executed_state",
    executedLabel: "Local execution",
    badge: "Exact match",
    divergence: false,
  }),
  denied: Object.freeze({
    tone: "neutral",
    eyebrow: "Authorization denied",
    title: "Nothing was executed",
    subtitle: "Your decision was recorded; no execution was attempted.",
    consequenceLabel: "No external action",
    consequenceKind: "zero",
    consequenceDetail: "The prepared local fixture was not executed",
    comparedState: null,
    executedLabel: "Local execution",
    badge: "Not attempted",
    divergence: false,
  }),
  blocked_divergent: Object.freeze({
    tone: "blocked",
    eyebrow: "Divergence detected",
    title: "Execution blocked",
    subtitle: "The candidate changed before commit, so the local fixture did not execute it.",
    consequenceLabel: "No external action",
    consequenceKind: "zero",
    consequenceDetail: "A new authorization is required",
    comparedState: "attempted_state",
    executedLabel: "Local attempt",
    badge: "Blocked",
    divergence: true,
  }),
  blocked_expired: Object.freeze({
    tone: "blocked",
    eyebrow: "Authorization expired",
    title: "Nothing was executed",
    subtitle: "The one-time authorization expired before the local fixture could use it.",
    consequenceLabel: "No external action",
    consequenceKind: "zero",
    consequenceDetail: "Review and authorize the current state again",
    comparedState: null,
    executedLabel: "Local execution",
    badge: "Expired",
    divergence: false,
  }),
  blocked_brief_expired: Object.freeze({
    tone: "blocked",
    eyebrow: "Fixture expired",
    title: "Nothing was executed",
    subtitle: "The prepared brief expired before commit, so the local run stopped.",
    consequenceLabel: "No external action",
    consequenceKind: "zero",
    consequenceDetail: "A fresh fixture and authorization are required",
    comparedState: null,
    executedLabel: "Local execution",
    badge: "Expired",
    divergence: false,
  }),
  execution_failed: Object.freeze({
    tone: "critical",
    eyebrow: "Execution not verified",
    title: "Outcome needs review",
    subtitle: "The local fixture could not verify whether its operation completed.",
    consequenceLabel: "Execution status",
    consequenceKind: "unknown",
    consequenceDetail: "Do not retry until the result is reconciled",
    comparedState: null,
    comparedEmptyLabel: "Unknown",
    executedLabel: "Local result",
    badge: "Unknown",
    divergence: false,
  }),
  executed_divergent: Object.freeze({
    tone: "critical",
    eyebrow: "Executed state diverged",
    title: "Mismatch recorded after execution",
    subtitle: "The committed result did not match the exact state you authorized.",
    consequenceLabel: "Recorded brief length · local fixture",
    consequenceKind: "executed",
    consequenceDetail: "Immediate reconciliation is required",
    comparedState: "executed_state",
    executedLabel: "Local execution",
    badge: "Divergent",
    divergence: true,
  }),
});

const UNKNOWN_COPY = Object.freeze({
  tone: "critical",
  eyebrow: "Recorded outcome",
  title: "Outcome needs review",
  subtitle: "This receipt contains an outcome the interface does not recognize.",
  consequenceLabel: "Execution status",
  consequenceKind: "unknown",
  consequenceDetail: "Inspect the exported receipt before taking another action",
  comparedState: null,
  comparedEmptyLabel: "Unknown",
  executedLabel: "Local result",
  badge: "Review",
  divergence: false,
});

export function receiptOutcomeCopy(outcome) {
  return OUTCOME_COPY[outcome] ?? UNKNOWN_COPY;
}

function redactValue(value, seen = new WeakMap()) {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);

  const safe = Array.isArray(value) ? [] : {};
  seen.set(value, safe);
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === "human_only") continue;
    Object.defineProperty(safe, key, {
      value: redactValue(nestedValue, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return safe;
}

export function redactReceipt(value) {
  return redactValue(value);
}
