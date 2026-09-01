import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { T1_REQUEST_MANIFEST } from "../runtime/t1/request-manifest.js";
import { createT1OfflineRuntime, T1SessionError } from "../runtime/t1/session.js";
import { createT1SyntheticFixture } from "../runtime/t1/synthetic-target.js";

const NOW = "2026-08-29T17:00:00.000Z";
const NOW_MS = Date.parse(NOW);
let planSequence = 0;

function isoOffset(milliseconds) {
  return new Date(NOW_MS + milliseconds).toISOString();
}

function makeTimeline(overrides = {}) {
  return {
    opened_at: NOW,
    prepare_started_at: NOW,
    prepared_at: NOW,
    authority_recorded_at: NOW,
    dispatch_at: NOW,
    commit_response_at: NOW,
    verification_response_at: NOW,
    ...overrides,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function makePlan({ suffix, deadline = isoOffset(30 * 60 * 1000) } = {}) {
  const resolvedSuffix = suffix ?? `auto-${++planSequence}`;
  const executionId = `synthetic-execution-${resolvedSuffix}`;
  return {
    contract_revision: "t1-offline-0.1",
    run_mode: "synthetic_offline",
    execution_id: executionId,
    owner_direction_ref: "synthetic-owner-direction-PD-DIR-20260829-01",
    authority_mode: "transaction_authorized",
    target_context: {
      provider: "synthetic-shopify-like-fixture",
      api_version: "2026-07",
      store_ref: `synthetic-store-${resolvedSuffix}`,
      inventory_level_id: `synthetic-inventory-level-${resolvedSuffix}`,
      inventory_item_id: `synthetic-inventory-item-${resolvedSuffix}`,
      location_id: `synthetic-location-${resolvedSuffix}`,
    },
    audience: {
      issuer_ref: `synthetic-issuer-${resolvedSuffix}`,
      adapter_ref: `synthetic-adapter-${resolvedSuffix}`,
      verifier_ref: `synthetic-verifier-${resolvedSuffix}`,
    },
    action: {
      operation: "inventoryAdjustQuantities",
      quantity_name: "available",
      delta: 3,
      change_from_quantity: 10,
      reason: "correction",
      reference_document_uri: `urn:synthetic-t1:execution:${executionId}`,
      ledger_document_uri: null,
      expected_effect: {
        available_before: 10,
        available_after: 13,
        on_hand_before: 20,
        on_hand_after: 23,
      },
    },
    deadline,
  };
}

function makeBudget() {
  return {
    status: "synthetic_fixture_only",
    decision_ref: "synthetic-cost-fixture-001",
    documents: {
      before_read: { static_requested_cost: 5, max_requested_cost: 10 },
      commit: { static_requested_cost: 15, max_requested_cost: 20 },
      verification_read: { static_requested_cost: 5, max_requested_cost: 10 },
    },
    max_total_requested_cost: 40,
  };
}

function makeFixture({
  requestedCosts = { before_read: 5, commit: 15, verification_read: 5 },
  evidenceProfile = "consistent",
  initialInventory = { available: 10, on_hand: 20 },
} = {}) {
  return createT1SyntheticFixture({ initialInventory, requestedCosts, evidenceProfile });
}

function makeRuntime({
  plan = makePlan(),
  budget = makeBudget(),
  targetFixture = makeFixture(),
  syntheticNow = NOW,
} = {}) {
  const runtime = createT1OfflineRuntime({
    plan,
    costBudget: budget,
    targetFixture,
    syntheticNow,
  });
  return { runtime, session: runtime.session, operator: runtime.operator, plan, targetFixture };
}

function recordAuthority(operator, review, {
  authorityRef = "synthetic-authority-001",
  authorizedAt = NOW,
  expiresAt = isoOffset(10 * 60 * 1000),
} = {}) {
  return operator.recordTransactionAuthority({
    authority_ref: authorityRef,
    execution_id: review.execution_id,
    binding_digest: review.binding_digest,
    operator_mode: "human_foreground_declared",
    authorized_at: authorizedAt,
    expires_at: expiresAt,
  });
}

function hasCode(code) {
  return (error) => error instanceof T1SessionError && error.code === code;
}

function containsFunction(value) {
  if (typeof value === "function") return true;
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(containsFunction);
}

test("T1-01 request manifest is exactly three closed deeply immutable documents", () => {
  assert.equal(T1_REQUEST_MANIFEST.manifest_revision, "t1-p1-request-manifest-0.1");
  assert.equal(T1_REQUEST_MANIFEST.api_version, "2026-07");
  assert.equal(T1_REQUEST_MANIFEST.query_cost_status, "hold_pending_owner_selected_exact_budget");
  assert.deepEqual(T1_REQUEST_MANIFEST.documents.map((entry) => entry.id), [
    "before_read",
    "commit",
    "verification_read",
  ]);
  assert.deepEqual(T1_REQUEST_MANIFEST.documents.map((entry) => entry.commit_capable), [false, true, false]);
  assert.match(T1_REQUEST_MANIFEST.manifest_digest, /^[a-f0-9]{64}$/);
  for (const entry of T1_REQUEST_MANIFEST.documents) {
    assert.ok(Object.isFrozen(entry));
    assert.match(entry.document_digest, /^[a-f0-9]{64}$/);
  }
  assert.throws(() => {
    T1_REQUEST_MANIFEST.documents.push({ id: "fourth" });
  }, TypeError);
  assert.throws(() => {
    T1_REQUEST_MANIFEST.documents[1].document = "mutation Other { other }";
  }, TypeError);
});

test("T1-02 query-cost HOLD and budget mismatches fail before commit capability", async (t) => {
  await t.test("missing exact budget", () => {
    const plan = makePlan({ suffix: "budget-missing" });
    assert.throws(() => makeRuntime({ plan, budget: null }), hasCode("QUERY_COST_BUDGET_HOLD"));
  });

  await t.test("static calculation exceeds its ceiling", () => {
    const plan = makePlan({ suffix: "budget-static" });
    const budget = makeBudget();
    budget.documents.commit.static_requested_cost = 21;
    assert.throws(() => makeRuntime({ plan, budget }), hasCode("QUERY_COST_BUDGET_HOLD"));
  });

  await t.test("first read reports cost over its selected bound", async () => {
    const plan = makePlan({ suffix: "budget-reported" });
    const targetFixture = makeFixture({
      requestedCosts: { before_read: 11, commit: 15, verification_read: 5 },
    });
    const { session } = makeRuntime({ plan, targetFixture });
    await assert.rejects(session.prepare(), hasCode("QUERY_COST_CEILING_EXCEEDED"));
    const receipt = session.exportReceipt();
    assert.equal(receipt.outcome, "not_attempted");
    assert.deepEqual(receipt.request_counts, { total: 1, reads: 1, commit_capable: 0 });
    assert.equal(receipt.effecting_lineages, 0);
    assert.deepEqual(receipt.query_cost.requested_by_document, { before_read: 11 });
  });
});

test("T1-03 one foreground session is single-flight and strictly sequential", async () => {
  const { session } = makeRuntime({ plan: makePlan({ suffix: "single-flight" }) });
  const first = session.prepare();
  await assert.rejects(session.prepare(), hasCode("RUN_IN_PROGRESS"));
  await first;
});

test("T1-04 one completed run has one effecting lineage and cannot rerun", async () => {
  const { session, operator } = makeRuntime();
  const review = await session.prepare();
  const authority = recordAuthority(operator, review);
  const receipt = await session.runAuthorized();

  assert.equal(receipt.outcome, "committed_exact");
  assert.equal(receipt.effecting_lineages, 1);
  assert.deepEqual(receipt.request_counts, { total: 3, reads: 2, commit_capable: 1 });
  assert.equal(receipt.authority.lifecycle_state, "consumed");
  assert.equal(receipt.authority.validity, "valid_at_dispatch");
  assert.equal(receipt.authority.record_digest, authority.authority_digest);
  assert.equal(receipt.authority.reservation_count, 1);
  assert.equal(receipt.authority.consumption_count, 1);
  assert.equal(receipt.synthetic_fixture.fixture_digest, review.synthetic_fixture.fixture_digest);
  assert.equal(receipt.synthetic_fixture.evidence_profile, "consistent");
  assert.deepEqual(session.exportReceipt(), receipt);

  await assert.rejects(session.runAuthorized(), hasCode("RETRY_FORBIDDEN"));
  assert.deepEqual(session.exportReceipt(), receipt);
});

test("T1-05 target mutation is factory-private and no alternate executable surface is accepted", () => {
  const fixture = makeFixture();
  assert.deepEqual(Object.keys(fixture).sort(), [
    "evidence_profile",
    "initial_inventory",
    "kind",
    "requested_costs",
  ]);
  assert.equal(containsFunction(fixture), false);
  assert.ok(Object.isFrozen(fixture));
  assert.ok(Object.isFrozen(fixture.initial_inventory));

  const { runtime, session, operator } = makeRuntime({ targetFixture: fixture });
  assert.deepEqual(Object.keys(runtime).sort(), ["operator", "session"]);
  assert.deepEqual(Object.keys(session).sort(), ["exportReceipt", "prepare", "runAuthorized"]);
  assert.deepEqual(Object.keys(operator), ["recordTransactionAuthority"]);
  for (const forbidden of ["retry", "webhook", "fault", "query", "commit", "reconcile", "teardown", "sendFixedRequest"]) {
    assert.equal(Object.hasOwn(session, forbidden), false);
    assert.equal(Object.hasOwn(operator, forbidden), false);
    assert.equal(Object.hasOwn(fixture, forbidden), false);
  }

  let injectedCalls = 0;
  assert.throws(() => createT1OfflineRuntime({
    plan: makePlan({ suffix: "injected" }),
    costBudget: makeBudget(),
    targetFixture: makeFixture(),
    syntheticNow: NOW,
    transport: {
      kind: "synthetic_t1_transport",
      sendFixedRequest() {
        injectedCalls += 1;
      },
    },
  }), hasCode("UNKNOWN_FIELD"));
  assert.equal(injectedCalls, 0);

  const runtimeSources = [
    "runtime/t1/request-manifest.js",
    "runtime/t1/session.js",
    "runtime/t1/synthetic-target.js",
  ].map((path) => readFileSync(path, "utf8")).join("\n");
  assert.doesNotMatch(runtimeSources, /\bfetch\s*\(/);
  assert.doesNotMatch(runtimeSources, /node:https|node:http|process\.env|X-Shopify-Access-Token/);

  const browserSources = ["app/app.js", "app/domain.js", "app/webmcp.js", "app/delegated-authority.js"]
    .map((path) => readFileSync(path, "utf8"));
  for (const source of browserSources) assert.doesNotMatch(source, /runtime[\\/]t1|createT1OfflineRuntime/);
});

test("T1-06 operator authority is a separate unverified facet and never becomes identity or Gate 9 proof", async () => {
  const { session, operator } = makeRuntime({ plan: makePlan({ suffix: "claims" }) });
  assert.equal(Object.hasOwn(session, "recordTransactionAuthority"), false);
  const review = await session.prepare();
  assert.equal(review.operator_provenance, "not_verified");
  assert.equal(review.evidence_scope, "synthetic_offline_only");
  await assert.rejects(session.runAuthorized(), hasCode("TRANSACTION_AUTHORITY_REQUIRED"));
  const authority = recordAuthority(operator, review);
  assert.equal(authority.operator_provenance, "not_verified");
  const receipt = await session.runAuthorized();
  assert.deepEqual(receipt.trust, {
    human_operation: "not_verified",
    agent_mediation: "not_tested",
    provider_conformance: "unknown",
    windows_acl: "not_proven",
    credential_custody: "not_implemented",
    protected_ledger: "not_implemented",
    replay_exclusion: "unprotected_process_realm_only",
    receipt_authenticity: "unsigned",
    gate_9: "not_proven",
  });
  assert.equal(Object.hasOwn(receipt, "pass"), false);
});

test("T1-07 allowlist projections omit sentinels and isolation claims stay truthful", async () => {
  const sentinel = "synthetic-secret-sentinel-do-not-export";
  const plan = makePlan({ suffix: "sentinel" });
  plan.target_context.store_ref = sentinel;
  plan.target_context.inventory_level_id = `${sentinel}-level`;
  plan.target_context.inventory_item_id = `${sentinel}-item`;
  plan.target_context.location_id = `${sentinel}-location`;
  plan.audience.issuer_ref = `${sentinel}-issuer`;
  plan.audience.adapter_ref = `${sentinel}-adapter`;
  plan.audience.verifier_ref = `${sentinel}-verifier`;
  const { session, operator } = makeRuntime({ plan });
  const review = await session.prepare();
  const authority = recordAuthority(operator, review, { authorityRef: `synthetic-authority-${sentinel}` });
  const receipt = await session.runAuthorized();

  assert.doesNotMatch(JSON.stringify(authority), new RegExp(sentinel));
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(sentinel));
  assert.doesNotMatch(JSON.stringify(session.exportReceipt()), new RegExp(sentinel));
  assert.deepEqual(receipt.isolation, {
    scope: "same_process_synthetic_interface_only",
    secret_store: "not_implemented",
    protected_ledger: "not_implemented",
    alternate_commit_interface: "absent",
    windows_acl: "not_proven",
  });

  let falseProbeCalls = 0;
  assert.throws(() => createT1OfflineRuntime({
    plan: makePlan({ suffix: "false-probe" }),
    costBudget: makeBudget(),
    targetFixture: makeFixture(),
    syntheticNow: NOW,
    isolationProbe() {
      falseProbeCalls += 1;
      return { secret_read: "denied" };
    },
  }), hasCode("UNKNOWN_FIELD"));
  assert.equal(falseProbeCalls, 0);
});

test("T1-08 divergent, missing-response, and malformed-response paths stay truthful and terminal", async (t) => {
  await t.test("verification divergence", async () => {
    const { session, operator } = makeRuntime({
      plan: makePlan({ suffix: "divergent" }),
      targetFixture: makeFixture({ evidenceProfile: "verification_conflict" }),
    });
    const review = await session.prepare();
    recordAuthority(operator, review);
    const receipt = await session.runAuthorized();
    assert.equal(receipt.outcome, "committed_divergent");
    assert.equal(receipt.evidence.commit_response_received, true);
    assert.equal(receipt.evidence.commit_response_validated, true);
  });

  await t.test("response unavailable after synthetic effect", async () => {
    const { session, operator } = makeRuntime({
      plan: makePlan({ suffix: "unknown" }),
      targetFixture: makeFixture({ evidenceProfile: "commit_response_missing_after_effect" }),
    });
    const review = await session.prepare();
    recordAuthority(operator, review);
    const receipt = await session.runAuthorized();
    assert.equal(receipt.outcome, "unknown");
    assert.equal(receipt.reason_code, "COMMIT_DISPATCH_OR_EVIDENCE_UNKNOWN");
    assert.equal(receipt.evidence.commit_response_received, false);
    assert.equal(receipt.evidence.commit_response_validated, false);
    assert.deepEqual(receipt.request_counts, { total: 2, reads: 1, commit_capable: 1 });
    await assert.rejects(session.runAuthorized(), hasCode("RETRY_FORBIDDEN"));
  });

  await t.test("returned malformed commit evidence is recorded as received but not validated", async () => {
    const { session, operator } = makeRuntime({
      plan: makePlan({ suffix: "malformed" }),
      targetFixture: makeFixture({ evidenceProfile: "commit_response_malformed_after_effect" }),
    });
    const review = await session.prepare();
    recordAuthority(operator, review);
    const receipt = await session.runAuthorized();
    assert.equal(receipt.outcome, "unknown");
    assert.equal(receipt.evidence.commit_response_received, true);
    assert.equal(receipt.evidence.commit_response_validated, false);
  });
});

test("T1-09 closed plan and operator-authority schemas reject extra executable semantics", async () => {
  const plan = makePlan({ suffix: "closed" });
  plan.alternate_endpoint = "synthetic-forbidden";
  assert.throws(() => makeRuntime({ plan }), hasCode("UNKNOWN_FIELD"));

  const { session, operator } = makeRuntime({ plan: makePlan({ suffix: "closed-authority" }) });
  const review = await session.prepare();
  assert.throws(() => operator.recordTransactionAuthority({
    authority_ref: "synthetic-authority-closed",
    execution_id: review.execution_id,
    binding_digest: review.binding_digest,
    operator_mode: "human_foreground_declared",
    authorized_at: NOW,
    expires_at: isoOffset(10 * 60 * 1000),
    alternate_commit: true,
  }), hasCode("UNKNOWN_FIELD"));
  await assert.rejects(session.runAuthorized(), hasCode("TRANSACTION_AUTHORITY_REQUIRED"));
});

test("T1-10 every reference-bearing input is closed to a synthetic form", async (t) => {
  const invalidPlans = [
    ["owner direction", (plan) => { plan.owner_direction_ref = "PD-DIR-20260829-01"; }, "LIVE_REFERENCE_FORBIDDEN"],
    ["execution identifier", (plan) => { plan.execution_id = "synthetic-execution-https://store.example"; }, "LIVE_EXECUTION_ID_FORBIDDEN"],
    ["store reference", (plan) => { plan.target_context.store_ref = "https://store.example"; }, "LIVE_REFERENCE_FORBIDDEN"],
    ["audience reference", (plan) => { plan.audience.adapter_ref = "real-adapter"; }, "LIVE_REFERENCE_FORBIDDEN"],
    ["action reference URI", (plan) => { plan.action.reference_document_uri = `https://example.test/${plan.execution_id}`; }, "UNBOUND_REFERENCE"],
  ];
  for (const [name, mutate, code] of invalidPlans) {
    await t.test(name, () => {
      const plan = makePlan({ suffix: `invalid-${name.replaceAll(" ", "-")}` });
      mutate(plan);
      assert.throws(() => makeRuntime({ plan }), hasCode(code));
    });
  }

  await t.test("budget decision reference", () => {
    const budget = makeBudget();
    budget.decision_ref = "owner-budget-record";
    assert.throws(() => makeRuntime({ budget }), hasCode("LIVE_REFERENCE_FORBIDDEN"));
  });

  await t.test("authority reference", async () => {
    const { session, operator } = makeRuntime({ plan: makePlan({ suffix: "invalid-authority" }) });
    const review = await session.prepare();
    assert.throws(() => recordAuthority(operator, review, { authorityRef: "https://authority.example" }),
      hasCode("LIVE_REFERENCE_FORBIDDEN"));
  });
});

test("T1-11 the 30-minute plan and authority windows fail closed at their boundaries", async (t) => {
  await t.test("expired plan stops before a request", async () => {
    const { session } = makeRuntime({
      plan: makePlan({ suffix: "expired", deadline: isoOffset(-1) }),
    });
    await assert.rejects(session.prepare(), hasCode("TRIAL_WINDOW_INVALID"));
    assert.deepEqual(session.exportReceipt().request_counts, { total: 0, reads: 0, commit_capable: 0 });
  });

  await t.test("plan one millisecond over the maximum stops before a request", async () => {
    const { session } = makeRuntime({
      plan: makePlan({ suffix: "too-long", deadline: isoOffset(30 * 60 * 1000 + 1) }),
    });
    await assert.rejects(session.prepare(), hasCode("TRIAL_WINDOW_INVALID"));
    assert.equal(session.exportReceipt().request_counts.total, 0);
  });

  await t.test("an exact 30-minute plan is accepted", async () => {
    const { session } = makeRuntime({ plan: makePlan({ suffix: "exact-window" }) });
    const review = await session.prepare();
    assert.equal(review.deadline, isoOffset(30 * 60 * 1000));
  });

  await t.test("authority interval one millisecond over the maximum is rejected", async () => {
    const { session, operator } = makeRuntime({ plan: makePlan({ suffix: "authority-window" }) });
    const review = await session.prepare();
    assert.throws(() => recordAuthority(operator, review, {
      authorizedAt: NOW,
      expiresAt: isoOffset(30 * 60 * 1000 + 1),
    }), hasCode("AUTHORITY_EXPIRED"));
    await assert.rejects(session.runAuthorized(), hasCode("TRANSACTION_AUTHORITY_REQUIRED"));
  });

  await t.test("authority one millisecond before preparation is rejected", async () => {
    const { session, operator } = makeRuntime({ plan: makePlan({ suffix: "authority-before-review" }) });
    const review = await session.prepare();
    assert.throws(() => recordAuthority(operator, review, {
      authorizedAt: isoOffset(-1),
    }), hasCode("AUTHORITY_PREDATES_PREPARATION"));
  });

  await t.test("authority exactly at preparation is accepted", async () => {
    const { session, operator } = makeRuntime({ plan: makePlan({ suffix: "authority-equal-review" }) });
    const review = await session.prepare();
    const authority = recordAuthority(operator, review, { authorizedAt: review.prepared_at });
    assert.equal(authority.recorded, true);
  });

  await t.test("authority after preparation is accepted", async () => {
    const afterReview = isoOffset(1);
    const { session, operator } = makeRuntime({
      plan: makePlan({ suffix: "authority-after-review" }),
      syntheticNow: makeTimeline({
        authority_recorded_at: afterReview,
        dispatch_at: afterReview,
        commit_response_at: afterReview,
        verification_response_at: afterReview,
      }),
    });
    const review = await session.prepare();
    const authority = recordAuthority(operator, review, { authorizedAt: afterReview });
    assert.equal(authority.recorded, true);
  });

  await t.test("expiry before dispatch is explicit and sends no commit request", async () => {
    const dispatchAt = isoOffset(6 * 60 * 1000);
    const { session, operator } = makeRuntime({
      plan: makePlan({ suffix: "expired-before-dispatch" }),
      syntheticNow: makeTimeline({
        dispatch_at: dispatchAt,
        commit_response_at: dispatchAt,
        verification_response_at: dispatchAt,
      }),
    });
    const review = await session.prepare();
    recordAuthority(operator, review, { expiresAt: isoOffset(5 * 60 * 1000) });
    const receipt = await session.runAuthorized();
    assert.equal(receipt.outcome, "not_attempted");
    assert.equal(receipt.reason_code, "AUTHORITY_EXPIRED");
    assert.equal(receipt.authority.lifecycle_state, "available");
    assert.equal(receipt.authority.validity, "expired_before_dispatch");
    assert.equal(receipt.request_counts.commit_capable, 0);
    assert.equal(receipt.authority.reservation_count, 0);
    assert.equal(receipt.authority.consumption_count, 0);
  });

  await t.test("a commit response after the active window is quarantined without verification", async () => {
    const afterExpiry = isoOffset(6 * 60 * 1000);
    const { session, operator } = makeRuntime({
      plan: makePlan({ suffix: "crossed-after-commit" }),
      syntheticNow: makeTimeline({
        commit_response_at: afterExpiry,
        verification_response_at: afterExpiry,
      }),
    });
    const review = await session.prepare();
    recordAuthority(operator, review, { expiresAt: isoOffset(5 * 60 * 1000) });
    const receipt = await session.runAuthorized();
    assert.equal(receipt.outcome, "unknown");
    assert.equal(receipt.reason_code, "ACTIVE_WINDOW_CROSSED_AFTER_COMMIT");
    assert.deepEqual(receipt.request_counts, { total: 2, reads: 1, commit_capable: 1 });
    assert.equal(receipt.authority.lifecycle_state, "consumed");
    assert.equal(receipt.authority.validity, "valid_at_dispatch");
  });
});

test("T1-12 the terminal receipt binds the exact authority record without exporting its raw reference", async () => {
  const plan = makePlan({ suffix: "authority-digest" });
  const runtime = makeRuntime({ plan });
  const review = await runtime.session.prepare();
  const authority = recordAuthority(runtime.operator, review, { authorityRef: "synthetic-authority-a" });
  const receipt = await runtime.session.runAuthorized();

  assert.match(authority.authority_digest, /^[a-f0-9]{64}$/);
  assert.equal(receipt.authority.record_digest, authority.authority_digest);
  assert.equal(receipt.authority.authorized_at, NOW);
  assert.equal(receipt.authority.expires_at, isoOffset(10 * 60 * 1000));
  assert.equal(JSON.stringify(receipt).includes("synthetic-authority-a"), false);
  assert.match(receipt.receipt_digest, /^[a-f0-9]{64}$/);
});

test("T1-13 one execution identifier can be claimed only once across module instances in the current realm", async () => {
  const plan = makePlan({ suffix: "duplicate-runtime" });
  makeRuntime({ plan });
  assert.throws(() => makeRuntime({ plan: structuredClone(plan) }), hasCode("DUPLICATE_EXECUTION_ID"));

  const alternateModule = await import("../runtime/t1/session.js?t1-process-registry-probe");
  assert.throws(() => alternateModule.createT1OfflineRuntime({
    plan: structuredClone(plan),
    costBudget: makeBudget(),
    targetFixture: makeFixture(),
    syntheticNow: NOW,
  }), (error) => error?.code === "DUPLICATE_EXECUTION_ID");
});

test("T1-14 the synthetic fixture, evidence profile, and time mode are bound into review and receipt provenance", async () => {
  const plan = makePlan({ suffix: "fixture-binding" });
  const budget = makeBudget();
  const targetFixture = makeFixture({ evidenceProfile: "commit_response_malformed_after_effect" });
  const ordinaryFixture = makeFixture();
  const { session, operator } = makeRuntime({ plan, budget, targetFixture });
  const review = await session.prepare();
  const timeFixture = {
    mode: "closed_synthetic_timeline",
    timeline: Object.fromEntries(Object.entries(makeTimeline()).map(([phase, instant]) => [phase, Date.parse(instant)])),
  };
  const fixtureDigest = digest({ target_fixture: targetFixture, time_fixture: timeFixture });
  const expectedBindingDigest = digest({
    plan,
    manifest_digest: T1_REQUEST_MANIFEST.manifest_digest,
    budget_digest: digest(budget),
    fixture_digest: fixtureDigest,
  });

  assert.notEqual(fixtureDigest, digest({ target_fixture: ordinaryFixture, time_fixture: timeFixture }));
  assert.deepEqual(review.synthetic_fixture, {
    fixture_digest: fixtureDigest,
    evidence_profile: "commit_response_malformed_after_effect",
    time_mode: "closed_synthetic_timeline",
    time_fixture: {
      mode: "closed_synthetic_timeline",
      timeline: makeTimeline(),
    },
  });
  assert.equal(review.binding_digest, expectedBindingDigest);
  recordAuthority(operator, review);
  const receipt = await session.runAuthorized();
  assert.equal(receipt.binding_digest, expectedBindingDigest);
  assert.deepEqual(receipt.synthetic_fixture, {
    fixture_digest: fixtureDigest,
    evidence_profile: "commit_response_malformed_after_effect",
    time_mode: "closed_synthetic_timeline",
  });
  assert.equal(receipt.outcome, "unknown");
});
