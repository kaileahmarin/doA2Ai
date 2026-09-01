import { redactReceipt } from "./receipt.js";

const TEN_MINUTES_MS = 10 * 60 * 1000;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 15 * 1000;
const EXECUTION_PAYLOAD_FIELDS = deepFreeze([
  "operation",
  "brief_id",
  "draft_id",
  "draft_version",
  "topic",
  "source_ids",
  "citation_style",
  "word_count",
  "audience",
  "share_date",
]);
const EXECUTION_PAYLOAD_FIELD_SET = new Set(EXECUTION_PAYLOAD_FIELDS);

export const TASK_STATES = Object.freeze([
  "preparing",
  "awaiting_human",
  "authorized",
  "executing",
  "verifying",
  "completed",
  "blocked",
  "cancelled",
  "failed",
]);

export const AUTHORITY_STATES = Object.freeze([
  "none",
  "proposed",
  "modified",
  "granted",
  "denied",
  "expired",
  "consumed",
  "divergent",
]);

export const RESEARCH_PACKET = deepFreeze({
  brief_id: "BRF-4821",
  topic: "Civic shade and heat resilience",
  source_set: [
    { source_id: "SRC-AR-01", title: "Open street-tree inventory", kind: "public dataset" },
    { source_id: "SRC-AR-02", title: "Municipal heat-action plan", kind: "public report" },
  ],
  required_source_ids: ["SRC-AR-01", "SRC-AR-02"],
  required_citation_style: "linked_endnotes",
  share_date: "2026-09-14",
});

const BRIEF_LENGTH_OPTIONS = deepFreeze({ concise: 600, standard: 900, detailed: 1200 });

function clone(value) {
  return value == null ? value : structuredClone(value);
}

