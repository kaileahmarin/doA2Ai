# T1 offline runtime contract

**Status:** LOCAL SYNTHETIC IMPLEMENTATION CANDIDATE — external isolation and provider behavior not proven

**Owner direction:** `PD-DIR-20260829-01`

**Implementation base:** `b1d2eea` (`docs: record Phase A owner directions`)

## Purpose and authority boundary

This contract defines the repository-local implementation allowed by the recorded T1 design direction. It creates a fixed-function, foreground-oriented Node runtime and deterministic synthetic target. It does not create or configure the dedicated Windows account proposed for the eventual trial, access a secret store, hold a credential, call Shopify, open an endpoint, deploy a service, or prove Gate 9.

Opaque plan, budget, target, audience, and authority references must match a closed `synthetic-...` form; the action reference must equal the execution-derived `urn:synthetic-t1:execution:<execution_id>` value. The runtime rejects a live provider mode, a real-looking or malformed reference, an unknown contract field, an unapproved query-cost shape, or a request outside the three-document manifest before its private synthetic dispatcher can run.

## Implemented surface

| Component | Implemented responsibility | Explicit limit |
| --- | --- | --- |
| [`runtime/t1/request-manifest.js`](../runtime/t1/request-manifest.js) | Three deeply frozen GraphQL request documents and stable document/manifest digests. | Shape review only; no live schema or provider validation. |
| [`runtime/t1/session.js`](../runtime/t1/session.js) | Closed synthetic plan, factory-private in-memory target and dispatcher, before-state preparation, separate session/operator facets, exact declared transaction-authority binding, single commit-capable dispatch, verification read, terminal receipt, and zero retry. | Same-process and non-durable; facet separation is not a Windows or identity boundary. |
| [`runtime/t1/synthetic-target.js`](../runtime/t1/synthetic-target.js) | Builds one deeply frozen, data-only synthetic fixture: initial quantities, three artificial cost values, and a closed evidence profile. | Exposes no callable request, mutation, network, or transport capability; it is not a Shopify adapter or protected target. |
| [`scripts/run-t1-synthetic.mjs`](../scripts/run-t1-synthetic.mjs) | Interactive foreground synthetic walkthrough with exact-phrase authorization. | TTY and typed confirmation do not prove a human identity or authorized operator. |
| [`tests/t1-runtime.test.js`](../tests/t1-runtime.test.js) | Deterministic acceptance cases for manifest closure, budgets, single flight, one lineage, redaction, isolation seam, truthful ambiguity, and closed schemas. | Local evidence only. |

The browser demo and its WebMCP registry do not import this runtime. The broader Gate 7–8 harness remains test-only and is not promoted into P1 because it intentionally exposes retry, reconciliation, webhook, fault, and competing-writer test surfaces that P1 sets to zero.

## Exact request manifest

The manifest order is immutable:

1. `before_read` — read one inventory level's `available` and `on_hand` quantities plus the bound item and location identifiers;
2. `commit` — one `inventoryAdjustQuantities` mutation with one `available` change, `changeFromQuantity`, fixed `correction` reason, execution-bound reference, and the stable `execution_id` as the idempotency key; and
3. `verification_read` — repeat the exact closed quantity observation after a successful synthetic commit response.

The documents follow Shopify's current [`inventoryLevel`](https://shopify.dev/docs/api/admin-graphql/latest/queries/inventoryLevel), [`inventoryAdjustQuantities`](https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryAdjustQuantities), and [idempotency](https://shopify.dev/docs/api/usage/implementing-idempotency) documentation. That source review does not establish that these documents were accepted by API `2026-07`, that a credential has the required scopes, or that Shopify would produce the modeled evidence.

No caller can submit raw GraphQL, add a fourth document, alter a document after import, select a second operation, inject a request callback, or obtain the factory-private dispatcher or an alternate commit method. The exported target fixture is deeply frozen data only. Deterministic conflict/missing/malformed evidence profiles exist solely to test local outcome truthfulness; they do not authorize P1 fault injection or expand its external call budget.

## Session lifecycle

```text
closed synthetic plan + synthetic cost/data fixture
                              |
                              v
                    prepare() / before_read
                              |
                              v
              protected synthetic operator projection
                              |
                              v
        operator facet records exact declared authority
                              |
                              v
                runAuthorized() / one commit path
                              |
                              v
                     verification_read
                              |
                              v
          committed_exact | committed_divergent | unknown
                              |
                              v
                    allowlisted receipt
```

The transaction-authority record binds the pre-created `execution_id`, plan, manifest, budget, complete data fixture, evidence profile, and time-source/timeline digest, synthetic authority reference, declared foreground operator mode, authorization time, and expiry. Authorization cannot predate the successfully prepared before-state projection. The operator method is not present on the session facet. Preparation time, authority-record digest, fixture digest/profile/time mode, validity interval, lifecycle state, current validity disposition, and consumption counters enter the allowlisted terminal receipt; the raw authority reference does not. A process-realm registry shared through `globalThis` rejects a second runtime claiming the same `execution_id`, including a second query-qualified ESM instance in that realm. This registry is not a protected or durable store, and the receipt labels replay exclusion `unprotected_process_realm_only`. The runtime rejects expired plans before a request, enforces the P1 maximum 30-minute active plan and authority intervals, rechecks expiry before dispatch, and quarantines a commit whose response or verification crosses the active window. Authority is consumed no later than the sole commit-capable dispatch. A second or simultaneous effecting attempt is rejected; ambiguity never mints a replacement identifier. Worker/VM realm, cross-process, durable, and restart-safe exclusion remain unimplemented.

