export const AUTHORITY_POLICY_VERSION = "doa2ai.authority-policy.v1";
export const IMPACT_VERSION = "doa2ai.impact.v1";

const HASH = /^[a-f0-9]{64}$/;
const RULE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const EFFECTS = new Set(["read", "change", "external", "unknown"]);
const RECIPIENTS = new Set(["external", "self", "none", "unknown"]);
const CONFIDENCE = new Set(["high", "medium", "low", "unknown"]);
const DECISIONS = new Set(["allow", "ask", "block"]);
const RULE_SCOPES = new Set(["task", "site_tool", "universal"]);
const IMPACT_FIELDS = new Set([
  "version",
  "effect",
  "reversible",
  "sensitive_data",
  "credential",
  "security",
  "destructive",
  "human_presence",
  "recipient",
  "financial",
  "source",
  "confidence",
  "issues",
  "sufficient",
]);
const TRUSTED_IMPACTS = new WeakSet();

export class PolicyError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "PolicyError";
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("not JSON");
    return JSON.parse(encoded);
  } catch {
    throw new PolicyError("NON_JSON_VALUE");
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const STARTER_RULE_DEFINITIONS = deepFreeze([
  {
    id: "starter.block.prohibited",
    decision: "block",
    title: "Block credential, security, and destructive actions",
    description: "These actions cannot be authorized through the V1 agent path.",
  },
  {
    id: "starter.ask.human_presence",
    decision: "ask",
    title: "Require a person for final payment or submission",
    description: "Checkout, payment, purchase, and final-submit tools require one exact transaction decision.",
  },
  {
    id: "starter.ask.consequential",
    decision: "ask",
    title: "Review consequential actions",
    description: "External, sensitive, financial, and irreversible actions pause at the exact authority boundary.",
  },
  {
    id: "starter.allow.low-sensitivity-read",
    decision: "allow",
    title: "Allow bounded low-sensitivity reads",
    description: "Cooperative page reads with complete low-sensitivity impact evidence may proceed.",
  },
  {
    id: "starter.ask.uncertain",
    decision: "ask",
    title: "Review uncertain actions",
    description: "Missing, untrusted, changed, or incomplete impact evidence never inherits authority.",
  },
]);

/** Returns the actual built-in rules used by starter-policy evaluation. */
export function starterRuleCatalog({ confirmed = false } = {}) {
  return deepFreeze(STARTER_RULE_DEFINITIONS.map((rule) => ({
    ...rule,
    scope: "built_in",
    active: confirmed === true,
    confirmed: confirmed === true,
    revocable: false,
  })));
}

function cleanText(value, maximum = 500) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}

function normalizeInstant(value, field, { nullable = true } = {}) {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  if (typeof value !== "string") throw new PolicyError("INVALID_TIMESTAMP", field);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new PolicyError("INVALID_TIMESTAMP", field);
  }
  return value;
}

function nowInstant(value) {
  const candidate = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(candidate)) throw new PolicyError("INVALID_CURRENT_TIME");
  return candidate;
}

function normalizeOrigin(value, field = "origin") {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.origin !== url.href.replace(/\/$/, "")) {
      throw new Error("not an exact HTTPS origin");
    }
    return url.origin;
  } catch {
    throw new PolicyError("INVALID_ORIGIN", field);
  }
}

function addIssue(issues, field, code) {
  issues.push(Object.freeze({ field, code }));
}

/**
 * Converts target-supplied impact evidence into one closed, conservative shape.
 * It never grants authority; `issues` and `sufficient` tell the policy evaluator
 * whether reusable authority can safely be compared with this evidence.
 */
