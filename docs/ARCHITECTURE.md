# doA2Ai architecture

**Human-authorized execution for WebMCP**

## System at a glance

This project is a static, client-side simulator with an optional WebMCP adapter. It uses a fictional source-backed research-brief fixture to demonstrate the transaction-authorized authority mode and separates these conceptual responsibilities:

| Responsibility | Prototype owner |
| --- | --- |
| Express the task and its constraint | Human instruction captured by the site |
| Read, compare, and prepare | State-scoped agent tools |
| Review, modify, attest, authorize, or deny | Human-only site UI |
| Evaluate authority and bind a grant | Site-owned domain engine |
| Preflight, commit, and return committed state | Injected executor simulated in the same page |
| Verify and issue a receipt | Site-owned domain engine |

There is no backend in this repository. The browser holds the entire state machine in memory, and the local Node server only serves static files with response headers.

The current simulator combines responsibilities that must remain distinct in the target model. It does not establish a production network topology or prove an external execution boundary.

## Optional local extension surface

[`../extension/`](../extension/) is a separate Manifest V3 local-prototype surface for the current page, not another application dashboard.

When a person invokes the extension action on an ordinary HTTP or HTTPS page, its source uses temporary `activeTab` access and `chrome.scripting.executeScript()` in the page's main world to feature-detect `document.modelContext.getTools()`. When that listing API is present, it renders only bounded page identity and tool metadata. It does not call `executeTool()`, inject persistent content scripts, request host permissions, store browsing history, or copy page forms and decisions into the extension.

The website remains the human interface and tool owner. It supplies business meaning, protected inputs, exact review, authorization or denial, and visible results. The extension only reflects the current tool surface. A website without WebMCP tools remains unavailable for agent capabilities; extension presence is not permission to infer actions from arbitrary DOM content.

The extension source is a local browser-client candidate, not the durable authority or execution service. Its installation, runtime behavior, and browser interoperability remain **NOT PROVEN** pending runtime acceptance. Identity, grant persistence, target-side enforcement, evidence verification, and distribution remain separate `UNKNOWN` production boundaries.

## Authority model

doA2Ai supports two conceptual authority modes. The mode applicable to an action determines what counts as sufficient authority for its exact proposed state.

### Transaction-authorized mode

The agent may prepare the task, but the person must authorize the final consequential transaction. Preparation cannot supply protected human inputs or become final authority.

**delegated task → bounded capabilities → agent preparation → human-only inputs → exact human authorization → target-service execution → verification → receipt**

This is the only authority mode implemented by the current synthetic research-brief fixture. Every prepared brief share enters `awaiting_human`; the person must authorize or deny it before simulated execution.

### Delegated-authority mode

The person has previously granted a sufficiently precise execution envelope. An exact proposed action that remains entirely within that grant may proceed without another interruption when the trusted review profile permits it. A changed, exceeded, stale, or uncertain bound is not executable under that grant.

**delegated authority → bounded task → minimal capabilities → exact grant validation → eligible target-service execution → verification → receipt**

On a boundary crossing, `ask_on_exception` may create a focused docket, while `autonomous_within_bounds` terminates the attempt without interrupting the person. Transaction-authorized, `always_ask`, and user-presence-required actions use their human ceremony; `never` remains non-executable. These profiles refine review behavior without adding a third authority mode.

**delegated authority → boundary exceeded or uncertain → trusted profile decision → focused docket or terminal nonexecution**

This mode is part of the target product model and is not implemented end to end. The repository contains a standalone in-memory comparison proof, but it is not imported by the browser client and does not perform target execution, verification, or receipt production. Within the synthetic fixture, the named source set and citation-style requirement limit what the agent may prepare; they are not a prior execution grant or a general doA2Ai rule.

### Authority decision rule

doA2Ai determines whether sufficient authority exists for the exact proposed action. Being inside a prior scope is not universally sufficient for autonomous execution: the action's configured authority mode determines whether authority must be transaction-specific or may have been delegated previously.

Human-only capability is never inferred from successful agent preparation. Missing or uncertain authority never routes directly to execution; it creates a docket only when the trusted profile permits or requires a human decision, otherwise the attempt fails closed.

### Docket semantics

