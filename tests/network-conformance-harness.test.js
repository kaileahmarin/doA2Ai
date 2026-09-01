import assert from "node:assert/strict";
import test from "node:test";

import {
  bindExecutionEnvelope,
  createNetworkConformanceHarness,
} from "./support/network-conformance-harness.js";

const START_TIME = "2026-08-28T16:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;

function makeEnvelope() {
  return {
    contract_revision: "0.1",
    execution_id: "execution_fixture_001",
    authority_mode: "transaction_authorized",
    claim_ref: "claim_fixture_001",
    claim_binding: {
      action_binding: "fixture-action:inventory-correction-001",
      target_binding: "fixture-target:inventory-level-001",
      audience: "fixture-adapter:inventory-adjust",
      validity: {
        not_before: "2026-08-28T15:00:00.000Z",
        expires_at: "2026-08-31T16:00:00.000Z",
      },
    },
    target_context: {
      trial_provider: "synthetic-shopify-like-fixture",
      development_store: "fixture-store-001",
      api_version: "2026-07-proposed-fixture",
      inventory_level: "fixture-inventory-level-001",
      inventory_item: "fixture-inventory-item-001",
      location: "fixture-location-001",
    },
    audience: {
      protected_adapter: "fixture-adapter:inventory-adjust",
      operation: "inventoryAdjustQuantities",
      issuer: "fixture-authority-layer",
      tenant: "fixture-tenant-001",
      account: "fixture-account-001",
    },
    action: {
      operation: "inventoryAdjustQuantities",
      quantity_name: "available",
      changes: [{
        inventory_item: "fixture-inventory-item-001",
        location: "fixture-location-001",
        delta: 3,
        change_from_quantity: 10,
      }],
      reason: "correction",
      reference_document_uri: "fixture://execution/execution_fixture_001",
      ledger_document_uri: null,
      expected_effect: {
        available_before: 10,
        available_after: 13,
        on_hand_before: 20,
        on_hand_after: 23,
      },
    },
    deadline: "2026-08-29T16:00:00.000Z",
  };
}

function changed(mutator) {
  const envelope = makeEnvelope();
  mutator(envelope);
  return envelope;
}

async function makeFixture({
  envelope = makeEnvelope(),
  initialInventory = { available: 10, on_hand: 20 },
  startTime = START_TIME,
  idempotencyWindowMs = DAY_MS,
} = {}) {
  const authorizedBinding = await bindExecutionEnvelope(envelope);
  const harness = createNetworkConformanceHarness({
    authorizedBinding,
    initialInventory,
    startTime,
    idempotencyWindowMs,
  });
  return { envelope, authorizedBinding, harness };
}

function signalFor(binding, overrides = {}) {
  return {
    delivery_id: "delivery-fixture-001",
    execution_id: binding.envelope.execution_id,
    binding_digest: binding.execution_binding_digest,
    target_digest: binding.target_digest,
    audience_digest: binding.audience_digest,
    target_time: START_TIME,
    signature: "fixture-valid",
    status: "inventory-adjusted",
    ...overrides,
  };
}

function assertBounded(snapshot, { effects = 0, consumptions = effects ? 1 : 0 } = {}) {
  assert.equal(snapshot.counters.protected_effects, effects);
  assert.ok(snapshot.counters.authority_reservations <= 1);
  assert.equal(snapshot.counters.authority_consumptions, consumptions);
  assert.ok(snapshot.idempotency_records.length <= 1);
  assert.ok(snapshot.lineages.length <= 1);
}

async function ambiguousFixture({ divergent = false, idempotencyWindowMs = DAY_MS } = {}) {
  const fixture = await makeFixture({ idempotencyWindowMs });
  if (divergent) {
    fixture.harness.faultController.schedule({ type: "divergent_effect", on_hand_delta: 4 });
  }
  fixture.harness.faultController.schedule({ type: "drop_response_after_effect" });
  const result = await fixture.harness.commitGateway.commit(fixture.envelope);
  assert.equal(result.outcome, "unknown");
  return fixture;
}

test("G7-01 exact transaction claim binds and commits through one gateway", async () => {
  const { envelope, authorizedBinding, harness } = await makeFixture();
  const result = await harness.commitGateway.commit(envelope);
  const snapshot = harness.snapshotEvidence();

  assert.equal(result.outcome, "committed_exact");
  assert.equal(authorizedBinding.envelope.authority_mode, "transaction_authorized");
  assert.equal(authorizedBinding.redacted_preimage.execution_id, envelope.execution_id);
  assert.equal(snapshot.counters.dispatches, 1);
  assert.equal(snapshot.authority.state, "consumed");
  assert.equal(snapshot.authority.log[0].binding_digest, authorizedBinding.execution_binding_digest);
  assert.equal(snapshot.authority.log[1].target_digest, authorizedBinding.target_digest);
  assert.equal(snapshot.fixture.kind, "synthetic_mock_only");
  assert.equal(snapshot.fixture.provider_conformance, "unknown");
  assert.doesNotMatch(JSON.stringify(snapshot), /access[_-]?token|cookie|credential/i);
  assertBounded(snapshot, { effects: 1 });
});

