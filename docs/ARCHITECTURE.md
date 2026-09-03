# doA2Ai V1 architecture

## Status and evidence boundary

This document is the target-state architecture for the challenge V1. It distinguishes required behavior from the verified starting point.

**OBSERVED baseline at documentation cut:** commit `d587d2b` implements a Manifest V3 bridge, an HTTPS Worker/D1 broker, MCP transport, exact-action review, browser dispatch, and bound terminal results. It still uses a manual service URL, three operator/browser/MCP credentials, person-selected tool checkboxes, session-specific MCP URLs, and broker-held session policy. Installed Chrome → real target → external agent → human decision remains **NOT PROVEN**.

**Required V1:** the extension becomes the local authority owner, normal setup becomes one-time enablement, capabilities become automatic and action-driven, the Worker becomes bounded transport plus the real product control center, and every protected action receives a device-signed, broker-bound receipt.

Passing source or unit checks does not convert required V1 behavior into observed runtime evidence.

## System at a glance

| Component | Responsibility | Must not become |
| --- | --- | --- |
| External agent | Chooses and invokes relevant protected WebMCP tools | An embedded doA2Ai agent |
| Real WebMCP page | Owns tool definitions, business semantics, and actual effects | A doA2Ai demo or inferred DOM automation target |
| Chrome extension | Owns policy, tasks, exact-action evaluation, decisions, device key, receipts, and browser dispatch | A second website or persistent browser window |
| HTTPS Worker/D1 | Pairs device keys, prevents signed-request replay, serves control-center assets, manages staged connection credentials, and binds terminal digests | The universal policy authority or full receipt archive |
| HTTPS control center | Displays a read-only redacted projection of extension-owned Tasks, Rules, Activity, and Connection Health | An authority mutation surface, required always-open dashboard, or simulated product |
| Staged standalone MCP | Currently provides credential lifecycle only; the V2 MCP consumer and filtered catalog are not implemented | A claimed V1 judging path or vendor-specific agent configuration system |

The browser-integrated path is the implemented V1 path and challenge-video path. A standalone MCP path is future work; credential lifecycle primitives do not establish an endpoint, consumer, or filtered-catalog implementation.

## Authority model

doA2Ai has two authority modes:

1. **Delegated authority:** a previously confirmed structured rule covers the exact action. The action proceeds without another interruption.
2. **Transaction authorization:** the action lacks sufficient authority, is uncertain, or requires presence. A person approves or denies that exact proposal.

The evaluation outcome is `allow`, `ask`, or `block`:

1. global pause or an applicable hard block;
2. revoked or expired authority;
3. exact transaction authorization;
4. confirmed temporary task rule;
5. confirmed universal rule;
6. confirmed starter-policy rule; then
7. no safe match, malformed metadata, or conflicting evidence → `ask`.

`allow` means delegated authority exists. `ask` creates a focused transaction review. `block` terminates without dispatch and records a receipt; it does not create a routine approval notification.

The starter policy allows sufficiently classified low-sensitivity reads, asks for inferred changes plus disclosure/communications/commitments/publishing/purchases/account or irreversible changes, and unconditionally blocks credential/security/destructive actions in V1. Reusable allow is limited to non-sensitive reads or reversible self-directed changes and requires the exact origin, tool-definition digest, canonical arguments digest, and an explicit second confirmation.

Free-form rules are input only. They become authority after compilation into a visible structured rule and explicit confirmation. The extension Rules page also supports pre-agent setup: after re-discovering a currently protected HTTPS page and its catalog, the person can choose one eligible tool and enter exact JSON arguments to create a universal rule. The durable rule binds the exact origin, document-bound tool-definition digest, and canonical arguments digest; it never accepts a typed origin or broad tool grant.

## Task and capability model

Tasks are grouping and authority scopes, not agent plans. A task may include multiple pages, origins, and external-agent connections. Every action still has an independent authority evaluation.