`human_foreground_declared` is input metadata, not proof that a person was present. Code holding the same-process operator facet can make the declaration, so the receipt always reports `human_operation: not_verified` and `agent_mediation: not_tested`. Only the later dedicated-account design could place that facet behind a meaningful human-controlled process boundary.

## Query-cost boundary

The repository does not select the external P1 query-cost budget. Shopify documents calculated query cost, per-request requested/actual cost evidence, and the fact that running a request is the best way to learn its true cost. See [Shopify API limits](https://shopify.dev/docs/api/usage/limits).

The runtime therefore accepts only a `synthetic_fixture_only` budget. Tests and the synthetic CLI use artificial values to exercise fail-closed arithmetic; those numbers are not provider measurements or owner-approved external ceilings. Missing, incomplete, or internally inconsistent cost data fails before any synthetic request. A before-read response above its synthetic bound prevents the commit. Cost or evidence trouble after commit-capable dispatch produces `unknown` and no retry.

The external P1 query-cost row remains **HOLD** until the exact documents receive a conservative source/schema review, an owner selects their per-document and aggregate ceilings, and the separately authorized setup can record actual provider-returned cost evidence.

## Projection and sentinel rule

The runtime has two deliberately different projections:

- `protected_operator_only_synthetic` contains the exact synthetic target/action, prepared timestamp, data-fixture digest/profile, and any closed synthetic timeline needed for the transaction-authority exercise; and
- `agent_safe_allowlist` contains only execution/binding/manifest/fixture/authority digests, the closed evidence-profile and time-mode names, outcome, lifecycle/validity data, counters, timestamps, cost numbers, event types, and explicit trust limits.

The export is built from an allowlist. It never recursively copies the plan, raw authority record, target context, ledger contents, internal dispatcher state, or arbitrary errors. Synthetic sentinel tests verify that raw authority and target markers do not enter the receipt or failure messages. Response receipt and response validation are recorded separately, so returned-but-invalid commit evidence is not mislabeled as a lost response.

The local isolation field is deliberately limited to `same_process_synthetic_interface_only`: no secret store or protected ledger exists, the alternate commit interface is absent, and Windows ACL isolation remains `not_proven`. The runtime accepts no caller-supplied isolation probe, transport, clock callback, endpoint, credential, or request function. Tests may provide only a closed monotonic data timeline; the CLI uses the runtime clock. This is interface-shape evidence, not host-access proof.

## T1 requirement status

| Requirement | Local implementation evidence | Status beyond this checkout |
| --- | --- | --- |
| A-12 app/adapter/store/fixture binding | Closed synthetic target context, document digests, and fail-before-dispatch comparisons. | Actual app, adapter instance, store, and fixture **UNKNOWN**. |
| A-13 issuer/audience/freshness/replay | Synthetic issuer/adapter/verifier references, separate same-process operator facet, post-preparation authority rule, process-realm duplicate-ID rejection across ESM instances, exact binding and authority-record digests, explicit lifecycle/validity receipt fields, enforced 30-minute maximum interval, expiry, single use, and no retry. | Human identity, authenticated source, trust root, revocation, secure facet placement, worker/VM/cross-process/durable replay defense, and restart recovery **UNKNOWN**. |
| A-15 credential custody | No credential API, environment read, token header, or secret field exists in this implementation. | Windows secret-store mechanism, human placement, rotation, revocation, and scrub proof **UNKNOWN**. |
| A-16 physical topology | Separate Node-only runtime outside the browser app; no endpoint, server, IPC, raw GraphQL, or alternate mutation method. | Dedicated Windows account, ACL denial, protected process placement, outbound firewall, DNS/TLS, and exact-host enforcement **UNKNOWN / NOT PROVEN**. |
| A-17 verifier | Closed synthetic response comparison, bound data-fixture/evidence-profile/time-mode provenance, version/cost checks, exact/divergent/unknown outcomes, and allowlisted receipt. | Provider-response authenticity, store/account authentication, protected ledger, retention, signing, and independent verification **UNKNOWN**. |

T1 remains non-operational. This implementation does not satisfy the owner's packet pre-setup checkpoint and does not change any production `UNKNOWN`.

## Acceptance cases

- **T1-01:** exactly three closed, deeply immutable request documents;
- **T1-02:** query-cost HOLD and mismatch fail before commit capability;
- **T1-03:** one foreground session is single-flight and sequential;
- **T1-04:** one terminal effecting lineage and no rerun;
- **T1-05:** the target fixture is data-only, mutation/dispatch is factory-private, and caller-labelled transports are rejected;
- **T1-06:** the operator facet is separate from the session and its declaration never becomes human, agent-mediation, provider, or Gate 9 proof;
- **T1-07:** allowlisted projections omit sentinels and isolation claims remain limited to the observed same-process interface;
- **T1-08:** divergent, missing-response, and returned-but-malformed evidence paths remain distinct, truthful, and terminal;
- **T1-09:** unknown plan or authority fields fail before effect;
- **T1-10:** every reference-bearing input is closed to its exact synthetic form;
- **T1-11:** expired or overlong plan and authority windows fail closed, authority cannot predate preparation, expiry is explicit, and a post-dispatch window crossing becomes `unknown`;
- **T1-12:** the receipt binds the exact authority-record digest without exporting the raw reference;
- **T1-13:** a second runtime or query-qualified module instance cannot claim the same `execution_id` in the current Node realm; and
- **T1-14:** the complete synthetic data fixture, evidence profile, and time mode are bound into the protected review and terminal receipt.

Run the full deterministic suite with:

```powershell
npm.cmd run check
```

An interactive synthetic walkthrough is optional:

```powershell
npm.cmd run t1:synthetic
```

The walkthrough never performs a network call. It is not setup evidence, provider evidence, Windows-isolation evidence, or a substitute for the later exact transaction authorization required for an external run.