test("G7-02 changed quantity name fails before target transmission", async () => {
  const { harness } = await makeFixture();
  const result = await harness.commitGateway.commit(changed((envelope) => {
    envelope.action.quantity_name = "on_hand";
  }));
  const snapshot = harness.snapshotEvidence();

  assert.equal(result.outcome, "preflight_divergent");
  assert.equal(result.reason_code, "UNSUPPORTED_QUANTITY_NAME");
  assert.equal(result.differences[0].field, "$.action.quantity_name");
  assert.equal(snapshot.counters.dispatches, 0);
  assertBounded(snapshot);
});

test("G7-03 exactly one complete change normalizes to one outgoing change", async () => {
  const envelope = makeEnvelope();
  const binding = await bindExecutionEnvelope(envelope);
  const { harness } = await makeFixture({ envelope });
  const result = await harness.commitGateway.commit(envelope);

  assert.equal(binding.normalized_request.input.changes.length, 1);
  assert.deepEqual(binding.normalized_request.input.changes[0], {
    inventoryItemId: "fixture-inventory-item-001",
    locationId: "fixture-location-001",
    delta: 3,
    changeFromQuantity: 10,
  });
  assert.equal(result.outcome, "committed_exact");
  assertBounded(harness.snapshotEvidence(), { effects: 1 });
});

test("G7-04 a second change is rejected without partial application", async () => {
  const { harness } = await makeFixture();
  const result = await harness.commitGateway.commit(changed((envelope) => {
    envelope.action.changes.push({
      inventory_item: "fixture-inventory-item-002",
      location: "fixture-location-001",
      delta: 1,
      change_from_quantity: 2,
    });
  }));

  assert.equal(result.reason_code, "INVALID_CHANGE_CARDINALITY");
  assert.equal(result.dispatch_status, "not_dispatched");
  assertBounded(harness.snapshotEvidence());
});

test("G7-05 missing conditional quantity remains distinct and fails closed", async () => {
  const { harness } = await makeFixture();
  const result = await harness.commitGateway.commit(changed((envelope) => {
    delete envelope.action.changes[0].change_from_quantity;
  }));

  assert.equal(result.reason_code, "MISSING_FIELD");
  assert.equal(result.evidence.path, "$.action.changes[0].change_from_quantity");
  assertBounded(harness.snapshotEvidence());
});

test("G7-06 explicit null is never interpreted as an unconditional change", async () => {
  const { harness } = await makeFixture();
  const result = await harness.commitGateway.commit(changed((envelope) => {
    envelope.action.changes[0].change_from_quantity = null;
  }));

  assert.equal(result.reason_code, "NULL_CONDITIONAL");
  assert.equal(result.dispatch_status, "not_dispatched");
  assertBounded(harness.snapshotEvidence());
});

test("G7-07 fixed semantic and optional-field changes alter or violate the binding", async (t) => {
  const cases = [
    ["reason", (envelope) => { envelope.action.reason = "cycle_count_available"; }],
    ["reference URI", (envelope) => { envelope.action.reference_document_uri = "fixture://execution/other"; }],
    ["ledger null policy", (envelope) => { envelope.action.ledger_document_uri = "fixture://ledger/1"; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const { authorizedBinding, harness } = await makeFixture();
      const result = await harness.commitGateway.commit(changed(mutate));
      assert.equal(result.outcome, "preflight_divergent");
      assert.equal(result.dispatch_status, "not_dispatched");
      if (result.evidence.candidate_action_digest) {
        assert.notEqual(result.evidence.candidate_action_digest, authorizedBinding.action_digest);
      } else {
        assert.notEqual(result.evidence.candidate_binding_digest, authorizedBinding.execution_binding_digest);
      }
      assertBounded(harness.snapshotEvidence());
    });
  }
});

test("G7-08 unknown executable fields fail at every closed-envelope boundary", async (t) => {
  const cases = [
    ["top level", (envelope) => { envelope.metadata = { approve: true }; }],
    ["action", (envelope) => { envelope.action.fallback_operation = "inventorySetQuantities"; }],
    ["target side channel", (envelope) => { envelope.target_context.headers = { force: "true" }; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const { harness } = await makeFixture();
      const result = await harness.commitGateway.commit(changed(mutate));
      assert.equal(result.reason_code, "UNKNOWN_FIELD");
      assert.equal(result.dispatch_status, "not_dispatched");
      assertBounded(harness.snapshotEvidence());
    });
  }
});