export function normalizeImpact(raw) {
  const input = isRecord(raw) ? raw : {};
  const issues = [];
  if (!isRecord(raw)) addIssue(issues, "impact", "missing_or_invalid");
  for (const key of Object.keys(input)) {
    if (!IMPACT_FIELDS.has(key)) addIssue(issues, key, "unknown_field");
  }
  if (input.version !== IMPACT_VERSION) addIssue(issues, "version", "missing_or_unsupported");

  const effect = EFFECTS.has(input.effect) ? input.effect : "unknown";
  if (!EFFECTS.has(input.effect) || effect === "unknown") addIssue(issues, "effect", "unknown");

  const recipient = RECIPIENTS.has(input.recipient) ? input.recipient : "unknown";
  if (!RECIPIENTS.has(input.recipient) || recipient === "unknown") addIssue(issues, "recipient", "unknown");

  const reversible = input.reversible === true || input.reversible === false || input.reversible === null
    ? input.reversible
    : null;
  if (!(input.reversible === true || input.reversible === false || input.reversible === null)) {
    addIssue(issues, "reversible", "unknown");
  }

  const sensitiveData = input.sensitive_data === true || input.sensitive_data === false || input.sensitive_data === null
    ? input.sensitive_data
    : null;
  if (!(input.sensitive_data === true || input.sensitive_data === false || input.sensitive_data === null)) {
    addIssue(issues, "sensitive_data", "unknown");
  }

  const flags = {};
  for (const field of ["credential", "security", "destructive"]) {
    flags[field] = input[field] === true;
    if (typeof input[field] !== "boolean") addIssue(issues, field, "unknown");
  }
  const humanPresence = input.human_presence === true;
  if (input.human_presence !== undefined && typeof input.human_presence !== "boolean") {
    addIssue(issues, "human_presence", "unknown");
  }

  let financial = null;
  if (input.financial === null) {
    financial = null;
  } else if (
    isRecord(input.financial)
    && Object.keys(input.financial).every((key) => ["amount", "currency"].includes(key))
    && Number.isFinite(input.financial.amount)
    && input.financial.amount >= 0
    && typeof input.financial.currency === "string"
    && /^[A-Z]{3}$/.test(input.financial.currency)
  ) {
    financial = Object.freeze({ amount: input.financial.amount, currency: input.financial.currency });
  } else {
    addIssue(issues, "financial", "unknown_or_invalid");
  }

  const source = cleanText(input.source, 160) || "unknown";
  if (source === "unknown") addIssue(issues, "source", "unknown");
  const confidence = CONFIDENCE.has(input.confidence) ? input.confidence : "unknown";
  if (!CONFIDENCE.has(input.confidence) || confidence === "unknown") addIssue(issues, "confidence", "unknown");

  const normalized = {
    version: IMPACT_VERSION,
    effect,
    reversible,
    sensitive_data: sensitiveData,
    credential: flags.credential,
    security: flags.security,
    destructive: flags.destructive,
    human_presence: humanPresence,
    recipient,
    financial,
    source,
    confidence,
    issues,
    sufficient: issues.length === 0 && confidence === "high",
  };
  return deepFreeze(normalized);
}

/**
 * Marks one extension-derived classification as trusted for this worker
 * lifetime. Target/page objects cannot preserve or forge the private brand.
 */
export function attestImpact(raw) {
  const normalized = normalizeImpact({ ...cloneJson(raw), version: IMPACT_VERSION });
  TRUSTED_IMPACTS.add(normalized);
  return normalized;
}

