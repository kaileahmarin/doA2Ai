import test from "node:test";
import assert from "node:assert/strict";

import { receiptOutcomeCopy, redactReceipt } from "../app/receipt.js";

test("every model terminal outcome has explicit non-success receipt copy", () => {
  const exceptionalOutcomes = [
    "denied",
    "blocked_divergent",
    "blocked_expired",
    "blocked_brief_expired",
    "execution_failed",
    "executed_divergent",
  ];

  assert.equal(receiptOutcomeCopy("executed").tone, "success");
  for (const outcome of exceptionalOutcomes) {
    const copy = receiptOutcomeCopy(outcome);
    assert.notEqual(copy.tone, "success", `${outcome} must not render as a successful exact match`);
    assert.ok(copy.title);
    assert.ok(copy.subtitle);
    assert.ok(copy.badge);
  }

  assert.equal(receiptOutcomeCopy("execution_failed").consequenceKind, "unknown");
  assert.equal(receiptOutcomeCopy("execution_failed").comparedEmptyLabel, "Unknown");
  assert.equal(receiptOutcomeCopy("executed_divergent").comparedState, "executed_state");
  assert.equal(receiptOutcomeCopy("blocked_divergent").comparedState, "attempted_state");
});

test("unknown outcomes fail visibly instead of inheriting exact-match copy", () => {
  const copy = receiptOutcomeCopy("future_outcome");
  assert.equal(copy.tone, "critical");
  assert.equal(copy.badge, "Review");
});

test("receipt export redaction removes human-only data recursively", () => {
  const receipt = {
    outcome: "executed",
    authorized_state: {
      word_count: 900,
      human_only: { collaborator_note_ref: "sensitive" },
      nested: { human_only: { sharing_confirmation: true }, safe: "kept" },
    },
    history: [
      { human_only: { value: "sensitive" }, safe: true },
      { ordinary_value: "data", authorization_digest: "abc123" },
    ],
  };

  const safe = redactReceipt(receipt);
  assert.equal(safe.authorized_state.nested.safe, "kept");
  assert.equal(safe.history[0].safe, true);
  assert.equal(safe.history[1].ordinary_value, "data");
  assert.equal(safe.history[1].authorization_digest, "abc123");
  assert.equal(JSON.stringify(safe).includes("human_only"), false);
  assert.equal(JSON.stringify(safe).includes('"sensitive"'), false);
});