test("G7-09 one exact delta records both quantity consequences", async () => {
  const { envelope, harness } = await makeFixture();
  const result = await harness.commitGateway.commit(envelope);
  const snapshot = harness.snapshotEvidence();
  const effect = snapshot.ledgers.protected_effects[0];

  assert.equal(result.outcome, "committed_exact");
  assert.deepEqual(effect.before, { available: 10, on_hand: 20 });
  assert.deepEqual(effect.after, { available: 13, on_hand: 23 });
  assert.equal(effect.inventory_item, envelope.target_context.inventory_item);
  assert.equal(effect.location, envelope.target_context.location);
  assert.equal(effect.delta, 3);
  assertBounded(snapshot, { effects: 1 });
});

test("G7-10 identical same-ID replay converges on one effect and lineage", async () => {
  const { envelope, harness } = await makeFixture();
  const first = await harness.commitGateway.commit(envelope);
  const replay = await harness.commitGateway.commit(structuredClone(envelope));
  const snapshot = harness.snapshotEvidence();

  assert.equal(first.outcome, "committed_exact");
  assert.equal(replay.outcome, "committed_exact");
  assert.equal(snapshot.counters.dispatches, 2);
  assert.equal(snapshot.idempotency_records.length, 1);
  assert.equal(snapshot.lineages.length, 1);
  assertBounded(snapshot, { effects: 1 });
});

test("G7-11 same ID with any changed bound field preserves the original record", async (t) => {
  const cases = [
    ["delta", (envelope) => { envelope.action.changes[0].delta = 4; }],
    ["reference", (envelope) => { envelope.action.reference_document_uri = "fixture://execution/changed"; }],
    ["store", (envelope) => { envelope.target_context.development_store = "fixture-store-002"; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const { envelope, harness } = await makeFixture();
      await harness.commitGateway.commit(envelope);
      const candidate = structuredClone(envelope);
      mutate(candidate);
      const result = await harness.commitGateway.commit(candidate);
      const snapshot = harness.snapshotEvidence();
      assert.equal(result.outcome, "preflight_divergent");
      assert.equal(result.reason_code, "EXECUTION_ID_BINDING_CONFLICT");
      assert.equal(snapshot.counters.dispatches, 1);
      assertBounded(snapshot, { effects: 1 });
    });
  }
});

test("G7-12 concurrent identical calls serialize to one authority use and effect", async () => {
  const { envelope, harness } = await makeFixture();
  const [first, second] = await Promise.all([
    harness.commitGateway.commit(envelope),
    harness.commitGateway.commit(structuredClone(envelope)),
  ]);
  const snapshot = harness.snapshotEvidence();

  assert.equal(first.outcome, "committed_exact");
  assert.ok(["committed_exact", "unknown"].includes(second.outcome));
  if (second.outcome === "unknown") assert.equal(second.reason_code, "EXECUTION_IN_PROGRESS");
  assert.equal(snapshot.counters.authority_consumptions, 1);
  assert.equal(snapshot.lineages.length, 1);
  assertBounded(snapshot, { effects: 1 });
});

test("G7-13 stale expected quantity reaches the target conditional and has no effect", async () => {
  const { envelope, harness } = await makeFixture({ initialInventory: { available: 11, on_hand: 21 } });
  const result = await harness.commitGateway.commit(envelope);
  const snapshot = harness.snapshotEvidence();

  assert.equal(result.outcome, "preflight_rejected");
  assert.equal(result.reason_code, "STALE_EXPECTED_QUANTITY");
  assert.equal(snapshot.counters.dispatches, 1);
  assert.deepEqual(snapshot.inventory, { available: 11, on_hand: 21 });
  assertBounded(snapshot, { effects: 0, consumptions: 1 });
});

test("G7-14 an explicit competing writer is separate and the protected CAS rejects", async () => {
  const { envelope, harness } = await makeFixture();
  const before = harness.currentStateObserver.readCurrentState();
  harness.testActors.competingWrite({ availableDelta: 2, onHandDelta: 2 });
  const result = await harness.commitGateway.commit(envelope);
  const snapshot = harness.snapshotEvidence();

  assert.deepEqual(before.state, { available: 10, on_hand: 20 });
  assert.equal(result.reason_code, "STALE_EXPECTED_QUANTITY");
  assert.equal(snapshot.ledgers.external_writes.length, 1);
  assert.deepEqual(snapshot.inventory, { available: 12, on_hand: 22 });
  assertBounded(snapshot, { effects: 0, consumptions: 1 });
});