function normalizeImpactMatch(raw, field = "impact") {
  if (!isRecord(raw)) throw new PolicyError("INVALID_RULE_IMPACT", field);
  const allowed = new Set([
    "effects",
    "reversible",
    "sensitive_data",
    "credential",
    "security",
    "destructive",
    "human_presence",
    "recipients",
    "max_financial_amount",
    "financial_currency",
  ]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new PolicyError("UNKNOWN_RULE_IMPACT_FIELD", key);
  if (Object.keys(raw).length === 0) throw new PolicyError("EMPTY_RULE_IMPACT", field);
  const result = {};
  if (Object.hasOwn(raw, "effects")) {
    if (!Array.isArray(raw.effects) || raw.effects.length === 0 || raw.effects.some((entry) => !EFFECTS.has(entry) || entry === "unknown")) {
      throw new PolicyError("INVALID_RULE_EFFECTS", field);
    }
    result.effects = [...new Set(raw.effects)].sort();
  }
  if (Object.hasOwn(raw, "recipients")) {
    if (!Array.isArray(raw.recipients) || raw.recipients.length === 0 || raw.recipients.some((entry) => !RECIPIENTS.has(entry) || entry === "unknown")) {
      throw new PolicyError("INVALID_RULE_RECIPIENTS", field);
    }
    result.recipients = [...new Set(raw.recipients)].sort();
  }
  for (const key of ["reversible", "sensitive_data", "credential", "security", "destructive", "human_presence"]) {
    if (Object.hasOwn(raw, key)) {
      if (typeof raw[key] !== "boolean") throw new PolicyError("INVALID_RULE_BOOLEAN", `${field}.${key}`);
      result[key] = raw[key];
    }
  }
  if (Object.hasOwn(raw, "max_financial_amount")) {
    if (!Number.isFinite(raw.max_financial_amount) || raw.max_financial_amount < 0) {
      throw new PolicyError("INVALID_RULE_FINANCIAL_LIMIT", field);
    }
    if (typeof raw.financial_currency !== "string" || !/^[A-Z]{3}$/.test(raw.financial_currency)) {
      throw new PolicyError("INVALID_RULE_CURRENCY", field);
    }
    result.max_financial_amount = raw.max_financial_amount;
    result.financial_currency = raw.financial_currency;
  } else if (Object.hasOwn(raw, "financial_currency")) {
    throw new PolicyError("RULE_CURRENCY_WITHOUT_LIMIT", field);
  }
  return deepFreeze(result);
}

function normalizeRule(raw, { candidate = false } = {}) {
  if (!isRecord(raw)) throw new PolicyError("INVALID_RULE");
  const id = cleanText(raw.id, 160);
  if (!RULE_ID.test(id)) throw new PolicyError("INVALID_RULE_ID");
  if (!RULE_SCOPES.has(raw.scope)) throw new PolicyError("INVALID_RULE_SCOPE", id);
  if (!DECISIONS.has(raw.decision)) throw new PolicyError("INVALID_RULE_DECISION", id);
  const confirmed = raw.confirmed === true;
  if (!candidate && !confirmed) throw new PolicyError("UNCONFIRMED_RULE", id);
  const result = {
    id,
    scope: raw.scope,
    decision: raw.decision,
    confirmed,
    impact: normalizeImpactMatch(raw.impact, `${id}.impact`),
    expiresAt: normalizeInstant(raw.expiresAt, `${id}.expiresAt`),
    revokedAt: normalizeInstant(raw.revokedAt, `${id}.revokedAt`),
  };
  if (raw.scope === "task") {
    result.taskId = cleanText(raw.taskId, 160);
    result.connectionId = cleanText(raw.connectionId, 160);
    if (!result.taskId || !result.connectionId) throw new PolicyError("TASK_RULE_BINDING_REQUIRED", id);
  }
  const exactToolBindingRequired = raw.scope === "site_tool"
    || (raw.decision === "allow" && ["task", "universal"].includes(raw.scope));
  if (exactToolBindingRequired) {
    result.origin = normalizeOrigin(raw.origin, `${id}.origin`);
    result.toolName = cleanText(raw.toolName, 128);
    result.toolDigest = cleanText(raw.toolDigest, 64);
    if (!TOOL_NAME.test(result.toolName) || !HASH.test(result.toolDigest)) {
      throw new PolicyError("SITE_TOOL_RULE_BINDING_REQUIRED", id);
    }
  }
  if (raw.decision === "allow") {
    result.argumentDigest = cleanText(raw.argumentDigest, 64);
    if (!HASH.test(result.argumentDigest)) throw new PolicyError("ALLOW_RULE_ARGUMENT_BINDING_REQUIRED", id);
  }
  return deepFreeze(result);
}

function normalizeApproval(raw) {
  if (!isRecord(raw)) throw new PolicyError("INVALID_TRANSACTION_APPROVAL");
  const id = cleanText(raw.id, 160);
  const actionDigest = cleanText(raw.actionDigest, 64);
  if (!RULE_ID.test(id) || !HASH.test(actionDigest)) throw new PolicyError("INVALID_TRANSACTION_BINDING");
  if (raw.confirmed !== true) throw new PolicyError("UNCONFIRMED_TRANSACTION_APPROVAL", id);
  const decision = raw.decision ?? "allow";
  if (decision !== "allow") throw new PolicyError("INVALID_TRANSACTION_DECISION", id);
  const taskId = cleanText(raw.taskId, 160);
  const connectionId = cleanText(raw.connectionId, 160);
  if (!taskId || !connectionId) throw new PolicyError("TRANSACTION_CONTEXT_BINDING_REQUIRED", id);
  return deepFreeze({
    id,
    actionDigest,
    decision,
    confirmed: true,
    taskId,
    connectionId,
    expiresAt: normalizeInstant(raw.expiresAt, `${id}.expiresAt`, { nullable: false }),
    consumedAt: normalizeInstant(raw.consumedAt, `${id}.consumedAt`),
  });
}

/** Creates the deterministic onboarding policy. It grants nothing until confirmed. */
export function createStarterPolicy({ confirmed = false, revision = "starter-v1" } = {}) {
  return deepFreeze({
    version: AUTHORITY_POLICY_VERSION,
    revision: cleanText(revision, 160) || "starter-v1",
    globalPaused: false,
    starter: Object.freeze({ version: "balanced-v1", confirmed: confirmed === true }),
    hardBlocks: [],
    transactionApprovals: [],
    rules: [],
  });
}

/** Strictly validates durable policy state. Invalid policy must be treated as blocked. */
export function normalizePolicy(raw) {
  if (!isRecord(raw)) throw new PolicyError("INVALID_POLICY");
  if (raw.version !== AUTHORITY_POLICY_VERSION) throw new PolicyError("UNSUPPORTED_POLICY_VERSION");
  const revision = cleanText(raw.revision, 160);
  if (!revision) throw new PolicyError("INVALID_POLICY_REVISION");
  if (!isRecord(raw.starter) || raw.starter.version !== "balanced-v1" || typeof raw.starter.confirmed !== "boolean") {
    throw new PolicyError("INVALID_STARTER_POLICY");
  }
  if (typeof raw.globalPaused !== "boolean") throw new PolicyError("INVALID_GLOBAL_PAUSE_STATE");
  if (!Array.isArray(raw.hardBlocks) || !Array.isArray(raw.transactionApprovals) || !Array.isArray(raw.rules)) {
    throw new PolicyError("INVALID_POLICY_COLLECTIONS");
  }
  const hardBlocks = raw.hardBlocks.map((entry) => {
    const normalized = normalizeRule({ ...entry, decision: "block", confirmed: entry?.confirmed }, { candidate: false });
    return normalized;
  });
  const transactionApprovals = raw.transactionApprovals.map(normalizeApproval);
  const rules = raw.rules.map((entry) => normalizeRule(entry));
  const ids = [...hardBlocks, ...transactionApprovals, ...rules].map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw new PolicyError("DUPLICATE_POLICY_ENTRY_ID");
  const byId = (left, right) => left.id.localeCompare(right.id);
  return deepFreeze({
    version: AUTHORITY_POLICY_VERSION,
    revision,
    globalPaused: raw.globalPaused === true,
    starter: Object.freeze({ version: "balanced-v1", confirmed: raw.starter.confirmed }),
    hardBlocks: hardBlocks.sort(byId),
    transactionApprovals: transactionApprovals.sort(byId),
    rules: rules.sort(byId),
  });
}

function activeAt(entry, currentTime) {
  if (entry.revokedAt) return false;
  if (entry.expiresAt && Date.parse(entry.expiresAt) <= currentTime) return false;
  return true;
}

function impactMatches(match, impact) {
  if (match.effects && !match.effects.includes(impact.effect)) return false;
  if (match.recipients && !match.recipients.includes(impact.recipient)) return false;
  for (const key of ["reversible", "sensitive_data", "credential", "security", "destructive", "human_presence"]) {
    if (Object.hasOwn(match, key) && match[key] !== impact[key]) return false;
  }
  if (Object.hasOwn(match, "max_financial_amount")) {
    if (!impact.financial) return false;
    if (impact.financial.currency !== match.financial_currency) return false;
    if (impact.financial.amount > match.max_financial_amount) return false;
  }
  return true;
}

function scopeMatches(rule, context) {
  const toolMatches = !rule.origin || (
    rule.origin === context.origin
    && rule.toolName === context.toolName
    && rule.toolDigest === context.toolDigest
  );
  const argumentsMatch = rule.decision !== "allow" || rule.argumentDigest === context.argumentDigest;
  if (rule.scope === "universal") return toolMatches && argumentsMatch;
  if (rule.scope === "task") {
    return rule.taskId === context.task?.taskId
      && rule.connectionId === context.connection?.connectionId
      && toolMatches
      && argumentsMatch;
  }
  return rule.origin === context.origin
    && rule.toolName === context.toolName
    && rule.toolDigest === context.toolDigest
    && argumentsMatch;
}

function entryDecision(entry, source, impact) {
  return deepFreeze({
    decision: entry.decision,
    authorityMode: entry.decision === "allow" ? "delegated_authority" : null,
    source,
    reason: `${source}:${entry.decision}`,
    ruleId: entry.id,
    impact,
  });
}

function availability(record, currentTime, { expiryRequired = false } = {}) {
  if (!isRecord(record)) return "unknown";
  if (["revoked", "ended", "expired", "paused"].includes(record.status)) return record.status;
  if (record.status !== "active") return "unknown";
  if (record.expiresAt === null || record.expiresAt === undefined) return expiryRequired ? "unknown" : "active";
  const expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== record.expiresAt) return "unknown";
  return expiresAt <= currentTime ? "expired" : "active";
}

