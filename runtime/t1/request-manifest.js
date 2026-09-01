import { createHash } from "node:crypto";

const MANIFEST_REVISION = "t1-p1-request-manifest-0.1";
const API_VERSION = "2026-07";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const documents = [
  {
    id: "before_read",
    phase: "before_read",
    operation_name: "T1BeforeInventoryLevel",
    commit_capable: false,
    document: `query T1BeforeInventoryLevel($inventoryLevelId: ID!) {
  inventoryLevel(id: $inventoryLevelId) {
    id
    item {
      id
    }
    location {
      id
    }
    quantities(names: ["available", "on_hand"]) {
      name
      quantity
    }
  }
}`,
  },
  {
    id: "commit",
    phase: "commit",
    operation_name: "T1InventoryAdjust",
    commit_capable: true,
    document: `mutation T1InventoryAdjust(
  $input: InventoryAdjustQuantitiesInput!
  $idempotencyKey: String!
) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
    userErrors {
      field
      message
      code
    }
    inventoryAdjustmentGroup {
      createdAt
      reason
      referenceDocumentUri
      changes {
        name
        delta
      }
    }
  }
}`,
  },
  {
    id: "verification_read",
    phase: "verification_read",
    operation_name: "T1VerifyInventoryLevel",
    commit_capable: false,
    document: `query T1VerifyInventoryLevel($inventoryLevelId: ID!) {
  inventoryLevel(id: $inventoryLevelId) {
    id
    item {
      id
    }
    location {
      id
    }
    quantities(names: ["available", "on_hand"]) {
      name
      quantity
    }
  }
}`,
  },
].map((entry) => ({ ...entry, document_digest: digest(entry.document) }));

const manifestPreimage = {
  manifest_revision: MANIFEST_REVISION,
  api_version: API_VERSION,
  documents,
};

export const T1_REQUEST_MANIFEST = deepFreeze({
  ...manifestPreimage,
  manifest_digest: digest(manifestPreimage),
  query_cost_status: "hold_pending_owner_selected_exact_budget",
  evidence_scope: "official_shape_review_only_not_provider_validation",
});
