# doA2Ai Chrome extension

This Manifest V3 extension is the browser-side authority owner for doA2Ai. It mediates real page-owned WebMCP tools for external agents, evaluates each exact action against locally confirmed authority, dispatches permitted calls, and retains local task and receipt history.

It is not an agent, a target-service adapter, an embedded browser, or a duplicate of the target website.

## Intended V1 experience

1. Load the exact `extension` directory through `chrome://extensions` using **Developer mode → Load unpacked**.
2. Open doA2Ai, review the compact starter-policy disclosure, and select its explicit confirmation checkbox.
3. Choose **Enable doA2Ai** once and confirm Chrome's requested HTTPS site-access grant.
4. The extension generates a non-exportable P-256 device key and pairs its public key with the built-in HTTPS service.
5. Visit a real WebMCP-enabled HTTPS page and use a compatible external browser agent normally.
6. doA2Ai exposes protected versions of relevant page tools automatically. No routine broker URL, bearer token, MCP URL, agent vendor, or tool-checkbox setup is required.
7. Optionally choose **Set up a rule** in the popup before using an agent. The Rules page re-checks the current protected HTTPS catalog and lets you confirm one exact tool/argument binding; it never creates a broad site grant.
8. In-bound actions proceed quietly. A missing or uncertain authority decision creates one focused review. Blocked actions stop and appear in the badge/history without interrupting by default.

The compact popup shows protection state, connection health, active tasks, pending reviews, blocked activity, global pause, current-page task revoke, and links to details. It does not present a standing tool-selection list: page tools are protected automatically, and the agent receives the current page's protected WebMCP surface when it starts work. Focused review, local receipt history, individual receipts, and settings open as extension-owned normal tabs. The HTTPS control center is a read-only status projection.

## Browser mediation

The extension discovers `document.modelContext.getTools()` in the page's main world and tracks navigation and `toolchange`. For each source tool it creates a collision-safe protected registration whose provenance retains the original name, description, annotations, origin, document identity, catalog digest, and tool/schema digest. The protected schema is canonicalized at this boundary: object schemas that omit `additionalProperties` are treated as closed (`false`), while explicitly open objects remain rejected.

Every invocation is re-bound to the current page state before dispatch. A relevant origin, document, catalog, tool, schema, arguments, or impact change invalidates an outstanding authorization.

The normal product selects capabilities automatically. Standard page annotations plus the tool definition are cooperative classification evidence interpreted by confirmed local policy; they are not themselves a reusable rule or approval. V1 cannot detect a page that lies about its own tool implementation. Inferred state-changing verbs remain low-confidence and ask. Missing, malformed, stale, or conflicting metadata also produces an uncertain result and focused review; a stronger target-bound impact manifest remains future work.

Current Chrome APIs may continue to expose the native page registrations beside doA2Ai's protected registrations. The extension cannot guarantee that an agent will not bypass its tools. V1 enforcement applies to calls routed through doA2Ai; stronger target-owned or browser-level enforcement remains roadmap work.

## Local authority state

The extension owns:

- the confirmed starter policy, universal rules, and temporary task rules;
- multi-page task membership and connection-bound task IDs;
- pending action and decision state;
- global pause, revocation, and expiry state;
- full human and JSON receipts; and
- a non-exportable device signing key.

Rules and receipt history live locally. Receipts expire after 30 days by default unless pinned or exported. Temporary task authority ends with the task or after 30 minutes without a gated action. State must recover safely after Manifest V3 worker suspension or browser restart.

`chrome.storage.local` stores non-secret durable product state. Short-lived coordination data belongs in recoverable extension state with explicit expiry. Secret bearer credentials must never be written to URLs, DOM state, logs, receipt exports, or ordinary settings storage.

## Authority and execution behavior

- **Delegated authority:** an exact action fits confirmed policy and proceeds without routine human review.
- **Transaction authorization:** an exact action lacks sufficient authority and waits for **Approve once** or **Deny**.
- **Block:** policy forbids the action, so it is never dispatched.

The agent receives a stable pending action ID and polls or resumes that action after a decision; it does not submit a second side effect. Read-only work may retry when safe. Identical state-changing retries within the same task/document/tool/arguments binding resolve to the existing durable lineage instead of dispatching twice. A deliberate repeat requires a distinct target-provided request or idempotency input. An ambiguous result becomes `unknown` pending reconciliation.

Reusable allow is limited to non-sensitive reads and reversible self-directed changes, requires a second confirmation, and is bound to the exact origin, tool-definition digest, and canonical arguments digest. Credential, security, and destructive actions are unconditional V1 blocks.

The optional pre-agent setup uses the same reusable-allow contract as review-time rule creation. It stores only the canonical arguments digest; the current page, document/catalog, tool definition, and conservative impact classification are revalidated before the rule is added.

Every terminal action receives a receipt. The local P-256 key signs the authority proof and canonical receipt. The receipt carries the non-secret signer public JWK, device ID, and key thumbprint; the receipt page verifies the signature and old receipts remain verifiable after key rotation. The broker authenticates a separate device-signed request and binds a terminal digest to the action ID and server time. This does not constitute server signing, third-party identity attestation, or independent target attestation.

## Service and staged standalone connection

Normal builds use the built-in doA2Ai service URL. A self-hosted URL is an Advanced setting, not onboarding.

The exact-origin extension bridge lets the HTTPS control center render only a closed, read-only snapshot after an explicit extension action creates a random memory-only 10-minute disclosure capability in a no-referrer URL fragment. Direct navigation receives no local snapshot. The remote page cannot make decisions or mutate pause, task, policy, connection, or receipt state. Pairing material and full local receipts never enter it.

The service can issue a unique, task-scoped, revocable bearer credential with a 15-minute default lifetime and header-only transport. This is credential-lifecycle plumbing for a future standalone MCP path; this candidate has no V2 MCP consumer or filtered-catalog endpoint. Production OAuth 2.1 also remains roadmap work.

## Permissions contract

The intended V1 permission set supports:

- one explicit optional HTTPS host-access grant during enablement, revocable in Chrome;
- `scripting` for exact main-world WebMCP discovery and dispatch;
- `storage` for local-first policy, tasks, receipts, and recovery;
- `alarms` for bounded wake-up, expiry, and transport polling; and
- `notifications` for pending-review alerts only.

No page overlay or always-running tab is required. Browser-owned and other restricted URLs remain inaccessible and must be reported truthfully.

## Verified baseline boundary

**OBSERVED at commit `d587d2b`:** the extension discovers real page tools, creates a remote broker session, polls commands, opens an exact-action review, dispatches the current `RegisteredTool`, and records a bound result. It currently uses `activeTab`, manual broker/operator credentials, manual page-tool selection, and a copied session-specific MCP URL.

Those baseline controls are not the intended V1 UX. They remain documented here only to prevent implementation work from being mistaken for already verified behavior. Installed-browser end-to-end acceptance is **NOT PROVEN** until the owner performs the remote runbook.

## Checks

From the repository root:

```powershell
npm.cmd test
npm.cmd run check
```

These checks cannot establish Chrome permission prompts, WebMCP compatibility, notification behavior, service-worker recovery, external-agent use, or human comprehension. Those require the exact packaged extension and live-network acceptance.