A docket is a compact exception packet containing the proposed action, the authority that already exists, the relevant semantic difference or uncertainty, and the decision required from the person. It should emphasize that difference rather than display a generic approval prompt.

For example, if a prior grant contains a numeric maximum and the exact proposal exceeds it, the docket should identify the bound, proposed value, and precise excess and offer modification, exceptional authorization, or denial. The integrating application defines the meaning of those fields; doA2Ai governs the authority comparison and handoff.

## Target responsibility and execution boundary

- **Agent:** prepares within the capabilities exposed for the current task.
- **doA2Ai:** evaluates the exact action against the applicable authority, creates a docket when new authority is required, binds and consumes grants, and verifies execution evidence.
- **Human:** supplies protected inputs and grants transaction-specific or exceptional authority where required.
- **Target service:** enforces the authorization boundary and performs the real-world transaction.
- **Receipt layer:** records requested, prepared, authorized or delegated, executed, and verified states.

doA2Ai governs authority and execution eligibility; it is not assumed to be a universal transaction proxy. A legitimate protected operation must not be able to bypass the integrated enforcement path, but the production identity, transport, adapter, persistence, and trust design are intentionally unresolved.

## Demo fixture boundary

The fictional brief, source set, citation-style requirement, length and audience choices, collaborator-note reference, `ResearchBriefEngine` name, research-brief tools, and corresponding interface copy belong only to the current synthetic neutral host-page fixture. They are not part of doA2Ai's target product domain or a proposed cross-application contract.

The domain-agnostic product concepts are the exact proposed action, applicable authority mode, available authority, focused docket, bound or consumed grant, target-service execution evidence, verification result, and receipt. How integrating applications represent those concepts in a reusable production contract remains intentionally UNKNOWN.

## Components

### Synthetic research-brief fixture and handoff surface

[`../app/index.html`](../app/index.html) and [`../app/styles.css`](../app/styles.css) present one fictional source-backed research brief. The page distinguishes site records, agent-prepared values, human-editable values, and human-only inputs. A modal handoff pauses the preparation flow and makes the exact proposal reviewable before authorization.

### Optional current-page extension prototype

[`../extension/manifest.json`](../extension/manifest.json) requests only `activeTab` and `scripting`; it declares no host permissions or content scripts. [`../extension/popup.js`](../extension/popup.js) performs read-only current-page capability discovery and renders page-supplied metadata with text nodes. [`../extension/view-model.js`](../extension/view-model.js) keeps only current-tab display metadata and normalized tool metadata; it does not retain page URLs, content, protected inputs, decisions, or credentials.

The popup exposes one refresh control. It has no forms and cannot authorize, deny, execute, or reproduce the site's human decision. [`LAUNCHABLE_GUI_UI_TRACK.md`](LAUNCHABLE_GUI_UI_TRACK.md) records this optional local direction and its explicit browser/runtime unknowns.

### UI controller

[`../app/app.js`](../app/app.js) owns rendering and demo choreography. It:

1. creates one `ResearchBriefEngine`, `BoundedToolRegistry`, and `WebMcpBridge`;
2. derives tool definitions from the current engine state;
3. keeps the simulator registry and conditional WebMCP registrations synchronized;
4. drives the illustrative agent preparation through the registry;
5. routes human review inputs directly to site-owned engine methods; and
6. renders or exports the terminal receipt.

The preview button is not an autonomous agent. It is a deterministic walkthrough that invokes the same callbacks exposed as tools, in the expected sequence, so the boundary remains demonstrable without a WebMCP-capable agent.

### Domain engine

[`../app/domain.js`](../app/domain.js) is the source of truth for the simulation. `ResearchBriefEngine` keeps the active task, lease, research packet, brief draft, prepared state, human draft, authority state, receipt, and event log together. Public snapshots are structured clones, preventing callers from mutating internal state through returned object references.

The engine owns:

- ordered preparation checks;
- source-scope and citation-style binding;
- lease validation and revocation;
- human draft validation;
- canonical serialization and SHA-256 digest creation;
- exact-state authorization data;
- bounded two-phase preflight, commit, and committed-state comparison; and
- redacted, terminal receipts.

### Bounded registry and WebMCP bridge

[`../app/webmcp.js`](../app/webmcp.js) separates local determinism from browser capability:

- `BoundedToolRegistry` stores only current definitions, rejects missing tool names with `TOOL_NOT_EXPOSED`, and aborts cooperative in-flight calls when a tool is removed.
- `WebMcpBridge` uses `globalThis.document?.modelContext` when present. It considers the API supported only when `registerTool` exists.
- `sync()` increments a generation, aborts every prior controller, and registers the current definitions with a fresh `AbortController` per tool via `registerTool(definition, { signal })`.
- A concurrent or failed synchronization cannot leave the bridge’s own old controllers active: registrations are aborted and the failure is reported to the UI.
- `dispose()` aborts registrations when the page is being left.

The current imperative WebMCP API uses `AbortSignal` to control a registration’s lifetime. User agents expose registration changes through the WebMCP `toolchange` mechanism. The demo also maintains its own visible registry because the page must remain understandable and testable when `document.modelContext` is absent. Mock-based lifecycle tests do not establish behavior in every browser version; the target Chrome 149–152 in-flight unregister case remains a separate compatibility gate.

The tool definitions use JSON Schema with `additionalProperties: false`, focused descriptions, and the current `readOnlyHint` and `untrustedContentHint` annotations. `read_task_status` intentionally takes no handles and returns the active task and lease handles; state-changing operations require both exact handles. `read_receipt` accepts those handles after lease revocation because it is a terminal read, not lease-authorized preparation. No definition can grant authorization or call execution.

Public API references:

- [WebMCP imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api)
- [Secure WebMCP tools](https://developer.chrome.com/docs/ai/webmcp/secure-tools)
- [WebMCP best practices](https://developer.chrome.com/docs/ai/webmcp/best-practices)
- [WebMCP draft specification](https://webmachinelearning.github.io/webmcp/)

## Current transaction-authorized state and capability flow

The task and authority machines are related but distinct.

This table describes the implemented transaction-authorized research-brief path. It does not claim a delegated-authority execution path.

| Task state / step | Agent-visible tools | Site or human action |
| --- | --- | --- |
| `preparing / sources` | `read_research_sources`, `read_task_status` | Agent reads the scoped source set and citation requirement |
| `preparing / draft` | `compose_research_brief`, `read_task_status` | Agent composes the brief with the exact required citation style |
| `preparing / prepare` | `prepare_brief_share`, `read_task_status` | Agent creates the reviewable brief-share proposal |
| `awaiting_human / handoff` | `read_task_status` only | Human reviews, modifies, authorizes, or denies |
| `authorized`, `executing`, `verifying` | none | Site validates and compares the candidate |
| `completed`, `blocked`, `cancelled`, or `failed` | `read_receipt` | Agent may read the redacted terminal outcome after lease revocation |

The authority states progress independently through `none`, `proposed` or `modified`, and then a terminal route such as `granted → consumed`, `denied`, `expired`, or `divergent`.

Tool minimization is dynamic, not merely descriptive. After each engine event, `app.js` regenerates definitions, replaces the local registry, aborts old WebMCP registrations, and registers the new set. A stale tool name is therefore rejected by the simulator even if a caller retained it.

## Current transaction authorization record

When the person authorizes the prototype's specific transaction, the engine builds a grant containing:

- grant, task, and operation identifiers;
- the runtime site origin;
- the agent-prepared payload;
- explicit human modifications;
- the exact authorized payload, including the protected sharing confirmation and collaborator-note reference;
- authorization and expiry timestamps;
- a single-use flag and nonce; and
- a SHA-256 digest of a canonical serialization of the authorized payload.

The preparation lease is revoked at authorization. Before simulated execution, the engine checks the grant’s origin, task, lease, operation, expiry, single-use state, and recalculated digest. It rechecks expiry and current identity after awaited digest work, projects an explicit allowlist of executable fields that excludes `human_only`, then atomically consumes the in-memory grant for one execution attempt.

This is a model of exact authorization, not a secure token implementation: the grant is an ordinary in-memory JavaScript object and is neither server-issued nor signed.

### Standalone delegated-authority comparison proof

[`../app/delegated-authority.js`](../app/delegated-authority.js) models one site-owned comparison-and-consumption path independently of the research-brief fixture. It accepts only closed JSON claim, action, grant, scope, term, and rule envelopes; requires exact valid UTC instants; compares `exact` and numeric `at_most` rules; and returns a semantic-difference docket for changed, exceeded, uncertain, stale, replayed, ambiguous, or invalid authority. A successful comparison returns a detached snapshot of the exact checked action.

The module is not registered as a WebMCP tool and its decisions may contain authority values, so they must remain inside a trusted site-owned boundary. An `eligible` result is not a transferable execution credential. Consumption is single-use only within one gate instance; two instances initialized from the same grant can each consume their own copy. The proof defines neither domain units nor business validity for a term.

Grant issuance, principal, tenant, origin, issuer, audience, target-service binding, authenticated docket access, persistence, cross-process atomicity, revocation propagation, retries, target execution, verification, and receipts remain unimplemented and intentionally UNKNOWN.

## Exact-state comparison and receipts

`compareStates()` recursively compares canonical object values and reports field paths with the authorized and candidate values, including the distinction between a missing property and an explicit `null`. The site executor receives only the allowlisted executable projection; protected confirmation data remains in the internal grant and digest. The executor contract has two explicit phases sharing one deadline and `AbortSignal`: `preflight()` proposes the candidate, and `commit()` returns the committed readback. A divergent preflight is blocked without calling commit. The committed readback is compared again; if it diverges, the receipt records `executed_divergent` rather than pretending that nothing ran.

The optional divergence control changes both the word count and draft version after authorization. That produces `blocked_divergent`, an attempted state, a field-level difference list, and no executed state. The UI tells the person a new authorization is required; this prototype stops at the blocked receipt rather than implementing a full reauthorization loop.

Every modelled terminal decision has a receipt:

- `executed`: requested, prepared, authorized, and executed states match as required;
- `blocked_divergent`: the preflight candidate differs, commit is not called, and execution is not recorded;
- `executed_divergent`: commit occurred but its readback differs, so the executed truth and mismatch are both preserved;
- `blocked_expired` or `blocked_brief_expired`: execution stops before grant consumption;
- `execution_failed`: the consumed attempt timed out or did not return a verifiable result, so the outcome is explicitly unknown; or
- `denied`: the human decision is recorded and no execution is attempted.

Agent-visible and exported receipts project only the allowlisted executable fields. Unexpected readback fields remain visible as a constant redacted marker plus presence evidence rather than exporting their names or values. The JSON receipt is evidence produced by this simulation, not an external or cryptographically signed attestation.

## Trust boundaries

### Human-only boundary

The sharing confirmation and collaborator-note reference are accepted only by the site-owned `grantAuthorization()` call from the review UI. They are absent from all agent tool schemas, executor inputs, and public receipt payloads.

This is a code-path boundary inside one page, not a process or privilege boundary. Malicious same-origin JavaScript, browser compromise, or devtools access is outside the prototype’s protection model.

### Agent boundary

An agent may invoke only currently registered tools, and each domain operation also checks task step, handles, and lease state. The simulator’s preview has no general DOM control and no path to authorization or execution.

WebMCP security still depends on the browser, the calling agent, tool descriptions and schemas, page integrity, origin policy, and the surrounding authenticated service. This prototype does not authenticate either a person or an agent.

### Authority and target-service boundary

Authority evaluation, target execution, verification, and receipt creation are represented together by the client-side engine. In the target model, doA2Ai governs authority and execution eligibility, while the integrated target service enforces that decision and performs the real operation. The target must return sufficient committed-state evidence for verification; the protected operation must not legitimately bypass the integrated authorization boundary.

How doA2Ai and the target authenticate one another, transport or validate grants, coordinate idempotency, persist state, recover from partial failure, and protect secrets or logs is intentionally unresolved. None of those production controls are implemented here, and this architecture does not choose a universal proxy model.

For a future integrated target, one execution lineage, exact action binding, one exclusively bound authority lifecycle, non-committing preflight, at-most-once commit semantics, read-only reconciliation, target-observed evidence, and truthful unknown or divergent outcomes are design constraints. They are not a selected wire API or implementation claim. The final adapter, transport, identity, storage, authentication, signing, and deployment choices remain UNKNOWN.

Authority profiles and exact claims, protected-data mediation, capability discovery and provenance, target commit and reconciliation, and independent acceptance must remain distinct responsibilities in a future integration. Connection authorization remains a cross-layer prerequisite, not action authority. The atomic coupling among those responsibilities is not implemented or proven in this prototype.

Any future network sandbox must keep the logical authority layer distinct from a site-owned protected execution adapter before an external target. A trial must not introduce a second executor or routine human review, and it cannot by itself establish adapter conformance, atomic authority-to-effect coupling, execution-ID reconciliation, provider behavior, or production deployment. No external implementation or network proof currently exists.

### Server and origin headers

[`../scripts/serve.mjs`](../scripts/serve.mjs) serves only `GET` and `HEAD`, rejects paths outside `app/`, disables caching, and sends a restrictive content security policy plus `Permissions-Policy: tools=(self)`, same-origin opener isolation, MIME sniffing protection, a no-referrer policy, and frame restrictions.

These headers reduce accidental exposure in the local demo. They do not turn the static server into an authentication, authorization, transaction, or receipt-signing service.

## Failure behavior

- A missing or expired lease, mismatched task/lease/draft handle, wrong source-scope constraint, or invalid step fails closed with a coded error.
- An absent WebMCP API leaves the page in simulator mode.
- A WebMCP registration error aborts bridge registrations, reports **Registration error**, and leaves the deterministic preview available.
- Expired authorization blocks before consumption.
- A digest mismatch throws before the execution attempt.
- The single-use attempt is consumed before preflight. If preflight produces a divergent candidate, the engine records the attempted differences and blocks before commit.
- A divergent commit readback is recorded as executed divergence and requires reconciliation.
- Executor work shares a bounded deadline and cooperative abort signal; timeout or failure produces an `execution_failed` receipt instead of leaving the task nonterminal.
- Denial revokes the lease and produces a `not_executed` receipt.

The UI currently provides a polished transaction-authorized path for matched, denied, and divergent outcomes. It does not provide delegated-authority execution, persistence, recovery after reload, a retry protocol, a reauthorization loop, or operator tooling.

## Challenge scope

The existing browser prototype remains a synthetic reference client. The primary challenge slice is the current transaction-authorized experience: real WebMCP capability discovery, dynamic task-scoped tool exposure, a clear agent-preparable versus human-only boundary, exact authorization, simulated target execution, committed-state verification, receipts, and deliberate stale or divergent failure. The research-brief data is a fixture for that proof, not the product domain.

The standalone delegated-authority comparison proof is deliberately not wired into the challenge UI. End-to-end delegated execution may be considered only after the canonical transaction-authorized experience is stable and verified and the unresolved identity, persistence, adapter, docket-access, and receipt contracts are explicitly decided. A second synthetic integration is useful only after that point. Neither delegated execution nor a second integration is claimed today.

## Verification

Run the project checks from the repository root:

```powershell
npm.cmd test
npm.cmd run check
```

The static check verifies key files plus local asset and module references. Protected-name scanning is kept outside this potentially public tree; only a redacted result is retained. The Node test command exercises any repository tests discovered by the built-in test runner.

Manual demo acceptance should cover exact match, denial, blocked divergence, receipt export, keyboard access to the handoff, responsive layout, and both WebMCP-supported and simulator-only browser conditions. Exceptional receipt copy is separately tested for expiry, execution failure, and post-commit divergence. A successful local demo is not evidence of production security or cross-process atomicity.

## Production questions intentionally UNKNOWN

The challenge prototype does not settle:

- final hosted-service versus SDK topology;
- identity model;
- durable persistence;
- production OAuth or authentication;
- cross-application trust;
- execution-adapter contract;
- server signing or independently verifiable receipts;
- universal authorization language;
- multi-agent orchestration; or
- jurisdiction- and class-specific legal clearance for the selected public identity.

This public snapshot uses **doA2Ai** as its product identity. That use is not a claim of trademark registration, legal clearance, ownership, priority, or future availability. Every other question above remains unresolved unless later evidence and an explicit decision establish an answer.

## Clean-room boundary

This architecture was developed from the project requirements and the public WebMCP sources linked above. The implementation, interface, copy, schemas, and examples in this repository are original to this project. No source code, schemas, assets, prompts, internal documentation, runtime artifacts, or proprietary implementation detail from an earlier private system belongs in this repository.

See [`../PROJECT_PROVENANCE.md`](../PROJECT_PROVENANCE.md) for the contribution rule.
