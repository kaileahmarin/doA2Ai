# doA2Ai product charter

**Human-authorized execution for WebMCP**

## Target product sentence

doA2Ai lets an agent act only to the precise boundary of the authority it actually possesses. For each exact proposed action, the applicable authority mode determines whether sufficient authority must be granted for that transaction or may come from a precise prior delegation. When authority is missing or uncertain, the trusted review profile determines whether doA2Ai creates a focused docket or terminates the agent-mediated attempt safely. The integrated target service enforces execution eligibility, performs the real action, and returns evidence used to verify and receipt the result.

The interactive static reference client implements only the transaction-authorized path. It has no authentication, backend, or external target service. It models the authority, execution, verification, and receipt boundaries in browser memory and must not be presented as proof that an outside service performed an action.

The repository also contains a standalone, site-owned, in-memory delegated-authority comparison proof. It is not imported by the reference client and does not implement grant issuance, identity or audience binding, durable or cross-instance consumption, revocation, target execution, verification, or receipts. An `eligible` comparison is not an execution credential.

## Who it is for

People who want an agent to remove administrative work without inheriting their identity, credentials, judgement, or legal authority.

## Browser surface

The optional local product GUI is a thin browser-extension control for the current page. It shows page identity and the WebMCP capabilities currently exposed by that page. It does not create a separate task dashboard, approval inbox, or duplicate form surface.

The website owns its visible business semantics, protected inputs, focused review, human decisions, and result presentation. When human authority is required, the person acts at the exact place on the website. The extension may indicate current-page status, but it does not reproduce or substitute for that interaction.

After local unpacked installation, the extension action is intended to be invocable on ordinary HTTP and HTTPS websites. Availability does not manufacture capability: a compatible browser can list tools only when the page exposes them, pages without WebMCP tools expose none, and browser-restricted URLs remain inaccessible. The initial extension uses temporary `activeTab` access and does not request persistent all-site page access. Installed runtime behavior remains **NOT PROVEN** until browser acceptance is performed.

## Domain boundary

doA2Ai is domain-agnostic. It does not define research workflows, source-selection rules, publication rules, collaborator records, or another application's business semantics. Those belong to the integrating application and target service. doA2Ai's product concern is whether the exact proposed action has sufficient authority, whether a focused human handoff is required, and whether execution evidence matches the authorized or delegated state.

The fictional source-backed research brief is only the current synthetic demo fixture. Its fields, rules, tool names, and user interface are not part of the doA2Ai product model or intended public contract.

## Authority modes

### Transaction-authorized mode

The agent may prepare a task and bring it to an executable state, but the person must authorize the final consequential transaction. Successful preparation does not grant the agent any human-only capability or final authority.

**delegated task → bounded capabilities → agent preparation → human-only inputs → exact human authorization → target-service execution → verification → receipt**

The current synthetic reference client implements this mode.

### Delegated-authority mode

The person has previously granted a sufficiently precise execution envelope. An exact proposed action that remains entirely within that grant may proceed without another interruption when the trusted review profile permits it. If any bound term changes or exceeds the grant—including amount, recipient, object, permission, timing, account, operation, or constraint—the proposal is not executable under that grant.

**delegated authority → bounded task → minimal capabilities → exact grant validation → eligible target-service execution → verification → receipt**

On a boundary crossing, `ask_on_exception` may create a focused docket; `autonomous_within_bounds` terminates that attempt without interrupting the person. Transaction-authorized, `always_ask`, and user-presence-required actions use the applicable human ceremony, while `never` remains non-executable. These profiles refine review behavior; they do not create a third authority mode.

**delegated authority → boundary exceeded or uncertain → trusted profile decision → focused docket or terminal nonexecution**

Delegated-authority execution is part of the target product model; it is not implemented by the current prototype. The standalone comparison proof validates a closed proposed-action envelope against one in-memory prior grant and returns semantic differences when the action is outside or uncertain. Its local docket result demonstrates one comparison policy, not the complete profile-sensitive product rule, and the proof must not be described as an end-to-end delegated-authority path.

## Core authority rule

> doA2Ai determines whether sufficient authority exists for the exact proposed action. The authority mode for that action determines whether the required authority is transaction-specific or may have been delegated previously.

Being inside a previously granted scope is not universally sufficient for autonomous execution. The required authority depends on the action and its configured mode. Human-only capabilities never become agent capabilities merely because preparation succeeded.

## Docket model