If an external protocol supplies a stable task reference, doA2Ai records it as provenance. Otherwise doA2Ai issues an opaque task ID at the first protected action. Only a doA2Ai-issued, connection-bound task ID may carry temporary authority; agent claims and inferred labels cannot grant.

Task authority ends explicitly or after 30 minutes without a gated action by default. A protected action refreshes activity. The person may choose a shorter interval, revoke a task, or activate global pause.

On a real page, the extension discovers the page's current WebMCP catalog and exposes collision-safe protected registrations. Each protected registration retains the source tool's actual name, description, annotations, origin, and canonicalized schema as provenance. For object schemas, an omitted `additionalProperties` is conservatively normalized to `false` for the protected contract; an explicitly open object remains rejected. doA2Ai never invents capabilities from page text or the DOM and never wraps its own protected tools recursively.

Capability exposure is automatic. Browser mediation mirrors the current page-owned catalog with clearly marked protected registrations, then evaluates every invocation independently. A future standalone MCP path is intended to publish only a task-scoped protected catalog; this candidate does not implement that path.

## Progressive impact metadata

Ordinary WebMCP tools remain usable. Without reliable structured impact metadata, doA2Ai evaluates conservatively and may ask.

A future `TargetImpactManifestV1` contract could provide deterministic evidence for:

- effect category, such as read, retain, disclose, mutate, purchase, publish, or delete;
- data classes and sensitivity;
- recipient or destination;
- financial amount and currency;
- reversibility and commitment; and
- manifest source, version, tool identity, and schema digest.

Standard page annotations and the tool definition are cooperative evidence interpreted by confirmed local policy; they are not themselves a rule or approval. V1 cannot detect a page that lies about its implementation, so starter-policy automation is explicitly limited to cooperative targets. Missing, malformed, stale, or conflicting data yields uncertainty. The stronger structured manifest is not implemented in this candidate and cannot be claimed as present.

## Exact action binding

Every action is bound before evaluation to:

- action ID and doA2Ai task ID;
- device and connection identity;
- source origin, document identity, and page lifecycle;
- catalog revision/digest;
- source tool identity, description, and schema digest;
- exact canonical arguments digest;
- structured impact plus its provenance and confidence; and
- policy revision and evaluation time.

Navigation, origin change, `toolchange`, schema/tool mutation, arguments mutation, impact mutation, policy revision, expiry, revocation, or task mismatch invalidates an outstanding authorization. A decision never grants a whole page merely because one action was approved.

## Primary action flow

1. The extension discovers a real page's current tools and maintains protected registrations.
2. An external agent invokes one protected tool.
3. The extension canonicalizes and binds the action and resolves or creates its doA2Ai task.
4. The authority engine returns `allow`, `ask`, or `block`.
5. `allow` dispatches once. `block` records nonexecution. `ask` assigns a stable pending action ID and returns pending status.
6. A pending-review notification can deep-link to compact review. The actual decision occurs only after the exact context is visible.
7. Approval resumes the same action lineage; the agent does not submit a second side effect.
8. Immediately before dispatch the extension revalidates the live document, catalog, tool, schema, arguments, policy, expiry, and task binding.
9. The page-owned tool runs once. The extension records its result or an honest ambiguous state.
10. A receipt separates requested, authorized, dispatched, tool-reported, independently observed, and reconciled states.

Read-only calls may retry when the retry is semantically safe. State-changing calls are serialized per origin/task. An identical state-changing request within the same task/document/tool/arguments binding converges on the existing action or receipt lineage, so an abort or lost callback cannot silently create a second dispatch. A deliberate repeat requires a distinct target-supplied request or idempotency input.

## Local state and service state

The extension stores the confirmed policy, universal and task rules, task registry, pending decisions, revocations, receipt history, and non-exportable P-256 device key locally. The local receipt default is 30 days; pinned and exported receipts remain.

The V2 Worker stores only the bounded network state required to register public device keys, scope and revoke staged connections, reject replay, and bind terminal receipt digests. Full policies, action arguments/results from the browser path, and ordinary receipt history are not V2 broker authority state.