test("G7-15 wrong store context is rejected before transmission", async () => {
  const { harness } = await makeFixture();
  const result = await harness.commitGateway.commit(changed((envelope) => {
    envelope.target_context.development_store = "fixture-store-wrong";
  }));

  assert.equal(result.outcome, "preflight_divergent");
  assert.equal(result.dispatch_status, "not_dispatched");
  assert.equal(result.differences[0].field, "target_context.development_store");
  assertBounded(harness.snapshotEvidence());
});

test("G7-16 wrong item or location fails before transmission", async (t) => {
  for (const field of ["inventory_item", "location"]) {
    await t.test(field, async () => {
      const { harness } = await makeFixture();
      const result = await harness.commitGateway.commit(changed((envelope) => {
        envelope.action.changes[0][field] = `fixture-wrong-${field}`;
      }));
      assert.equal(result.outcome, "preflight_divergent");
      assert.equal(result.reason_code, "INTERNAL_BINDING_MISMATCH");
      assertBounded(harness.snapshotEvidence());
    });
  }
});

test("G7-17 audience, issuer, tenant, and account labels all fail closed", async (t) => {
  const cases = [
    ["protected_adapter", (envelope) => { envelope.audience.protected_adapter = "fixture-adapter:wrong"; }],
    ["issuer", (envelope) => { envelope.audience.issuer = "fixture-issuer-wrong"; }],
    ["tenant", (envelope) => { envelope.audience.tenant = "fixture-tenant-wrong"; }],
    ["account", (envelope) => { envelope.audience.account = "fixture-account-wrong"; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const { harness } = await makeFixture();
      const result = await harness.commitGateway.commit(changed(mutate));
      assert.equal(result.outcome, "preflight_divergent");
      assert.equal(result.dispatch_status, "not_dispatched");
      assertBounded(harness.snapshotEvidence());
    });
  }
});

test("G7-18 expired or revoked authority cannot reach commit dispatch", async (t) => {
  await t.test("expired", async () => {
    const { envelope, harness } = await makeFixture({ startTime: "2026-09-01T16:00:00.000Z" });
    const result = await harness.commitGateway.commit(envelope);
    assert.equal(result.outcome, "pre_adapter_not_attempted");
    assert.equal(result.reason_code, "AUTHORITY_EXPIRED");
    assertBounded(harness.snapshotEvidence());
  });
  await t.test("revoked immediately before dispatch", async () => {
    const { envelope, harness } = await makeFixture();
    harness.faultController.schedule({ type: "revoke_authority_before_dispatch" });
    const result = await harness.commitGateway.commit(envelope);
    const snapshot = harness.snapshotEvidence();
    assert.equal(result.reason_code, "AUTHORITY_REVOKED_BEFORE_DISPATCH");
    assert.equal(snapshot.authority.state, "reserved");
    assertBounded(snapshot);
  });
});

test("G7-19 before and after reads remain labelled current-state observations", async () => {
  const { envelope, harness } = await makeFixture();
  const before = harness.currentStateObserver.readCurrentState();
  await harness.commitGateway.commit(envelope);
  const after = harness.currentStateObserver.readCurrentState();
  const snapshot = harness.snapshotEvidence();

  assert.equal(before.kind, "current_state_observation");
  assert.equal(after.kind, "current_state_observation");
  assert.equal(before.causal_execution_result, false);
  assert.equal(after.causal_execution_result, false);
  assert.deepEqual(before.state, { available: 10, on_hand: 20 });
  assert.deepEqual(after.state, { available: 13, on_hand: 23 });
  assert.equal(snapshot.counters.current_state_reads, 2);
  assertBounded(snapshot, { effects: 1 });
});

test("G7-20 retry deadline permits only strictly pre-deadline same-ID replay", async (t) => {
  for (const [name, advanceBy, expectedOutcome] of [
    ["just before", 999, "committed_exact"],
    ["exactly at", 1_000, "preflight_rejected"],
    ["just after", 1_001, "preflight_rejected"],
  ]) {
    await t.test(name, async () => {
      const { envelope, harness } = await makeFixture({ idempotencyWindowMs: 1_000 });
      await harness.commitGateway.commit(envelope);
      harness.faultController.advance(advanceBy);
      const replay = await harness.commitGateway.commit(envelope);
      const snapshot = harness.snapshotEvidence();
      assert.equal(replay.outcome, expectedOutcome);
      if (advanceBy >= 1_000) assert.equal(replay.reason_code, "IDEMPOTENCY_DEADLINE_REACHED");
      assert.equal(snapshot.counters.dispatches, advanceBy < 1_000 ? 2 : 1);
      assertBounded(snapshot, { effects: 1 });
    });
  }
});