const defaultExecutor = Object.freeze({
  async preflight(authorizedState, { simulate_divergence = false } = {}) {
    const candidate = clone(authorizedState);
    if (simulate_divergence) {
      candidate.word_count += 120;
      candidate.draft_version += 1;
    }
    return candidate;
  },
  async commit(candidateState) {
    return clone(candidateState);
  },
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function defaultIdFactory(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function defaultClock() {
  return new Date();
}

function iso(date) {
  return new Date(date).toISOString();
}

function assert(condition, message, code = "INVALID_STATE") {
  if (condition) return;
  const error = new Error(message);
  error.code = code;
  throw error;
}

function boundTaskLease(state, taskId, leaseId) {
  assert(taskId === state.task.id, "The task handle does not match the active task.", "TASK_MISMATCH");
  assert(leaseId === state.task.lease.id, "The execution lease does not match the active task.", "LEASE_MISMATCH");
}

function activeLease(state, taskId, leaseId, now) {
  boundTaskLease(state, taskId, leaseId);
  assert(state.task.lease.status !== "revoked", "The execution lease has been revoked.", "LEASE_REVOKED");
  assert(new Date(state.task.lease.expires_at) > now, "The execution lease has expired.", "LEASE_EXPIRED");
}

export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256(value) {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : canonicalize(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function compareStates(authorized, candidate) {
  const differences = [];

  function visit(left, right, path, leftPresent = true, rightPresent = true) {
    if (leftPresent && rightPresent && canonicalize(left) === canonicalize(right)) return;
    if (
      leftPresent && rightPresent && left && right && typeof left === "object" && typeof right === "object" &&
      !Array.isArray(left) && !Array.isArray(right)
    ) {
      const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
      for (const key of [...keys].sort()) {
        visit(left[key], right[key], path ? `${path}.${key}` : key, Object.hasOwn(left, key), Object.hasOwn(right, key));
      }
      return;
    }
    const difference = { field: path, authorized: left ?? null, candidate: right ?? null };
    if (!leftPresent || !rightPresent) {
      difference.authorized_present = leftPresent;
      difference.candidate_present = rightPresent;
    }
    differences.push(difference);
  }

  visit(authorized, candidate, "");
  return { status: differences.length === 0 ? "match" : "divergent", matched: differences.length === 0, differences };
}

function publicPayload(payload) {
  if (!payload) return payload;
  if (Array.isArray(payload)) return payload.map(publicPayload);
  if (typeof payload !== "object") return payload;
  const safe = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "human_only") continue;
    Object.defineProperty(safe, key, {
      value: publicPayload(value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return safe;
}

function canonicalMatch(left, right) {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
}

function safeReceiptValue(field, value, authorizedValue) {
  if (canonicalMatch(value, authorizedValue)) return true;
  if (!["word_count", "draft_version"].includes(field)) return false;
  return Number.isSafeInteger(value) && value >= 0;
}

function projectExecutionPayload(payload, authorizedPayload = payload) {
  if (!payload) return payload;
  const projected = {};
  for (const field of EXECUTION_PAYLOAD_FIELDS) {
    if (!Object.hasOwn(payload, field)) continue;
    if (!safeReceiptValue(field, payload[field], authorizedPayload?.[field])) continue;
    projected[field] = clone(payload[field]);
  }
  return projected;
}

function publicComparison(comparison, authorizedPayload) {
  if (!comparison) return comparison;
  const visibleDifferences = [];
  for (const difference of comparison.differences ?? []) {
    const exactField = String(difference.field ?? "");
    const path = exactField.split(".");
    if (path.includes("human_only")) continue;
    const candidatePresent = difference.candidate_present ?? true;
    const candidateIsSafe = candidatePresent && safeReceiptValue(exactField, difference.candidate, authorizedPayload?.[exactField]);
    if (EXECUTION_PAYLOAD_FIELD_SET.has(exactField) && candidateIsSafe) {
      visibleDifferences.push(publicPayload(difference));
      continue;
    }
    visibleDifferences.push({
      field: EXECUTION_PAYLOAD_FIELD_SET.has(exactField) ? difference.field : "[unexpected_field]",
      authorized_present: difference.authorized_present ?? true,
      candidate_present: difference.candidate_present ?? true,
      values_redacted: true,
    });
  }
  return { ...comparison, differences: visibleDifferences };
}

function publicReceipt(receipt) {
  if (!receipt) return null;
  const authorizedState = projectExecutionPayload(receipt.authorized_state);
  return redactReceipt({
    receipt_id: receipt.receipt_id,
    outcome: receipt.outcome,
    requested_intent: clone(receipt.requested_intent),
    prepared_state: projectExecutionPayload(receipt.prepared_state),
    authorized_state: authorizedState,
    executed_state: projectExecutionPayload(receipt.executed_state, authorizedState),
    attempted_state: projectExecutionPayload(receipt.attempted_state, authorizedState),
    comparison: publicComparison(receipt.comparison, authorizedState),
    authorization_digest: receipt.authorization.payload_digest,
    timestamps: clone(receipt.timestamps),
  });
}

function modificationList(prepared, draft) {
  return compareStates(prepared, draft).differences.map(({ field, authorized, candidate }) => ({ field, prepared: authorized, authorized: candidate }));
}

function makeInitialState({ origin, now, idFactory }) {
  const taskId = idFactory("task");
  const leaseId = idFactory("lease");
  return {
    version: 1,
    origin,
    task: {
      id: taskId,
      state: "preparing",
      step: "sources",
      intent: {
        summary: "Prepare and share a source-backed research brief on civic shade and heat resilience.",
        constraints: {
          required_source_ids: clone(RESEARCH_PACKET.required_source_ids),
          required_citation_style: RESEARCH_PACKET.required_citation_style,
        },
      },
      started_at: iso(now),
      completed_at: null,
      lease: {
        id: leaseId,
        status: "active",
        issued_at: iso(now),
        expires_at: iso(new Date(now.getTime() + THIRTY_MINUTES_MS)),
      },
    },
    authority: { state: "none", grant: null },
    research_packet: clone(RESEARCH_PACKET),
    brief_draft: null,
    prepared: null,
    human_draft: null,
    receipt: null,
    event_log: [{ at: iso(now), actor: "site", type: "task_started", detail: "Bounded research-brief task created" }],
  };
}

export class ResearchBriefEngine {
  #clock;
  #executor;
  #executionTimeoutMs;
  #idFactory;
  #listeners = new Set();
  #state;

  constructor({
    origin = "https://bounded-demo.local",
    clock = defaultClock,
    idFactory = defaultIdFactory,
    executor = defaultExecutor,
    executionTimeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS,
  } = {}) {
    assert(executor && typeof executor.preflight === "function" && typeof executor.commit === "function", "The site executor must provide preflight and commit functions.", "EXECUTOR_INVALID");
    assert(Number.isFinite(executionTimeoutMs) && executionTimeoutMs > 0, "The execution timeout must be a positive number.", "EXECUTION_TIMEOUT_INVALID");
    this.#clock = clock;
    this.#executor = executor;
    this.#executionTimeoutMs = executionTimeoutMs;
    this.#idFactory = idFactory;
    this.#state = makeInitialState({ origin, now: this.#now(), idFactory });
  }

  #now() {
    return new Date(this.#clock());
  }

  #emit() {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }

  #event(actor, type, detail) {
    this.#state.event_log.push({ at: iso(this.#now()), actor, type, detail });
  }

  #assertTaskState(...allowed) {
    assert(allowed.includes(this.#state.task.state), `Task state ${this.#state.task.state} does not allow this action.`, "TASK_STATE_INVALID");
  }

  #blockExpiredAuthorization(grant, now, { outcome = "blocked_expired", eventType = "authorization_expired", detail = "Execution blocked before consumption" } = {}) {
    this.#state.authority.state = "expired";
    this.#state.task.state = "blocked";
    this.#state.task.step = "expired";
    this.#state.task.completed_at = iso(now);
    this.#state.receipt = {
      receipt_id: this.#idFactory("receipt"),
      outcome,
      requested_intent: clone(this.#state.task.intent),
      prepared_state: clone(grant.prepared_payload),
      authorized_state: clone(grant.authorized_payload),
      attempted_state: null,
      executed_state: null,
      comparison: { status: "not_executed", matched: null, differences: [] },
      authorization: { grant_id: grant.grant_id, payload_digest: grant.payload_digest, authorized_at: grant.authorized_at, consumed_at: null },
      timestamps: { task_started_at: this.#state.task.started_at, authorized_at: grant.authorized_at, execution_finished_at: iso(now) },
    };
    this.#event("site", eventType, detail);
    this.#emit();
  }

  #recordExecutionFailure(grant, now) {
    this.#state.authority.state = "consumed";
    this.#state.task.state = "failed";
    this.#state.task.step = "failed";
    this.#state.task.completed_at = iso(now);
    this.#state.receipt = {
      receipt_id: this.#idFactory("receipt"),
      outcome: "execution_failed",
      requested_intent: clone(this.#state.task.intent),
      prepared_state: clone(grant.prepared_payload),
      authorized_state: clone(grant.authorized_payload),
      attempted_state: null,
      executed_state: null,
      comparison: { status: "not_verified", matched: null, differences: [] },
      authorization: { grant_id: grant.grant_id, payload_digest: grant.payload_digest, authorized_at: grant.authorized_at, consumed_at: grant.consumed_at },
      timestamps: { task_started_at: this.#state.task.started_at, authorized_at: grant.authorized_at, execution_finished_at: iso(now) },
    };
    this.#event("site", "execution_failed", "The local executor did not return a verifiable result");
    this.#emit();
  }

  #finalizeExecution(grant, { outcome, attemptedState, executedState, comparison, authorityState, taskState, step, eventType, detail }, now) {
    this.#state.receipt = {
      receipt_id: this.#idFactory("receipt"),
      outcome,
      requested_intent: clone(this.#state.task.intent),
      prepared_state: clone(grant.prepared_payload),
      authorized_state: clone(grant.authorized_payload),
      attempted_state: clone(attemptedState),
      executed_state: clone(executedState),
      comparison: clone(comparison),
      authorization: { grant_id: grant.grant_id, payload_digest: grant.payload_digest, authorized_at: grant.authorized_at, consumed_at: grant.consumed_at },
      timestamps: { task_started_at: this.#state.task.started_at, authorized_at: grant.authorized_at, execution_finished_at: iso(now) },
    };
    this.#state.authority.state = authorityState;
    this.#state.task.state = taskState;
    this.#state.task.step = step;
    this.#state.task.completed_at = iso(now);
    this.#event("site", eventType, detail);
    this.#emit();
    return publicReceipt(this.#state.receipt);
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  snapshot() {
    return clone(this.#state);
  }

  handles() {
    return { task_id: this.#state.task.id, lease_id: this.#state.task.lease.id };
  }

  reset() {
    this.#state = makeInitialState({ origin: this.#state.origin, now: this.#now(), idFactory: this.#idFactory });
    this.#emit();
    return this.snapshot();
  }

  readResearchSources({ task_id, lease_id }) {
    this.#assertTaskState("preparing");
    assert(this.#state.task.step === "sources", "Research sources have already been read.", "STEP_INVALID");
    activeLease(this.#state, task_id, lease_id, this.#now());
    this.#state.task.step = "draft";
    this.#event("agent", "sources_read", "Scoped research sources read");
    this.#emit();
    return {
      task_id,
      research_packet: {
        brief_id: this.#state.research_packet.brief_id,
        topic: this.#state.research_packet.topic,
        source_set: clone(this.#state.research_packet.source_set),
        required_source_ids: clone(this.#state.research_packet.required_source_ids),
        required_citation_style: this.#state.research_packet.required_citation_style,
        share_date: this.#state.research_packet.share_date,
      },
      next: "Compose a source-backed brief using the task's exact citation style.",
    };
  }

  composeResearchBrief({ task_id, lease_id, citation_style }) {
    this.#assertTaskState("preparing");
    assert(this.#state.task.step === "draft", "Research sources must be read before drafting.", "STEP_INVALID");
    activeLease(this.#state, task_id, lease_id, this.#now());
    assert(citation_style === this.#state.task.intent.constraints.required_citation_style, "The citation style must match the active task.", "CONSTRAINT_MISMATCH");
    this.#state.brief_draft = {
      draft_id: this.#idFactory("draft"),
      draft_version: 1,
      source_ids: clone(this.#state.research_packet.required_source_ids),
      source_count: this.#state.research_packet.required_source_ids.length,
      citation_style,
      word_count: BRIEF_LENGTH_OPTIONS.standard,
      valid_until: iso(new Date(this.#now().getTime() + THIRTY_MINUTES_MS)),
    };
    this.#state.task.step = "prepare";
    this.#event("agent", "brief_composed", "Source-backed brief draft composed within scope");
    this.#emit();
    return {
      task_id,
      brief_draft: clone(this.#state.brief_draft),
      source_scope_matched: true,
      next: "Prepare the research brief for human review.",
    };
  }

  prepareBriefShare({ task_id, lease_id, draft_id }) {
    this.#assertTaskState("preparing");
    assert(this.#state.task.step === "prepare", "A valid brief draft is required before preparation.", "STEP_INVALID");
    activeLease(this.#state, task_id, lease_id, this.#now());
    assert(draft_id === this.#state.brief_draft?.draft_id, "The draft handle does not match the active brief.", "DRAFT_MISMATCH");
    assert(this.#state.brief_draft.citation_style === this.#state.task.intent.constraints.required_citation_style, "The draft citation style is outside the task boundary.", "CONSTRAINT_EXCEEDED");
    this.#state.prepared = {
      operation: "share_research_brief",
      brief_id: this.#state.research_packet.brief_id,
      draft_id: this.#state.brief_draft.draft_id,
      draft_version: this.#state.brief_draft.draft_version,
      topic: this.#state.research_packet.topic,
      source_ids: clone(this.#state.brief_draft.source_ids),
      citation_style: this.#state.brief_draft.citation_style,
      word_count: this.#state.brief_draft.word_count,
      audience: "research_collaborators",
      share_date: this.#state.research_packet.share_date,
    };
    this.#state.human_draft = clone(this.#state.prepared);
    this.#state.task.state = "awaiting_human";
    this.#state.task.step = "handoff";
    this.#state.task.lease.status = "read_only";
    this.#state.authority.state = "proposed";
    this.#event("agent", "brief_prepared", "Brief preparation complete; agent capabilities revoked");
    this.#emit();
    return {
      task_id,
      status: "awaiting_human",
      prepared: publicPayload(this.#state.prepared),
      message: "Preparation is complete. A person must review and authorize the brief share in the site.",
    };
  }

  readTaskStatus({ task_id, lease_id }) {
    activeLease(this.#state, task_id, lease_id, this.#now());
    return {
      task_id,
      lease_id,
      task_state: this.#state.task.state,
      authority_state: this.#state.authority.state,
      step: this.#state.task.step,
      message: this.#state.task.state === "awaiting_human" ? "Waiting for focused human review. No agent action is available." : "Read the currently exposed tools for the next permitted action.",
    };
  }

  readReceipt({ task_id, lease_id }) {
    boundTaskLease(this.#state, task_id, lease_id);
    assert(this.#state.receipt, "No receipt exists for this task.", "RECEIPT_UNAVAILABLE");
    return publicReceipt(this.#state.receipt);
  }

  updateHumanDraft({ word_count, audience } = {}) {
    this.#assertTaskState("awaiting_human");
    assert(["proposed", "modified"].includes(this.#state.authority.state), "The proposal is not editable.", "AUTHORITY_STATE_INVALID");
    if (word_count !== undefined) {
      const wordCount = Number(word_count);
      assert(Object.values(BRIEF_LENGTH_OPTIONS).includes(wordCount), "That brief length is unavailable.", "VALUE_INVALID");
      this.#state.human_draft.word_count = wordCount;
    }
    if (audience !== undefined) {
      assert(["research_collaborators", "project_stewards"].includes(audience), "That sharing audience is unavailable.", "VALUE_INVALID");
      this.#state.human_draft.audience = audience;
    }
    const modifications = modificationList(this.#state.prepared, this.#state.human_draft);
    this.#state.authority.state = modifications.length ? "modified" : "proposed";
    this.#event("human", "proposal_reviewed", modifications.length ? `${modifications.length} value(s) modified` : "Prepared values restored");
    this.#emit();
    return this.snapshot();
  }

  async grantAuthorization({ sharing_confirmation, collaborator_note_id }) {
    this.#assertTaskState("awaiting_human");
    assert(["proposed", "modified"].includes(this.#state.authority.state), "The proposal cannot be granted.", "AUTHORITY_STATE_INVALID");
    assert(sharing_confirmation === true, "The sharing confirmation must be completed by a person.", "CONFIRMATION_REQUIRED");
    assert(collaborator_note_id === "note_fixture_3812", "Select the verified collaborator-note reference.", "NOTE_REFERENCE_REQUIRED");
    const now = this.#now();
    const { task_id: taskId, lease_id: leaseId } = this.handles();
    activeLease(this.#state, taskId, leaseId, now);
    assert(new Date(this.#state.brief_draft.valid_until) > now, "The prepared brief draft has expired.", "BRIEF_EXPIRED");
    const preparedPayload = clone(this.#state.prepared);
    const humanDraft = clone(this.#state.human_draft);
    const humanModifications = modificationList(preparedPayload, humanDraft);
    const authorizedPayload = {
      ...humanDraft,
      human_only: { sharing_confirmation: true, collaborator_note_ref: collaborator_note_id },
    };
    const payloadDigest = await sha256(authorizedPayload);
    this.#assertTaskState("awaiting_human");
    const finalizedAt = this.#now();
    activeLease(this.#state, taskId, leaseId, finalizedAt);
    assert(new Date(this.#state.brief_draft.valid_until) > finalizedAt, "The prepared brief draft has expired.", "BRIEF_EXPIRED");
    assert(["proposed", "modified"].includes(this.#state.authority.state), "The proposal cannot be granted.", "AUTHORITY_STATE_INVALID");
    assert(canonicalize(this.#state.human_draft) === canonicalize(humanDraft), "The reviewed proposal changed before authorization completed.", "AUTHORIZATION_STALE");
    const grant = {
      grant_id: this.#idFactory("grant"),
      task_id: taskId,
      lease_id: leaseId,
      site_origin: this.#state.origin,
      operation: "share_research_brief",
      prepared_payload: preparedPayload,
      human_modifications: humanModifications,
      authorized_payload: authorizedPayload,
      authorized_at: iso(finalizedAt),
      expires_at: iso(new Date(finalizedAt.getTime() + TEN_MINUTES_MS)),
      single_use: true,
      nonce: this.#idFactory("nonce"),
      payload_digest: payloadDigest,
      consumed_at: null,
    };
    this.#state.authority = { state: "granted", grant };
    this.#state.task.state = "authorized";
    this.#state.task.step = "authorized";
    this.#state.task.lease.status = "revoked";
    this.#event("human", "authorization_granted", "Exact, single-use authorization granted");
    this.#emit();
    return { grant_id: grant.grant_id, payload_digest: grant.payload_digest, expires_at: grant.expires_at };
  }

  denyAuthorization() {
    this.#assertTaskState("awaiting_human");
    const now = this.#now();
    this.#state.authority.state = "denied";
    this.#state.task.state = "cancelled";
    this.#state.task.step = "denied";
    this.#state.task.lease.status = "revoked";
    this.#state.task.completed_at = iso(now);
    this.#state.receipt = {
      receipt_id: this.#idFactory("decision"),
      outcome: "denied",
      requested_intent: clone(this.#state.task.intent),
      prepared_state: clone(this.#state.prepared),
      authorized_state: null,
      attempted_state: null,
      executed_state: null,
      comparison: { status: "not_executed", matched: null, differences: [] },
      authorization: { grant_id: null, payload_digest: null },
      timestamps: { task_started_at: this.#state.task.started_at, denied_at: iso(now) },
    };
    this.#event("human", "authorization_denied", "No execution attempted");
    this.#emit();
    return publicReceipt(this.#state.receipt);
  }

  async executeAuthorized({ simulate_divergence = false } = {}) {
    assert(!this.#state.authority.grant?.consumed_at, "The authorization has already been consumed.", "GRANT_CONSUMED");
    this.#assertTaskState("authorized");
    const grant = this.#state.authority.grant;
    const now = this.#now();
    assert(grant && this.#state.authority.state === "granted", "A granted authorization is required.", "GRANT_REQUIRED");
    assert(grant.site_origin === this.#state.origin, "The authorization origin does not match this site.", "ORIGIN_MISMATCH");
    assert(grant.task_id === this.#state.task.id, "The authorization task does not match.", "TASK_MISMATCH");
    assert(grant.lease_id === this.#state.task.lease.id, "The authorization lease does not match.", "LEASE_MISMATCH");
    assert(grant.operation === "share_research_brief", "The authorized operation does not match.", "OPERATION_MISMATCH");
    assert(grant.single_use && !grant.consumed_at, "The authorization has already been consumed.", "GRANT_CONSUMED");
    if (new Date(this.#state.brief_draft.valid_until) <= now) {
      this.#blockExpiredAuthorization(grant, now, { outcome: "blocked_brief_expired", eventType: "brief_expired", detail: "Execution blocked because the authorized brief draft expired" });
      const error = new Error("The authorized brief draft has expired.");
      error.code = "BRIEF_EXPIRED";
      throw error;
    }
    if (new Date(grant.expires_at) <= now) {
      this.#blockExpiredAuthorization(grant, now);
      const error = new Error("The authorization has expired.");
      error.code = "GRANT_EXPIRED";
      throw error;
    }
    const recalculatedDigest = await sha256(grant.authorized_payload);
    assert(!grant.consumed_at, "The authorization has already been consumed.", "GRANT_CONSUMED");
    this.#assertTaskState("authorized");
    assert(this.#state.authority.grant === grant, "The authorization is no longer current.", "GRANT_MISMATCH");
    assert(this.#state.authority.state === "granted", "A granted authorization is required.", "GRANT_REQUIRED");
    const consumeAt = this.#now();
    if (new Date(this.#state.brief_draft.valid_until) <= consumeAt) {
      this.#blockExpiredAuthorization(grant, consumeAt, { outcome: "blocked_brief_expired", eventType: "brief_expired", detail: "Execution blocked because the authorized brief draft expired" });
      const error = new Error("The authorized brief draft has expired.");
      error.code = "BRIEF_EXPIRED";
      throw error;
    }
    if (new Date(grant.expires_at) <= consumeAt) {
      this.#blockExpiredAuthorization(grant, consumeAt);
      const error = new Error("The authorization has expired.");
      error.code = "GRANT_EXPIRED";
      throw error;
    }
    assert(recalculatedDigest === grant.payload_digest, "The authorized payload digest does not match.", "DIGEST_MISMATCH");
    const authorizedExecutionPayload = projectExecutionPayload(grant.authorized_payload);
    this.#state.task.state = "executing";
    this.#state.task.step = "executing";
    this.#event("site", "authorization_consumed", "Single-use grant consumed for execution attempt");
    grant.consumed_at = iso(consumeAt);
    this.#emit();
    const controller = new AbortController();
    const deadline = new Date(consumeAt.getTime() + this.#executionTimeoutMs);
    let timeoutId;
    let timeoutError = null;
    const timeout = new Promise((resolve, reject) => {
      timeoutId = globalThis.setTimeout(() => {
        const error = new Error("The site executor exceeded its bounded deadline.");
        error.code = "EXECUTION_TIMEOUT";
        timeoutError = error;
        reject(error);
        controller.abort(error);
      }, this.#executionTimeoutMs);
    });
    const assertWithinDeadline = () => {
      if (timeoutError) throw timeoutError;
      if (controller.signal.aborted) {
        const error = new Error("The site executor was aborted.");
        error.code = "EXECUTION_ABORTED";
        throw error;
      }
    };
    const executionContext = {
      signal: controller.signal,
      deadline_at: iso(deadline),
      authorization: {
        grant_id: grant.grant_id,
        task_id: grant.task_id,
        lease_id: grant.lease_id,
        site_origin: grant.site_origin,
        operation: grant.operation,
        payload_digest: grant.payload_digest,
      },
    };
    try {
      const candidate = await Promise.race([
        this.#executor.preflight(clone(authorizedExecutionPayload), { ...executionContext, phase: "preflight", simulate_divergence }),
        timeout,
      ]);
      assertWithinDeadline();
      assert(candidate && typeof candidate === "object" && !Array.isArray(candidate), "The site executor returned an invalid preflight result.", "EXECUTION_RESULT_INVALID");
      assert(this.#state.authority.grant === grant, "The authorization is no longer current.", "GRANT_MISMATCH");
      this.#assertTaskState("executing");
      this.#state.task.state = "verifying";
      this.#state.task.step = "verifying";
      this.#emit();
      const preflightComparison = compareStates(authorizedExecutionPayload, candidate);
      if (!preflightComparison.matched) {
        return this.#finalizeExecution(grant, {
          outcome: "blocked_divergent",
          attemptedState: candidate,
          executedState: null,
          comparison: preflightComparison,
          authorityState: "divergent",
          taskState: "blocked",
          step: "divergent",
          eventType: "execution_blocked",
          detail: `${preflightComparison.differences.length} divergent field(s) detected before commit`,
        }, this.#now());
      }
      assertWithinDeadline();
      const executedState = await Promise.race([
        this.#executor.commit(clone(candidate), { ...executionContext, phase: "commit" }),
        timeout,
      ]);
      assertWithinDeadline();
      assert(executedState && typeof executedState === "object" && !Array.isArray(executedState), "The site executor returned an invalid commit result.", "EXECUTION_RESULT_INVALID");
      assert(this.#state.authority.grant === grant, "The authorization is no longer current.", "GRANT_MISMATCH");
      this.#assertTaskState("verifying");
      const comparison = compareStates(authorizedExecutionPayload, executedState);
      const finishedAt = this.#now();
      if (comparison.matched) {
        return this.#finalizeExecution(grant, {
          outcome: "executed",
          attemptedState: null,
          executedState,
          comparison,
          authorityState: "consumed",
          taskState: "completed",
          step: "receipt",
          eventType: "execution_verified",
          detail: "Committed state exactly matched authorization",
        }, finishedAt);
      }
      return this.#finalizeExecution(grant, {
        outcome: "executed_divergent",
        attemptedState: candidate,
        executedState,
        comparison,
        authorityState: "divergent",
        taskState: "failed",
        step: "divergent",
        eventType: "execution_divergent",
        detail: `${comparison.differences.length} divergent field(s) detected in commit readback`,
      }, finishedAt);
    } catch (error) {
      if (this.#state.authority.grant === grant && ["executing", "verifying"].includes(this.#state.task.state)) {
        this.#recordExecutionFailure(grant, this.#now());
      }
      if (!error.code) error.code = "EXECUTION_FAILED";
      throw error;
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }

  internalReceipt() {
    return clone(this.#state.receipt);
  }
}

export function createAgentToolDefinitions(engine) {
  const state = engine.snapshot();
  const statusSchema = { type: "object", properties: {}, additionalProperties: false };
  const commonSchema = {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Active task handle shown by the site." },
      lease_id: { type: "string", description: "Scoped execution lease for the active task." },
    },
    required: ["task_id", "lease_id"],
    additionalProperties: false,
  };
  const statusTool = {
    name: "read_task_status",
    title: "Read task status",
    description: "Read the state of the active bounded research-brief task and learn whether action is available.",
    inputSchema: statusSchema,
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute: async () => JSON.stringify(engine.readTaskStatus(engine.handles())),
  };
  if (state.task.state === "preparing" && state.task.step === "sources") {
    return [{
      name: "read_research_sources",
      title: "Read scoped research sources",
      description: "Read only the sources and citation requirement needed for the active research brief.",
      inputSchema: commonSchema,
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async (input) => JSON.stringify(engine.readResearchSources(input)),
    }, statusTool];
  }
  if (state.task.state === "preparing" && state.task.step === "draft") {
    return [{
      name: "compose_research_brief",
      title: "Compose research brief",
      description: "Compose the brief using the active task's exact citation style and scoped sources.",
      inputSchema: {
        ...commonSchema,
        properties: {
          ...commonSchema.properties,
          citation_style: { type: "string", enum: [RESEARCH_PACKET.required_citation_style], description: "Citation style required by the active task." },
        },
        required: [...commonSchema.required, "citation_style"],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async (input) => JSON.stringify(engine.composeResearchBrief(input)),
    }, statusTool];
  }
  if (state.task.state === "preparing" && state.task.step === "prepare") {
    return [{
      name: "prepare_brief_share",
      title: "Prepare brief share",
      description: "Prepare the source-backed brief for human review. This cannot authorize or execute it.",
      inputSchema: {
        ...commonSchema,
        properties: {
          ...commonSchema.properties,
          draft_id: { type: "string", description: "Draft handle returned by compose_research_brief." },
        },
        required: [...commonSchema.required, "draft_id"],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async (input) => JSON.stringify(engine.prepareBriefShare(input)),
    }, statusTool];
  }
  if (["completed", "blocked", "cancelled", "failed"].includes(state.task.state) && state.receipt) {
    return [{
      name: "read_receipt",
      title: "Read execution receipt",
      description: "Read the redacted terminal outcome and exact-state comparison for this task.",
      inputSchema: commonSchema,
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: async (input) => JSON.stringify(engine.readReceipt(input)),
    }];
  }
  if (state.task.state === "awaiting_human") return [statusTool];
  return [];
}

export const format = Object.freeze({
  words(value) {
    return `${new Intl.NumberFormat("en-CA").format(value)} words`;
  },
  audience(value) {
    return { research_collaborators: "Research collaborators", project_stewards: "Project stewards" }[value] ?? String(value ?? "Unavailable");
  },
  date(value) {
    return new Intl.DateTimeFormat("en-CA", { month: "long", day: "numeric", year: "numeric" }).format(new Date(`${value}T12:00:00`));
  },
});