function contextBindingValid(context) {
  if (!HASH.test(cleanText(context.actionDigest, 64))) return false;
  if (!HASH.test(cleanText(context.argumentDigest, 64))) return false;
  if (!cleanText(context.task?.taskId, 160) || !cleanText(context.connection?.connectionId, 160)) return false;
  if (!TOOL_NAME.test(cleanText(context.toolName, 128)) || !HASH.test(cleanText(context.toolDigest, 64))) return false;
  try {
    return normalizeOrigin(context.origin) === context.origin;
  } catch {
    return false;
  }
}

function starterRuleDecision(ruleId, impact, { source = "starter", reason = ruleId } = {}) {
  const rule = STARTER_RULE_DEFINITIONS.find((entry) => entry.id === ruleId);
  if (!rule) throw new PolicyError("UNKNOWN_STARTER_RULE", ruleId);
  return {
    decision: rule.decision,
    authorityMode: rule.decision === "allow" ? "delegated_authority" : null,
    source,
    reason,
    ruleId,
    impact,
  };
}

function starterDecision(impact, trusted) {
  if (impact.credential || impact.security || impact.destructive) {
    return starterRuleDecision("starter.block.prohibited", impact, { reason: "starter:prohibited" });
  }
  if (!trusted) {
    return starterRuleDecision("starter.ask.uncertain", impact, { source: "uncertain", reason: "impact:untrusted" });
  }
  if (!impact.sufficient) {
    return starterRuleDecision("starter.ask.uncertain", impact, { source: "uncertain", reason: "impact:insufficient" });
  }
  const hasFinancialEffect = impact.financial && impact.financial.amount > 0;
  if (
    impact.effect === "external"
    || impact.recipient === "external"
    || impact.sensitive_data
    || impact.reversible === false
    || hasFinancialEffect
    || impact.human_presence
  ) {
    const ruleId = impact.human_presence ? "starter.ask.human_presence" : "starter.ask.consequential";
    return starterRuleDecision(ruleId, impact, {
      reason: impact.human_presence ? "starter:human_presence_required" : "starter:review_required",
    });
  }
  const lowSensitivityRead = impact.effect === "read"
    && impact.sensitive_data === false
    && ["none", "self"].includes(impact.recipient);
  if (lowSensitivityRead) {
    return starterRuleDecision("starter.allow.low-sensitivity-read", impact, { reason: "starter:in_bounds" });
  }
  return starterRuleDecision("starter.ask.uncertain", impact, { source: "uncertain", reason: "impact:unmatched" });
}