test("risk regression: first-attempt envelope deadline blocks at and after its boundary", async (t) => {
  const envelope = changed((candidate) => {
    candidate.deadline = "2026-08-28T16:00:01.000Z";
  });
  for (const [name, startTime, expectedOutcome] of [
    ["just before", "2026-08-28T16:00:00.999Z", "committed_exact"],
    ["exactly at", "2026-08-28T16:00:01.000Z", "pre_adapter_not_attempted"],
    ["just after", "2026-08-28T16:00:01.001Z", "pre_adapter_not_attempted"],
  ]) {
    await t.test(name, async () => {
      const { harness } = await makeFixture({ envelope, startTime });
      const result = await harness.commitGateway.commit(envelope);
      const snapshot = harness.snapshotEvidence();
      assert.equal(result.outcome, expectedOutcome);
      if (startTime >= envelope.deadline) assert.equal(result.reason_code, "ENVELOPE_DEADLINE_REACHED");
      assert.equal(snapshot.counters.dispatches, startTime < envelope.deadline ? 1 : 0);
      assertBounded(snapshot, { effects: startTime < envelope.deadline ? 1 : 0 });
    });
  }
});

test("G8-01 accepted target effect plus dropped response remains unknown", async () => {
  const { harness } = await ambiguousFixture();
  const snapshot = harness.snapshotEvidence();

  assert.equal(snapshot.lineages[0].outcome, "unknown");
  assert.equal(snapshot.lineages[0].dispatch_status, "response_unknown");
  assert.equal(snapshot.authority.state, "consumed");
  assert.ok(snapshot.ledgers.faults.some((entry) => (
    entry.event === "applied" && entry.position === "after_target_effect_before_response"
  )));
  assertBounded(snapshot, { effects: 1 });
});

test("G8-02 timeout before executable lineage has local proof of no dispatch", async () => {
  const { envelope, harness } = await makeFixture();
  harness.faultController.schedule({ type: "before_lineage_timeout" });
  const result = await harness.commitGateway.commit(envelope);
  const snapshot = harness.snapshotEvidence();

  assert.equal(result.outcome, "pre_adapter_not_attempted");
  assert.equal(result.dispatch_status, "not_dispatched");
  assert.equal(result.evidence.local_dispatch_proof, true);
  assert.equal(snapshot.lineages.length, 0);
  assertBounded(snapshot);
});

test("G8-03 post-dispatch timeout does not become negative proof", async () => {
  const { envelope, harness } = await makeFixture();
  harness.faultController.schedule({ type: "post_dispatch_timeout" });
  const result = await harness.commitGateway.commit(envelope);
  const snapshot = harness.snapshotEvidence();

  assert.equal(result.outcome, "unknown");
  assert.equal(result.reason_code, "POST_DISPATCH_TIMEOUT");
  assert.equal(snapshot.counters.dispatches, 1);
  assertBounded(snapshot, { effects: 1 });
});

test("G8-04 delayed valid webhook is corroborating and cannot erase uncertainty", async () => {
  const { authorizedBinding, harness } = await ambiguousFixture();
  harness.currentStateObserver.readCurrentState();
  harness.faultController.advance(5_000);
  const signal = harness.webhookSignalIntake.receive(signalFor(authorizedBinding));
  const snapshot = harness.snapshotEvidence();

  assert.equal(signal.accepted, true);
  assert.equal(signal.corroborating_only, true);
  assert.equal(snapshot.lineages[0].outcome, "unknown");
  assertBounded(snapshot, { effects: 1 });
});

test("G8-05 duplicate delivery is one accepted signal plus an anomaly", async () => {
  const { authorizedBinding, harness } = await ambiguousFixture();
  const signal = signalFor(authorizedBinding);
  const first = harness.webhookSignalIntake.receive(signal);
  const duplicate = harness.webhookSignalIntake.receive(structuredClone(signal));
  const snapshot = harness.snapshotEvidence();

  assert.equal(first.accepted, true);
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason_code, "DUPLICATE_DELIVERY");
  assert.equal(snapshot.counters.accepted_signals, 1);
  assert.equal(snapshot.lineages.length, 1);
  assertBounded(snapshot, { effects: 1 });
});

test("G8-06 missing webhook never proves nonexecution", async () => {
  const { harness } = await ambiguousFixture();
  harness.faultController.advance(DAY_MS);
  const snapshot = harness.snapshotEvidence();

  assert.equal(snapshot.ledgers.signals.length, 0);
  assert.equal(snapshot.lineages[0].outcome, "unknown");
  assertBounded(snapshot, { effects: 1 });
});