The docket is the compact exception packet used only when the trusted profile permits or requires a human authority decision: what the agent wants to do, why existing authority is insufficient, what changed, and what decision is needed. It should emphasize the relevant semantic difference rather than present a generic approval prompt.

For example, when a prior grant contains a numeric maximum and the exact proposal exceeds it, the docket should identify the bound, the proposed value, and the precise excess, then ask the person to modify, authorize the exception, or deny it. The integrating application supplies the meaning of those fields; doA2Ai supplies the authority comparison and focused handoff.

## Promise

Target product model: agents act within the exact authority they possess. When a new human authority decision is permitted or required by the trusted profile, doA2Ai creates a focused handoff; otherwise the attempt fails closed without manufacturing routine review. The integrated target service executes only after the authorization boundary is satisfied, and the resulting action is verified and receipted. The interactive prototype only simulates the transaction-authorized division of responsibility in browser memory; the standalone delegated-authority module stops at comparison and same-instance consumption.

## Seven verified transaction-authorized browser invariants

1. Only one task and one scoped execution lease may be active.
2. The agent sees no more than the tools useful in the current task state.
3. Human-only inputs never appear in an agent tool schema or result.
4. There is no agent-callable authorization or execution tool.
5. A transaction-specific grant is exact-state, origin-bound, expiring, single-use, and digest-bound.
6. Execution without a valid grant fails; a divergent preflight is blocked, and a divergent committed result is recorded truthfully and treated as failure.
7. Every terminal outcome produces a human-readable, machine-exportable record.

## Responsibility model

- The agent prepares within the capabilities exposed for the current task.
- doA2Ai evaluates the exact proposed action against the applicable authority, creates a docket when new authority is required, binds and consumes grants, and verifies execution evidence.
- The human supplies protected inputs and grants transaction-specific or exceptional authority where required.
- The integrated target service enforces the authorization boundary and performs the real-world action.
- The receipt layer records requested, prepared, authorized or delegated, executed, and verified states.

The current prototype collapses these responsibilities into one browser-resident simulator. It does not establish a production topology, authentication boundary, or target-service integration. doA2Ai is not assumed to be a universal transaction proxy.

For a future integration, authority profiles and grant lifecycle, sensitive-data mediation, capability scoping and provenance, target commit and reconciliation, and independent acceptance remain separate responsibilities. The production identity, transport, cross-boundary atomicity mechanism, persistence, credential custody, and deployment topology remain **UNKNOWN**.

A future target-service adapter must preserve exact action binding, a single authority lifecycle, non-committing preflight, at-most-once commit semantics, read-only reconciliation, target-observed evidence, and truthful unknown or divergent outcomes. This snapshot deliberately does not choose a final execution-adapter API, network transport, identity, persistence, authentication, signing, or deployment topology.

## Challenge scope

The browser prototype remains a synthetic reference client for the WebMCP challenge. The primary challenge slice should preserve and verify its transaction-authorized path: dynamic task-scoped tools, agent preparation, human-only operations, exact authorization, divergence handling, execution comparison, and receipts. Its fixture-specific business semantics are not a product-domain commitment.

The standalone delegated-authority comparison proof may inform a future path, but it is deliberately absent from the canonical transaction-authorized UI and execution flow. End-to-end delegated execution or a second synthetic integration may be added only after the primary experience is stable, verified, and backed by explicit identity, persistence, adapter, and receipt contracts. Neither is claimed by the current implementation.

## Non-goals for the synthetic reference client

- Real collaboration, publication, identity, or OAuth integration
- Credential collection or storage
- A universal authorization language
- Agent identity or multi-agent orchestration
- Server-signed or externally verifiable receipts
- Generic cross-site DOM automation or an extension-owned duplicate decision flow
- A universal transaction proxy

The prototype uses deterministic mock data and a SHA-256 integrity digest. The digest demonstrates exact-state binding; it is not a claim of third-party attestation.

## Production questions intentionally UNKNOWN

The challenge prototype does not settle:

- final authority-service, SDK, or target-integration topology behind the optional browser extension;
- identity model;
- durable persistence;
- production OAuth or authentication;
- cross-application trust;
- execution-adapter contract;
- server signing or independently verifiable receipts;
- universal authorization language;
- multi-agent orchestration; or
- jurisdiction- and class-specific legal clearance for the selected public identity.

This public snapshot uses **doA2Ai** as its product identity. That use is not a claim of trademark registration, legal clearance, ownership, priority, or future availability. Every production question above remains unresolved unless later evidence and an explicit decision establish an answer.