The isolated V1 rollback bridge retains transient action arguments and results and has acknowledgement/expiry fields for purge. The V2 browser path sends neither arguments nor results to the broker. Optional encrypted sync, accounts, recovery, and multi-device continuity are later features.

Manifest V3 worker suspension and browser restart must recover durable local policy and terminal history safely. Expired pending or task authority fails closed during recovery.

## Device and connection authentication

One explicit **Enable doA2Ai** ceremony first presents the compact starter-policy disclosure and requires its checkbox confirmation, then requests optional HTTPS site access, creates a non-exportable P-256 device key, and registers only its public key.

Device requests sign a canonical envelope with nonce, timestamp, endpoint audience, action/task binding, and body digest. The Worker verifies the signature, audience, freshness, nonce uniqueness, registered device state, and revocation state before accepting it.

Normal browser use has a built-in service URL. An Advanced self-host setting may replace it. Normal UI never asks for broker/operator bearer tokens.

The staged standalone-connection service can issue and revoke a unique task-scoped bearer credential with a 15-minute default lifetime through signed device requests. Credentials are header-only by contract and never appear in URLs. No V2 MCP endpoint consumes that credential in this candidate.

Production OAuth 2.1 and authorization-server discovery remain roadmap work.

## Receipt contract

The implemented local receipt is deterministic canonical JSON with a human projection. It includes:

- requested action and redaction markers;
- authority outcome, source, rule ID, and policy revision;
- human decision when applicable;
- dispatch attempt and execution lineage;
- tool-reported result and available target evidence;
- reconciliation or match status only when the available target evidence can support it;
- actor/connection attribution or explicit unknown attribution;
- timestamps, expiry, digest, device signature, signer public JWK/device ID/key thumbprint, and local verification result; and
- the broker-bound terminal digest and server timestamp.

Evidence classifications are `independently_verified`, `tool_reported`, `divergent`, `blocked`, `failed`, and `unknown`.

The extension verifies the canonical receipt against its embedded non-secret signer metadata; an old receipt remains verifiable after local key rotation. The broker-bound digest demonstrates what terminal digest the service recorded at a time through a separately authenticated device request. Neither is a server signature, third-party identity attestation, authenticated target readback, or independent proof of the target's business semantics.

## Control-center bridge

The Worker root is the real product control center, not a target page and not a marketing-only site.

Before pairing it shows truthful product readiness and whether the installed extension bridge is present. Enablement and pairing occur only in the extension popup. It must not fabricate sample tasks, results, tools, or receipts.

After pairing, an explicit **Open control center** action creates a random, memory-only disclosure capability that expires after 10 minutes and is carried in a no-referrer URL fragment. Only a page opened with that capability can request the closed read-only snapshot for Tasks, Rules, activity summaries, and Connection Health. The bridge validates the exact configured origin/path, disclosure capability, and snapshot-only operation, while rendering values through text nodes. It does not implement a signed page challenge. Decisions, pause, task revoke, settings, full receipt JSON, private keys, bearer credentials, pairing secrets, and unredacted fields do not enter the remote page.

The control center is opened only when needed and may be closed without stopping protection.

## Failure behavior

- No WebMCP API or no page tools: report the condition; do not infer DOM actions.
- Restricted browser URL or denied host grant: report unavailable; do not weaken permissions silently.
- Missing/malformed/stale/conflicting impact data: `ask` unless a confirmed hard block applies.
- Global pause, revoked task/device/connection, expired authority, replay, or signature failure: block before dispatch.
- Catalog, tool, schema, origin, document, arguments, or policy mismatch: invalidate and reevaluate; never reuse the old approval.
- Service unavailable before a state-changing dispatch: stop. Locally verifiable safe reads may continue with a local receipt.
- Service or browser failure after dispatch: record `unknown`; identical retries resolve to that prior lineage and do not dispatch again.
- Authenticated target readback differs from authorized state: record `divergent` and require reconciliation. A plain tool return is only `tool_reported` and does not establish state equivalence.
- No reliable agent identity: record `unknown-browser-agent`; do not invent attribution.
- Notification unavailable: retain pending review in the popup/control center; authority is not implied.