test("G8-07 reordered signals preserve target time separately from receipt time", async () => {
  const { authorizedBinding, harness } = await ambiguousFixture();
  const laterTargetSignal = signalFor(authorizedBinding, {
    delivery_id: "delivery-later-target",
    target_time: "2026-08-28T16:00:10.000Z",
  });
  const earlierTargetSignal = signalFor(authorizedBinding, {
    delivery_id: "delivery-earlier-target",
    target_time: "2026-08-28T16:00:05.000Z",
  });
  harness.faultController.advance(20_000);
  harness.webhookSignalIntake.receive(laterTargetSignal);
  harness.faultController.advance(1_000);
  harness.webhookSignalIntake.receive(earlierTargetSignal);
  const snapshot = harness.snapshotEvidence();

  assert.equal(snapshot.ledgers.signals[0].target_time, laterTargetSignal.target_time);
  assert.equal(snapshot.ledgers.signals[1].target_time, earlierTargetSignal.target_time);
  assert.ok(snapshot.ledgers.signals[0].received_at < snapshot.ledgers.signals[1].received_at);
  assert.equal(snapshot.lineages[0].outcome, "unknown");
  assertBounded(snapshot, { effects: 1 });
});

test("G8-08 wrong or stale signal evidence is rejected without consequence", async (t) => {
  const cases = [
    ["signature", { signature: "fixture-invalid" }],
    ["target", { target_digest: "wrong-target" }],
    ["audience", { audience_digest: "wrong-audience" }],
    ["execution", { execution_id: "wrong-execution" }],
    ["binding", { binding_digest: "wrong-binding" }],
    ["freshness", { target_time: "2026-08-20T16:00:00.000Z" }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const { authorizedBinding, harness } = await ambiguousFixture();
      const result = harness.webhookSignalIntake.receive(signalFor(authorizedBinding, {
        delivery_id: `delivery-${name}`,
        ...overrides,
      }));
      const snapshot = harness.snapshotEvidence();
      assert.equal(result.accepted, false);
      assert.equal(snapshot.lineages[0].outcome, "unknown");
      assertBounded(snapshot, { effects: 1 });
    });
  }
});

test("G8-09 matching current state is not causal execution proof", async () => {
  const { harness } = await ambiguousFixture();
  const observation = harness.currentStateObserver.readCurrentState();
  const snapshot = harness.snapshotEvidence();

  assert.deepEqual(observation.state, { available: 13, on_hand: 23 });
  assert.equal(observation.causal_execution_result, false);
  assert.equal(snapshot.lineages[0].outcome, "unknown");
  assert.equal(snapshot.counters.reconciliation_reads, 0);
  assertBounded(snapshot, { effects: 1 });
});

test("G8-10 exact operation record resolves the original unknown lineage read-only", async () => {
  const { envelope, harness } = await ambiguousFixture();
  const before = harness.snapshotEvidence();
  const reconciliation = harness.executionReconciler.reconcileExecution(envelope.execution_id);
  const after = harness.snapshotEvidence();

  assert.equal(reconciliation.outcome, "committed_exact");
  assert.equal(after.lineages.length, 1);
  assert.equal(after.lineages[0].outcome, "committed_exact");
  assert.ok(after.lineages[0].events.some((event) => event.type === "response_unknown"));
  assert.equal(after.counters.protected_effects, before.counters.protected_effects);
  assert.equal(after.counters.authority_consumptions, before.counters.authority_consumptions);
  assertBounded(after, { effects: 1 });
});

test("G8-11 divergent operation record preserves divergent committed truth", async () => {
  const { envelope, harness } = await ambiguousFixture({ divergent: true });
  const reconciliation = harness.executionReconciler.reconcileExecution(envelope.execution_id);
  const snapshot = harness.snapshotEvidence();

  assert.equal(reconciliation.outcome, "committed_divergent");
  assert.equal(snapshot.lineages[0].outcome, "committed_divergent");
  assert.deepEqual(snapshot.inventory, { available: 13, on_hand: 24 });
  assertBounded(snapshot, { effects: 1 });
});

test("G8-12 weak absence or wrong-context reconciliation leaves unknown", async (t) => {
  const cases = [
    ["not found", () => ({ kind: "not_found", consistency: "eventual" })],
    ["eventual absence", () => ({ kind: "not_found", consistency: "eventual", authenticity: "fixture_authenticated" })],
    ["unsigned absence", () => ({ kind: "not_found", consistency: "atomic", authenticity: "unsigned" })],
    ["wrong context", (record) => ({ ...record, target_digest: "wrong-target" })],
  ];
  for (const [name, evidenceFactory] of cases) {
    await t.test(name, async () => {
      const { envelope, harness } = await ambiguousFixture();
      const record = harness.snapshotEvidence().operation_records[0];
      harness.faultController.schedule({ type: "reconcile_override", evidence: evidenceFactory(record) });
      const result = harness.executionReconciler.reconcileExecution(envelope.execution_id);
      const beforeRetry = harness.snapshotEvidence();
      const retry = await harness.commitGateway.commit(envelope);
      const snapshot = harness.snapshotEvidence();
      assert.equal(result.outcome, "unknown");
      assert.equal(retry.outcome, "unknown");
      assert.equal(retry.reason_code, "UNRESOLVED_LINEAGE_RETRY_BLOCKED");
      assert.equal(snapshot.lineages[0].outcome, "unknown");
      assert.equal(snapshot.counters.dispatches, beforeRetry.counters.dispatches);
      assertBounded(snapshot, { effects: 1 });
    });
  }
});

