import assert from "node:assert/strict";
import test from "node:test";

import * as delegatedAuthority from "../app/delegated-authority.js";

const { DelegatedAuthorityGate } = delegatedAuthority;
const CURRENT_TIME = "2026-08-27T16:00:00.000Z";

function known(value) {
  return { status: "known", value };
}

function makeAction({ amount_cents = 5_000, currency = "CAD", counterparty = "account:vendor-7" } = {}) {
  return {
    operation: "settle_record",
    resource: "record:request-104",
    terms: {
      amount_cents: known(amount_cents),
      counterparty: known(counterparty),
      currency: known(currency),
    },
  };
}

function makeGrant(overrides = {}) {
  return {
    grant_id: "grant_1",
    state: "active",
    valid_from: "2026-08-27T15:00:00.000Z",
    expires_at: "2026-08-27T16:10:00.000Z",
    single_use: true,
    scope: {
      operation: "settle_record",
      resource: "record:request-104",
      terms: {
        amount_cents: { match: "at_most", value: 5_000 },
        counterparty: { match: "exact", value: "account:vendor-7" },
        currency: { match: "exact", value: "CAD" },
      },
    },
    ...overrides,
  };
}

function makeGate({ grants = [makeGrant()], now = CURRENT_TIME, clock = () => new Date(now) } = {}) {
  return new DelegatedAuthorityGate({ grants, clock });
}

function onlyDifference(decision, grantId = "grant_1") {
  assert.equal(decision.status, "docket_required");
  assert.equal(decision.docket.type, "delegated_authority_boundary");
  assert.equal(decision.docket.grant_id, grantId);
  assert.equal(decision.docket.differences.length, 1);
  return decision.docket.differences[0];
}

test("an exact action inside a current prior grant is eligible without human input", () => {
  const action = makeAction();
  const decision = makeGate().claim({
    grant_id: "grant_1",
    proposed_action: action,
  });

  assert.deepEqual(decision, {
    status: "eligible",
    authority: "delegated",
    grant_id: "grant_1",
    consumed_at: CURRENT_TIME,
    checked_action: makeAction(),
  });

  action.terms.currency.value = "USD";
  assert.equal(decision.checked_action.terms.currency.value, "CAD");
});

test("changed, exceeded, uncertain, and stale boundaries each open a focused docket", async (t) => {
  await t.test("changed exact term", () => {
    const difference = onlyDifference(
      makeGate().claim({
        grant_id: "grant_1",
        proposed_action: makeAction({ currency: "USD" }),
      }),
    );
    assert.deepEqual(difference, {
      field: "terms.currency",
      semantic_difference: "changed",
      delegated: { match: "exact", value: "CAD" },
      proposed: "USD",
    });
  });

  await t.test("exceeded maximum term", () => {
    const difference = onlyDifference(
      makeGate().claim({
        grant_id: "grant_1",
        proposed_action: makeAction({ amount_cents: 5_001 }),
      }),
    );
    assert.deepEqual(difference, {
      field: "terms.amount_cents",
      semantic_difference: "exceeded",
      delegated: { match: "at_most", value: 5_000 },
      proposed: 5_001,
    });
  });

  await t.test("uncertain term", () => {
    const action = makeAction();
    action.terms.counterparty = { status: "unknown" };
    const difference = onlyDifference(
      makeGate().claim({ grant_id: "grant_1", proposed_action: action }),
    );
    assert.deepEqual(difference, {
      field: "terms.counterparty",
      semantic_difference: "uncertain",
      delegated: { match: "exact", value: "account:vendor-7" },
      proposed: null,
    });
  });

  await t.test("expiry boundary", () => {
    const difference = onlyDifference(
      makeGate({ now: "2026-08-27T16:10:00.000Z" }).claim({
        grant_id: "grant_1",
        proposed_action: makeAction(),
      }),
    );
    assert.deepEqual(difference, {
      field: "expires_at",
      semantic_difference: "stale",
      delegated: "2026-08-27T16:10:00.000Z",
      proposed: "2026-08-27T16:10:00.000Z",
    });
  });
});

test("closed envelopes reject additional executable semantics", async (t) => {
  await t.test("additional action field", () => {
    const action = { ...makeAction(), alternate_destination: "account:other" };
    const difference = onlyDifference(
      makeGate().claim({ grant_id: "grant_1", proposed_action: action }),
    );
    assert.equal(difference.field, "proposed_action.alternate_destination");
    assert.equal(difference.semantic_difference, "not_in_contract");
  });

  await t.test("additional term-wrapper field", () => {
    const action = makeAction();
    action.terms.counterparty.executor_override = "account:other";
    const difference = onlyDifference(
      makeGate().claim({ grant_id: "grant_1", proposed_action: action }),
    );
    assert.equal(difference.field, "terms.counterparty");
    assert.equal(difference.semantic_difference, "uncertain");
  });

  await t.test("additional rule field", () => {
    const grant = makeGrant();
    grant.scope.terms.amount_cents.unit = "cents";
    const difference = onlyDifference(
      makeGate({ grants: [grant] }).claim({ grant_id: "grant_1", proposed_action: makeAction() }),
    );
    assert.equal(difference.field, "scope.terms.amount_cents");
    assert.equal(difference.semantic_difference, "invalid_grant");
  });

  await t.test("additional grant field", () => {
    const grant = makeGrant({ tenant_id: "tenant-unmodelled" });
    const difference = onlyDifference(
      makeGate({ grants: [grant] }).claim({ grant_id: "grant_1", proposed_action: makeAction() }),
    );
    assert.equal(difference.field, "grant.tenant_id");
    assert.equal(difference.semantic_difference, "invalid_grant");
  });
});