## Trust and enforcement boundaries

V1 controls invocations routed through doA2Ai-protected tools. Chrome may continue to advertise native page tools, and the extension has no universal interception hook for a bypassing client. Browser-path guarantees are therefore cooperative and must be described that way.

A future standalone MCP path may guarantee its own filtered catalog, but no such V2 path is implemented here. Even then, it could not stop the same agent or another client from using an unrelated direct route to the target.

Page code, the browser, the external agent, the transport service, and the target remain separate trust domains. V1 applies observable containment but does not sandbox arbitrary malicious page code. A strongly protected operation ultimately requires target-owned validation and authenticated readback.

## Private fixture and release boundary

Historical simulators, dogfood pages, synthetic targets, research-brief material, insurance examples, offline runtimes, and review artifacts may remain in the private canonical workspace for provenance and regression work. They are not implementation dependencies for this architecture.

They must not be included in the public source snapshot, extension package, live control center, judge path, or video. The separate `doa2ai.omniamula.ca` site remains untouched and outside the product topology.

## Public contract types

- `AuthorityPolicyV1`: revisioned confirmed rules with effect, data, recipient, financial, reversibility, scope, decision, and expiry constraints.
- `TargetImpactManifestV1`: future advisory tool/schema-bound impact contract; not implemented in this candidate.
- Local action record: stable action/task/connection identity, exact page/tool/arguments bindings, impact evidence, and timestamps.
- Local decision evidence: `allow | ask | block`, authority mode/source, rule/policy binding, exact action digest, and expiry.
- Local receipt V1: requested/authorized/dispatched/result/evidence states, redaction, canonical digest, device signature, and broker terminal binding.

V2 routes are additive beside the verified baseline during migration. They cover readiness, device challenge/registration/status/revocation, connection-credential creation/revocation, replay rejection, and terminal receipt-digest binding. They do not implement remote task/action/decision/result/acknowledgement transport or a V2 MCP endpoint. V1 compatibility remains isolated as a rollback path until exact-candidate acceptance.

The compatibility path preserves the baseline's exact origin/document/tool/schema/arguments binding, separate transport scopes, same-lineage result retry envelope, no repeated browser invocation, and truthful `unknown` result. Existing `ask_on_exception` and `autonomous_within_bounds` profiles map to `ask` and `block` behavior without broadening authority.

## Verification boundary

Automated verification must cover policy precedence, rule confirmation, task isolation, multi-page and multi-connection behavior, expiry/revocation, origin and catalog changes, schema-string decoding, malicious metadata, replay, signature failures, ambiguous execution, redaction, retention/purge, service-worker recovery, accessibility, and the implemented connection-credential boundary.

The owner-run network test must independently observe the exact packaged extension, Chrome 152, the real Worker, a currently official WebMCP target, a real external browser agent, all three authority outcomes, and truthful receipts. Local fixtures are not substitutes.

## Production questions intentionally UNKNOWN

V1 does not settle the final production answer for:

- final authority-service, SDK, or target-integration topology;
- identity model beyond the V1 device binding;
- durable persistence beyond local V1 browser storage;
- production OAuth or authentication;
- cross-application trust;
- execution-adapter contract and atomic authority-to-effect coupling;
- server signing or independently trusted signer attestation;
- universal authorization language;
- multi-agent orchestration; or
- jurisdiction- and class-specific legal clearance for the selected identity.

The doA2Ai name decision is sufficient for the challenge plan but is not a legal opinion or formal trademark clearance.

## Clean-room boundary

The architecture is derived from the project requirements and public WebMCP material. Contributions must preserve the clean-room boundary in [`../PROJECT_PROVENANCE.md`](../PROJECT_PROVENANCE.md).