test("G8-13 malformed, stale, incomplete, extra, or unbound evidence fails closed", async (t) => {
  const cases = [
    ["malformed", () => "not-an-operation-record"],
    ["extra", (record) => ({ ...record, executable_hint: "retry" })],
    ["stale", (record) => ({ ...record, fresh_until: "2026-08-28T15:59:59.000Z" })],
    ["future observed time", (record) => ({
      ...record,
      observed_at: "2030-01-01T00:00:00.000Z",
      fresh_until: "2030-01-02T00:00:00.000Z",
    })],
    ["non-increasing freshness interval", (record) => ({
      ...record,
      observed_at: START_TIME,
      fresh_until: START_TIME,
    })],
    ["excessive evidence lifetime", (record) => ({
      ...record,
      observed_at: START_TIME,
      fresh_until: "2026-09-05T16:00:00.001Z",
    })],
    ["incomplete", (record) => { const copy = structuredClone(record); delete copy.committed_state; return copy; }],
    ["unbound", (record) => ({ ...record, binding_digest: "wrong-binding" })],
    ["false confirmed nonexecution after effect", (record) => ({
      ...record,
      outcome: "confirmed_nonexecution",
      effect_reference: null,
      committed_state: null,
    })],
  ];
  for (const [name, evidenceFactory] of cases) {
    await t.test(name, async () => {
      const { envelope, harness } = await ambiguousFixture();
      const record = harness.snapshotEvidence().operation_records[0];
      harness.faultController.schedule({ type: "reconcile_override", evidence: evidenceFactory(record) });
      const result = harness.executionReconciler.reconcileExecution(envelope.execution_id);
      const snapshot = harness.snapshotEvidence();
      assert.equal(result.outcome, "unknown");
      assert.ok(snapshot.lineages[0].anomalies.length >= 1);
      assertBounded(snapshot, { effects: 1 });
    });
  }
});

test("risk regression: reconciliation derives consequence from a closed committed state", async (t) => {
  await t.test("wrong quantities become committed divergent despite an exact label", async () => {
    const { envelope, harness } = await ambiguousFixture();
    const evidence = harness.snapshotEvidence().operation_records[0];
    evidence.outcome = "committed_exact";
    evidence.committed_state = { available: 999, on_hand: 999 };
    harness.faultController.schedule({ type: "reconcile_override", evidence });
    const result = harness.executionReconciler.reconcileExecution(envelope.execution_id);
    const snapshot = harness.snapshotEvidence();

    assert.equal(result.outcome, "committed_divergent");
    assert.equal(snapshot.lineages[0].outcome, "committed_divergent");
    assert.ok(snapshot.lineages[0].anomalies.some((entry) => (
      entry.code === "EVIDENCE_OUTCOME_LABEL_MISMATCH"
    )));
    assertBounded(snapshot, { effects: 1 });
  });

  for (const [name, committedState] of [
    ["malformed committed state", "not-an-object"],
    ["extra committed-state field", { available: 13, on_hand: 23, retry: true }],
  ]) {
    await t.test(name, async () => {
      const { envelope, harness } = await ambiguousFixture();
      const evidence = harness.snapshotEvidence().operation_records[0];
      evidence.committed_state = committedState;
      harness.faultController.schedule({ type: "reconcile_override", evidence });
      const result = harness.executionReconciler.reconcileExecution(envelope.execution_id);
      const snapshot = harness.snapshotEvidence();

      assert.equal(result.outcome, "unknown");
      assert.equal(snapshot.lineages[0].outcome, "unknown");
      assert.ok(snapshot.lineages[0].anomalies.length >= 1);
      assertBounded(snapshot, { effects: 1 });
    });
  }
});