/**
 * Pure authority comparison. It does not consume approvals or mutate tasks.
 * Callers must persist approval consumption before dispatch.
 */
export function evaluateAuthority(rawPolicy, context = {}) {
  const impactTrusted = isRecord(context.impact) && TRUSTED_IMPACTS.has(context.impact);
  const impact = impactTrusted ? context.impact : normalizeImpact(context.impact);
  let policy;
  try {
    policy = normalizePolicy(rawPolicy);
  } catch (error) {
    return deepFreeze({
      decision: "block",
      authorityMode: null,
      source: "policy_invalid",
      reason: error instanceof PolicyError ? error.code : "INVALID_POLICY",
      impact,
    });
  }
  let currentTime;
  try {
    currentTime = nowInstant(context.now ?? Date.now());
  } catch (error) {
    return deepFreeze({ decision: "block", authorityMode: null, source: "clock_invalid", reason: error.code, impact });
  }
  if (policy.globalPaused) {
    return deepFreeze({ decision: "block", authorityMode: null, source: "global_pause", reason: "execution_paused", impact });
  }

  for (const rule of policy.hardBlocks) {
    if (activeAt(rule, currentTime) && scopeMatches(rule, context) && impactMatches(rule.impact, impact)) {
      return entryDecision(rule, "hard_block", impact);
    }
  }
  // V1 does not expose an override path for credential, security, or
  // destructive operations. Keep this invariant ahead of one-time approvals
  // and reusable rules so persisted authority can never weaken it.
  if (impact.credential || impact.security || impact.destructive) {
    return deepFreeze(starterRuleDecision("starter.block.prohibited", impact, {
      source: "v1_prohibited",
      reason: "v1:prohibited",
    }));
  }

  const taskAvailability = availability(context.task, currentTime, { expiryRequired: true });
  if (taskAvailability !== "active") {
    const uncertain = taskAvailability === "unknown";
    return deepFreeze({
      decision: uncertain ? "ask" : "block",
      authorityMode: null,
      source: uncertain ? "task_unknown" : "task_inactive",
      reason: `task:${taskAvailability}`,
      impact,
    });
  }
  const connectionAvailability = availability(context.connection, currentTime);
  if (connectionAvailability !== "active") {
    const uncertain = connectionAvailability === "unknown";
    return deepFreeze({
      decision: uncertain ? "ask" : "block",
      authorityMode: null,
      source: uncertain ? "connection_unknown" : "connection_inactive",
      reason: `connection:${connectionAvailability}`,
      impact,
    });
  }
  if (!contextBindingValid(context)) {
    return deepFreeze({ decision: "ask", authorityMode: null, source: "context_invalid", reason: "exact_action_binding_required", impact });
  }

  const actionDigest = cleanText(context.actionDigest, 64);
  for (const approval of policy.transactionApprovals) {
    if (
      !approval.consumedAt
      && Date.parse(approval.expiresAt) > currentTime
      && approval.actionDigest === actionDigest
      && approval.taskId === context.task?.taskId
      && approval.connectionId === context.connection?.connectionId
    ) {
      return deepFreeze({
        decision: "allow",
        authorityMode: "transaction_authorization",
        source: "transaction_approval",
        reason: "exact_action_approved",
        approvalId: approval.id,
        impact,
      });
    }
  }

  // Human-presence actions can use only the exact, one-time transaction path
  // above. Durable rules cannot bypass a final checkout/payment/submit decision.
  if (impact.human_presence) {
    return deepFreeze(starterRuleDecision("starter.ask.human_presence", impact, {
      reason: "starter:human_presence_required",
    }));
  }

  const severity = { block: 0, ask: 1, allow: 2 };
  for (const scope of ["task", "site_tool", "universal"]) {
    const matching = policy.rules
      .filter((rule) => rule.scope === scope && activeAt(rule, currentTime) && scopeMatches(rule, context) && impactMatches(rule.impact, impact))
      .sort((left, right) => severity[left.decision] - severity[right.decision] || left.id.localeCompare(right.id));
    if (matching.length > 0) {
      const selected = matching[0];
      if (selected.decision === "allow" && !impactTrusted) continue;
      return entryDecision(selected, `${scope}_rule`, impact);
    }
  }

  if (policy.starter.confirmed) return deepFreeze(starterDecision(impact, impactTrusted));
  return deepFreeze({ decision: "ask", authorityMode: null, source: "starter_unconfirmed", reason: "starter_confirmation_required", impact });
}

/**
 * Wraps an external/UI compiler's structured interpretation of free-form text.
 * The result is deliberately unconfirmed and therefore cannot enter policy.
 */
export function compileRuleDraft(text, structuredRule) {
  const sourceText = cleanText(text, 2_000);
  if (!sourceText) throw new PolicyError("EMPTY_RULE_DRAFT");
  const rule = normalizeRule({ ...cloneJson(structuredRule), confirmed: false }, { candidate: true });
  return deepFreeze({
    version: "doa2ai.rule-candidate.v1",
    candidateId: `candidate:${rule.id}`,
    sourceText,
    status: "candidate",
    rule,
  });
}

/** Converts one visible candidate into authority only after explicit confirmation. */
export function confirmRuleCandidate(candidate, { confirmed = false } = {}) {
  if (!isRecord(candidate) || candidate.version !== "doa2ai.rule-candidate.v1" || candidate.status !== "candidate") {
    throw new PolicyError("INVALID_RULE_CANDIDATE");
  }
  if (confirmed !== true) throw new PolicyError("RULE_CONFIRMATION_REQUIRED");
  return normalizeRule({ ...cloneJson(candidate.rule), confirmed: true });
}