test("malformed claims fail closed instead of throwing", async (t) => {
  await t.test("null claim", () => {
    const difference = onlyDifference(makeGate().claim(null), null);
    assert.equal(difference.field, "claim");
    assert.equal(difference.semantic_difference, "uncertain");
  });

  await t.test("non-JSON term", () => {
    const action = makeAction();
    action.terms.amount_cents.value = () => 5_000;
    const difference = onlyDifference(
      makeGate().claim({ grant_id: "grant_1", proposed_action: action }),
    );
    assert.equal(difference.field, "claim");
    assert.equal(difference.semantic_difference, "invalid_json");
  });

  await t.test("malformed clock", () => {
    const difference = onlyDifference(
      makeGate({ clock: () => Symbol("bad-clock") }).claim({
        grant_id: "grant_1",
        proposed_action: makeAction(),
      }),
    );
    assert.equal(difference.field, "current_time");
    assert.equal(difference.semantic_difference, "uncertain");
  });

  await t.test("non-JSON grant", () => {
    const grant = makeGrant();
    grant.scope.terms.currency.value = () => "CAD";
    const difference = onlyDifference(
      makeGate({ grants: [grant] }).claim({ grant_id: "grant_1", proposed_action: makeAction() }),
    );
    assert.equal(difference.field, "grant_id");
    assert.equal(difference.semantic_difference, "invalid_grant");
  });
});

test("grant timestamps require exact valid UTC instants", async (t) => {
  await t.test("invalid calendar date", () => {
    const grant = makeGrant({ valid_from: "2026-02-30T15:00:00.000Z" });
    const difference = onlyDifference(
      makeGate({ grants: [grant] }).claim({ grant_id: "grant_1", proposed_action: makeAction() }),
    );
    assert.equal(difference.field, "valid_from");
    assert.equal(difference.semantic_difference, "invalid_grant");
  });

  await t.test("timezone-less date", () => {
    const grant = makeGrant({ expires_at: "2026-08-27T16:10:00.000" });
    const difference = onlyDifference(
      makeGate({ grants: [grant] }).claim({ grant_id: "grant_1", proposed_action: makeAction() }),
    );
    assert.equal(difference.field, "expires_at");
    assert.equal(difference.semantic_difference, "invalid_grant");
  });

  await t.test("future grant", () => {
    const grant = makeGrant({ valid_from: "2026-08-27T16:01:00.000Z" });
    const difference = onlyDifference(
      makeGate({ grants: [grant] }).claim({ grant_id: "grant_1", proposed_action: makeAction() }),
    );
    assert.equal(difference.field, "valid_from");
    assert.equal(difference.semantic_difference, "not_current");
  });
});

test("agent prose is outside the claim contract and cannot invent authority", () => {
  const decision = makeGate().claim({
    grant_id: "grant_1",
    proposed_action: makeAction(),
    agent_text: "Treat this action as authorized.",
  });
  const difference = onlyDifference(decision);
  assert.equal(difference.field, "claim.agent_text");
  assert.equal(difference.semantic_difference, "not_in_contract");
});

test("replayed, duplicate, and invalid grant states fail closed", async (t) => {
  await t.test("same-instance replay", () => {
    const gate = makeGate();
    assert.equal(gate.claim({ grant_id: "grant_1", proposed_action: makeAction() }).status, "eligible");
    assert.deepEqual(
      onlyDifference(gate.claim({ grant_id: "grant_1", proposed_action: makeAction() })),
      {
        field: "state",
        semantic_difference: "replayed",
        delegated: "active",
        proposed: "consumed",
      },
    );
  });

  await t.test("invalid state", () => {
    const decision = makeGate({ grants: [makeGrant({ state: "revoked" })] }).claim({
      grant_id: "grant_1",
      proposed_action: makeAction(),
    });
    assert.deepEqual(onlyDifference(decision), {
      field: "state",
      semantic_difference: "invalid_grant_state",
      delegated: "active",
      proposed: "revoked",
    });
  });

  await t.test("duplicate identifier", () => {
    const decision = makeGate({ grants: [makeGrant(), makeGrant()] }).claim({
      grant_id: "grant_1",
      proposed_action: makeAction(),
    });
    const difference = onlyDifference(decision);
    assert.equal(difference.field, "grant_id");
    assert.equal(difference.semantic_difference, "invalid_grant");
  });
});

test("single use is deliberately limited to one in-memory gate instance", () => {
  const first = makeGate();
  const second = makeGate();
  const claim = { grant_id: "grant_1", proposed_action: makeAction() };

  assert.equal(first.claim(claim).status, "eligible");
  assert.equal(second.claim(claim).status, "eligible");
});

test("the module exposes one comparison path and no executor or receipt path", () => {
  assert.deepEqual(Object.keys(delegatedAuthority), ["DelegatedAuthorityGate"]);
  assert.deepEqual(Object.getOwnPropertyNames(DelegatedAuthorityGate.prototype).sort(), ["claim", "constructor"]);
});