test("G8-14 stronger exact evidence advances only the original append-only lineage", async () => {
  const { envelope, harness } = await ambiguousFixture();
  const before = harness.snapshotEvidence();
  harness.executionReconciler.reconcileExecution(envelope.execution_id);
  const after = harness.snapshotEvidence();

  assert.equal(before.lineages[0].outcome, "unknown");
  assert.equal(after.lineages[0].outcome, "committed_exact");
  assert.equal(after.lineages.length, 1);
  const types = after.lineages[0].events.map((event) => event.type);
  assert.ok(types.includes("response_unknown"));
  assert.ok(types.includes("reconciliation_evidence"));
  assertBounded(after, { effects: 1 });
});

test("G8-15 weaker or conflicting evidence cannot overwrite a confirmed consequence", async (t) => {
  await t.test("weaker after exact", async () => {
    const { envelope, harness } = await makeFixture();
    await harness.commitGateway.commit(envelope);
    harness.faultController.schedule({
      type: "reconcile_override",
      evidence: { kind: "not_found", consistency: "eventual" },
    });
    const result = harness.executionReconciler.reconcileExecution(envelope.execution_id);
    const snapshot = harness.snapshotEvidence();
    assert.equal(result.outcome, "committed_exact");
    assert.equal(snapshot.lineages[0].outcome, "committed_exact");
    assert.ok(snapshot.lineages[0].anomalies.length >= 1);
    assertBounded(snapshot, { effects: 1 });
  });
  await t.test("conflicting exact after divergent", async () => {
    const { envelope, harness } = await makeFixture();
    harness.faultController.schedule({ type: "divergent_effect", on_hand_delta: 4 });
    await harness.commitGateway.commit(envelope);
    const conflicting = harness.snapshotEvidence().operation_records[0];
    conflicting.outcome = "committed_exact";
    conflicting.committed_state = { available: 13, on_hand: 23 };
    harness.faultController.schedule({ type: "reconcile_override", evidence: conflicting });
    const result = harness.executionReconciler.reconcileExecution(envelope.execution_id);
    const snapshot = harness.snapshotEvidence();
    assert.equal(result.outcome, "committed_divergent");
    assert.equal(snapshot.lineages[0].outcome, "committed_divergent");
    assert.ok(snapshot.lineages[0].anomalies.some((entry) => entry.code === "CONFIRMED_OUTCOME_CONFLICT"));
    assertBounded(snapshot, { effects: 1 });
  });
});

test("G8-16 alternate mutation path attempt fails structurally before any effect", async () => {
  const { authorizedBinding, harness } = await makeFixture();
  harness.faultController.schedule({ type: "webhook_mutation_attempt" });
  assert.throws(
    () => harness.webhookSignalIntake.receive(signalFor(authorizedBinding)),
    (error) => error?.code === "ALTERNATE_MUTATION_PATH_BLOCKED",
  );
  const snapshot = harness.snapshotEvidence();

  assert.equal(snapshot.counters.bypass_attempts, 1);
  assert.equal(snapshot.ledgers.bypass_attempts[0].protected_effect_count, 0);
  assert.equal(snapshot.ledgers.bypass_attempts[0].boundary, "non_commit_fault_helper");
  assertBounded(snapshot);
});

test("G8-17 ambiguity beyond the idempotency deadline blocks automatic retry", async () => {
  const { envelope, harness } = await ambiguousFixture({ idempotencyWindowMs: 1_000 });
  const before = harness.snapshotEvidence();
  harness.faultController.advance(1_001);
  const retry = await harness.commitGateway.commit(envelope);
  const after = harness.snapshotEvidence();

  assert.equal(retry.outcome, "preflight_rejected");
  assert.equal(retry.reason_code, "IDEMPOTENCY_DEADLINE_REACHED");
  assert.equal(after.lineages[0].outcome, "unknown");
  assert.equal(after.counters.dispatches, before.counters.dispatches);
  assert.equal(after.counters.protected_effects, before.counters.protected_effects);
  assert.equal(after.counters.authority_consumptions, before.counters.authority_consumptions);
  assertBounded(after, { effects: 1 });
});

test("G8-18 repeated reconciliation and duplicate signals remain read-only on one lineage", async () => {
  const { envelope, authorizedBinding, harness } = await ambiguousFixture();
  const signal = signalFor(authorizedBinding);
  harness.webhookSignalIntake.receive(signal);
  const first = harness.executionReconciler.reconcileExecution(envelope.execution_id);
  harness.webhookSignalIntake.receive(signal);
  const second = harness.executionReconciler.reconcileExecution(envelope.execution_id);
  const snapshot = harness.snapshotEvidence();

  assert.equal(first.outcome, "committed_exact");
  assert.equal(second.outcome, "committed_exact");
  assert.equal(snapshot.counters.reconciliation_reads, 2);
  assert.equal(snapshot.lineages.length, 1);
  assert.equal(snapshot.counters.authority_consumptions, 1);
  assertBounded(snapshot, { effects: 1 });
});
