import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";

import { createT1OfflineRuntime, T1SessionError } from "../runtime/t1/session.js";
import { createT1SyntheticFixture } from "../runtime/t1/synthetic-target.js";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("T1 synthetic check requires an interactive foreground terminal. This is not proof of a human operator.");
  process.exitCode = 1;
} else {
  const executionId = `synthetic-execution-${randomUUID()}`;
  const startedAt = new Date();
  const deadline = new Date(startedAt.getTime() + 30 * 60 * 1000);
  const plan = {
    contract_revision: "t1-offline-0.1",
    run_mode: "synthetic_offline",
    execution_id: executionId,
    owner_direction_ref: "synthetic-owner-direction-PD-DIR-20260829-01",
    authority_mode: "transaction_authorized",
    target_context: {
      provider: "synthetic-shopify-like-fixture",
      api_version: "2026-07",
      store_ref: "synthetic-store-001",
      inventory_level_id: "synthetic-inventory-level-001",
      inventory_item_id: "synthetic-inventory-item-001",
      location_id: "synthetic-location-001",
    },
    audience: {
      issuer_ref: "synthetic-issuer-001",
      adapter_ref: "synthetic-adapter-001",
      verifier_ref: "synthetic-verifier-001",
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
    deadline: deadline.toISOString(),
  };
  const costBudget = {
    status: "synthetic_fixture_only",
    decision_ref: "synthetic-cost-fixture-001",
    documents: {
      before_read: { static_requested_cost: 5, max_requested_cost: 10 },
      commit: { static_requested_cost: 15, max_requested_cost: 20 },
      verification_read: { static_requested_cost: 5, max_requested_cost: 10 },
    },
    max_total_requested_cost: 40,
  };
  const targetFixture = createT1SyntheticFixture({
    initialInventory: { available: 10, on_hand: 20 },
    requestedCosts: { before_read: 5, commit: 15, verification_read: 5 },
  });
  const { session, operator } = createT1OfflineRuntime({
    plan,
    costBudget,
    targetFixture,
    syntheticNow: null,
  });

  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const review = await session.prepare();
    console.log(JSON.stringify(review, null, 2));
    const phrase = `AUTHORIZE ${executionId}`;
    const answer = await terminal.question(`Type ${phrase} to authorize this synthetic effect: `);
    if (answer.trim() !== phrase) {
      console.log("Synthetic effect not authorized; no commit-capable request was sent.");
    } else {
      const authorizedAt = new Date();
      operator.recordTransactionAuthority({
        authority_ref: `synthetic-authority-${randomUUID()}`,
        execution_id: executionId,
        binding_digest: review.binding_digest,
        operator_mode: "human_foreground_declared",
        authorized_at: authorizedAt.toISOString(),
        expires_at: new Date(Math.min(deadline.getTime(), authorizedAt.getTime() + 10 * 60 * 1000)).toISOString(),
      });
      const receipt = await session.runAuthorized();
      console.log(JSON.stringify(receipt, null, 2));
    }
  } catch (error) {
    const code = error instanceof T1SessionError ? error.code : "SYNTHETIC_T1_FAILURE";
    console.error(`T1 synthetic check stopped: ${code}`);
    process.exitCode = 1;
  } finally {
    terminal.close();
  }
}
