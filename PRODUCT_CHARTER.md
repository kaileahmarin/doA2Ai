# doA2Ai product charter

**Human-authorized execution for WebMCP**

## Product promise

doA2Ai is a bounded authorization layer for agent-mediated WebMCP work. It lets an external agent continue automatically while an exact proposed action remains inside authority the person has already confirmed. When authority is missing or uncertain, doA2Ai either asks for the smallest necessary human decision or blocks the action according to policy. It then records what was requested, authorized, dispatched, reported, and verified in a truthful receipt.

The core lifecycle is:

**bounded task → minimal capabilities → agent work → authority check → proceed, focused review, or block → execution → verification → receipt**

doA2Ai is not an agent, an agent host, a workflow planner, or a generic DOM automation system. Agents and their tasks remain external. doA2Ai observes and mediates actions routed through its protected WebMCP tools.

## Who it is for

V1 is for an individual using one or more external browser or MCP agents who wants useful automation without giving those agents blanket authority, credentials, or their identity.

## Product topology

The intended V1 product consists of:

- an installed Manifest V3 Chrome extension that owns local policy, task state, decisions, and receipt history;
- a real HTTPS Worker that transports action requests and hosts the product control center;
- real WebMCP pages that own their tools and business semantics; and
- external agents that invoke doA2Ai-protected versions of those tools.

The extension is the local authority owner. The Worker is a bounded transport and coordination service, not the source of universal policy or a repository of full receipt history. The HTTPS control center displays a read-only, redacted projection through an exact-origin extension bridge and does not need to remain open. Authority decisions and mutations remain on extension-owned pages.

The browser-integrated path is the implemented V1 challenge path. The service has short-lived connection-credential lifecycle primitives for a future standalone MCP path, but this candidate does not expose a V2 standalone MCP endpoint or filtered catalog. That secondary path remains staged and is not part of acceptance or judging claims.

## Two authority modes

### Delegated authority

A proposed action may proceed without interrupting the person when it fits a previously confirmed rule and every bound detail still matches. The authority is scoped to the action's effect, data, recipient, origin, tool and schema, limits, reversibility, task boundary, and expiry.

**confirmed boundary → exact action comparison → in bounds → execution → verification → receipt**

### Transaction authorization

When an action is outside confirmed authority, uncertain, or configured to require presence, the person may authorize that exact action once. Approval is bound to the displayed proposal and cannot be reused after a relevant origin, tool, schema, argument, or impact change.

**authority gap → focused review → exact human decision → execution or denial → verification → receipt**

These are the only authority modes. `allow`, `ask`, and `block` are evaluation outcomes, not additional modes:

- **allow:** sufficient delegated authority exists, so work proceeds quietly;
- **ask:** an exact transaction authorization is permitted and required; and
- **block:** policy forbids the action, so it is not dispatched and no routine interruption is created.

## Policy and task model

The person confirms one recommended starter policy during onboarding. It supports useful automation rather than defaulting every action to review:

- sufficiently classified low-sensitivity reads may proceed; inferred changes ask unless a separately confirmed exact rule covers them;
- disclosure, communications, commitments, publishing, purchases, account changes, and irreversible actions ask; and
- credential, security-sensitive, and destructive actions are unconditional V1 blocks; this candidate exposes no override for them.

People may add reusable cross-task rules and temporary task rules for non-sensitive reads or reversible self-directed changes. An allow rule remains bound to the exact origin, tool-definition digest, and canonical arguments digest; “cross-task” never means blanket authority across sites, tools, or changed inputs. External, financial, irreversible, credential, security, and destructive actions cannot create reusable allow rules in V1. Reusable allow requires a second explicit confirmation. A free-form rule is not authority until doA2Ai compiles it into a visible structured rule and the person confirms that structure. Before an agent is used, the extension's Rules view may create the same universal exact rule from the currently protected HTTPS page; it never accepts a user-typed origin, broad tool grant, or unbound argument pattern.

Tasks group related actions and receipts; they do not require an agent to submit a plan. One task may involve multiple pages, origins, or external agents, but every action is evaluated independently. When an external protocol supplies a stable task reference it is recorded as provenance. Otherwise doA2Ai issues an opaque connection-bound task identifier at the first protected action. Agent claims and heuristic labels may organize activity but cannot grant authority.

Temporary task authority expires when the task ends or after 30 minutes without a gated action by default. The person can shorten that interval, revoke a task, or pause all protected execution.

## Capability and impact model

doA2Ai exposes protected versions of relevant page-owned WebMCP tools. It preserves the source tool's actual name, description, and schema as provenance while using a collision-safe protected identifier. It does not invent capabilities from DOM content.

Capability selection is automatic and action-driven. The normal product does not ask the person to check tool boxes for every task.

Ordinary WebMCP tools work conservatively. Standard page annotations plus the tool name, description, and schema provide cooperative classification evidence interpreted by confirmed local policy; they are not themselves a rule or approval. V1 does not independently attest page semantics, so a deceptive or misannotated target is outside the cooperative-target guarantee. A stronger structured, tool-bound impact manifest remains a future contract direction. Missing, malformed, stale, or conflicting metadata makes the action uncertain.

Every request is bound to its exact origin, document, catalog, tool definition, input schema, and arguments digest. A relevant change invalidates a pending or reusable authorization.

## Human experience

The extension popup is a small native Chrome utility. It shows protection and connection state, active tasks, pending reviews, a calm blocked-event count, global pause, per-task revoke, and links to details. It does not contain an agent, duplicate the target website, or imitate a browser window.

Human review is exceptional. A notification may alert the person that a decision is waiting; the authorization itself occurs only after the person opens the extension-owned compact review and sees the exact context. The primary choices are **Approve once** and **Deny**. For eligible non-sensitive reads or reversible self-directed changes, expandable options can allow the same exact site/tool-definition/arguments binding for this task or across tasks; consequential actions do not show reusable allow. **Always block** remains available. Reusable allow requires a second confirmation. The notification and review layering remains provisional until owner-run usability testing.

Blocked actions appear in the badge and activity history without a notification by default.

## Execution and receipts

A pending action receives one stable action identifier. The agent polls or resumes that same action after a decision; it does not resubmit the side effect. Safe read-only work may retry. Identical state-changing retries in the same exact task/document/tool/arguments binding converge on the prior durable lineage, including after a lost callback. A deliberate repeat requires a distinct target-supplied request or idempotency input. An ambiguous outcome remains `unknown` until reconciled.

Every protected action produces a human-readable and machine-readable receipt, including allowed, denied, blocked, failed, divergent, and unknown outcomes. The receipt separates:

- requested state;
- authority and policy revision used;
- dispatch state;
- target- or tool-reported result;
- verification evidence; and
- whether those states matched.

The local device key signs a self-contained authority-proof envelope and canonical receipt. The receipt includes the non-secret signer public JWK, device identifier, algorithm, and key thumbprint; local verification therefore remains possible after the active key is rotated. The broker authenticates a separate device-signed request and binds the terminal digest to the action identifier and server time. This is device-origin tamper evidence; it is not a server signature, third-party identity attestation, or independent target attestation.

Receipt evidence is labelled only as `independently_verified`, `tool_reported`, `divergent`, `blocked`, `failed`, or `unknown`. Claims never exceed the available evidence.

## Data and retention

Rules, task state, and full receipt history are local-first. This candidate retains receipt history for 30 days; receipts explicitly pinned or copied as exported JSON remain.

The broker retains only the minimum connection, replay, pending-action, and terminal binding data needed for transport. Action arguments and results are removed after terminal local acknowledgement, with a 24-hour hard purge ceiling. Optional encrypted account sync, recovery, and multi-device continuity are later features rather than a V1 account requirement.

If the service is unavailable, locally verifiable safe reads may continue with local receipts. State-changing actions stop before dispatch. An outage after dispatch produces `unknown` and never an automatic second attempt.

## Security and enforcement boundary

doA2Ai V1 governs actions when an agent uses its protected tool path. Chrome may still expose the page's native WebMCP tools directly, and the extension cannot universally intercept a bypassing agent. Cooperative browser-agent use must therefore remain explicit in the product and judging claims.

A future standalone MCP path is intended to enforce a filtered, task-scoped catalog. Its implemented credential primitive is short-lived, revocable, unique per connection, and header-only, but the V2 MCP consumer/catalog adapter is not implemented in this candidate and must not be claimed or tested as present.

V1 targets cooperative pages and applies all observable containment available to the extension. It does not claim to sandbox arbitrary malicious page code or prove downstream semantics without target evidence. Strong target-owned enforcement and signed target attestation are later work.

## Challenge and public-release boundary

The challenge deliverable is an exact verified extension test build, the real HTTPS product control center, and a public licensed source snapshot with installation and testing instructions. The first owner-run end-to-end test uses a real browser-integrated agent and a real target from the official WebMCP Challenge resources. It exercises one allowed action, one reviewed action, and one blocked action without real purchases, credentials, or personal data.

Internal dogfood pages, local simulators, synthetic targets, research-brief material, insurance examples, historical prototypes, and review artifacts may remain preserved privately. They are not the product and must be absent from the public source snapshot, installable package, live control center, judge path, and video.

The separate `doa2ai.omniamula.ca` site is outside this product path and remains untouched.

## Verified baseline versus intended V1

**OBSERVED baseline at the start of this implementation:** commit `d587d2b` contains an installed extension, deployed Worker/D1 broker source, exact action binding, exception review, real HTTPS transport, and truthful result recording. That baseline still asks the operator to enter service credentials, select page tools manually, and configure an external MCP endpoint. A Worker deployment and package were verified, but installed Chrome → real target → external agent → human decision was **NOT PROVEN**.

Everything in this charter labelled as the intended V1 remains a required product behavior until implementation and acceptance evidence establish it. Source code, unit tests, a deployed health endpoint, or a local fixture must not be described as owner-run network acceptance.

## Production questions intentionally UNKNOWN

The V1 challenge architecture does not settle the final production answer for:

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

The project owner selected **doA2Ai** for the challenge. The recorded exact-name screen is bounded evidence, not a legal opinion or formal trademark clearance.
