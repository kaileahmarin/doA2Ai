# doA2Ai browser UI track

**Status:** locked target direction for V1. Source implementation and owner-run browser acceptance remain separate gates.

## Product shape

doA2Ai should feel like a small native Chrome extension: quiet while work is in bounds, obvious when attention is required, and expandable into a normal browser tab for detail.

It is not a fake browser, target-site replacement, embedded agent, task-planning app, permanent dashboard, or approval queue.

The GUI has three surfaces:

1. the toolbar badge/icon for passive status;
2. a compact extension popup for ordinary controls; and
3. extension-owned normal-tab review, activity/receipt, and settings pages, plus a Worker-hosted read-only control center for status detail.

Detail pages open in the user's existing Chrome window only when requested. The remote control center does not need to remain open and cannot grant authority or mutate local state.

## One-time onboarding

The first popup shows a compact starter-policy disclosure, an explicit confirmation checkbox, and one **Enable doA2Ai** action. It explains:

- the optional HTTPS page access Chrome will request;
- the local device key and local-first policy/receipt storage;
- the built-in HTTPS service used for protected transport; and
- the recommended starter policy the person must confirm.

After confirmation, onboarding is complete. Normal users do not enter broker URLs, operator/browser/MCP bearer tokens, agent names, supported-site lists, or per-task tool checkboxes. An optional self-hosted service URL belongs under Advanced settings.

If Chrome access is denied or revoked, the popup reports that exact condition and links to the relevant Chrome permission surface. It does not silently request broader access or manufacture page capability.

## Toolbar behavior

The icon is the only always-available activity indicator. It may use a restrained state treatment and compact badge:

- no badge: enabled and no attention needed;
- numeric badge: pending reviews;
- calm dot/count: blocked activity available in history;
- paused treatment: global protection pause is active; and
- warning treatment: connection or permission problem.

Routine task starts, allowed calls, and completions do not create page overlays or notifications.

## Normal popup

The popup is a compact dropdown-style utility. Its default view shows:

- protection state and global pause/resume;
- current-page WebMCP/protected-tool availability;
- connection health;
- the current page task with an **End page task** control;
- pending-review count and a **Review** action;
- blocked-event count without alarm language; and
- links to **Open details** and Advanced settings.

The popup may use progressive disclosure, but its expanded sections remain short. It does not reproduce full page forms, raw schemas, receipt JSON, every discovered tool, or the full rule editor. Its **Set up a rule** action opens the extension-owned Rules page in a normal tab; that page can pre-authorize one exact tool/argument binding from the currently protected HTTPS page before an agent is used.

When a page has no WebMCP tools, the popup says so plainly. When a page is restricted or unsupported, it distinguishes that from a compatible page with an empty catalog. It never infers actions from DOM content.

## Authority states in the UI

The product exposes three outcomes in plain language:

- **Allowed by your rules:** work proceeds with delegated authority and no interruption.
- **Review needed:** doA2Ai lacks sufficient authority for this exact action.
- **Blocked by your rules:** the action did not run; what, where, and why remain available in activity history.

The underlying authority modes—delegated authority and transaction authorization—appear in detailed explanation and receipts, not as a repetitive mode selector.

No page or agent receives blanket approval. A prior action may proceed again only when its applicable confirmed boundary and all exact bindings still match.

## Focused review

A pending action receives one stable action ID. A notification may say that review is needed and open that action; it does not itself authorize anything.

The compact review shows:

- what the agent proposes;
- the page/origin and source tool;
- the effect, data, recipient, financial, and reversibility classification;
- why current authority is insufficient or uncertain;
- exact arguments with appropriate redaction; and
- what will happen after the decision.

Primary actions are **Approve once** and **Deny**. For an eligible non-sensitive read or reversible self-directed change, an expandable section may offer:

- **Allow for this task**;
- **Create universal rule**; and
- **Always block**.

Every reusable allow is bound to the exact site, tool-definition digest, and canonical arguments digest and requires a second confirmation. External, financial, irreversible, credential, security, and destructive actions never show reusable allow in V1. Any future free-form rule must be compiled to a structured preview before that confirmation. Policy edits re-evaluate pending work; they do not retroactively authorize a changed action.

The notification → compact review → detailed tab sequence is provisional until the owner's first usability test. The authorization invariant is not provisional: no decision occurs without exact visible context.

The Rules page is both the local rule inventory and the optional pre-agent setup surface. It re-discovers the selected protected page, shows the tool schema and conservative impact eligibility, requires exact JSON arguments plus an explicit confirmation, and stores only the canonical argument digest. Sensitive, external, destructive, and unknown-impact tools remain review-only; reversible self-directed changes retain the existing explicit reusable-rule path.

## Control center

The Worker root is the real product control center. It is not the WebMCP target and must never show fabricated tasks or sample results.

Before pairing, it presents truthful readiness:

- what doA2Ai does;
- whether the extension is detected;
- whether WebMCP support is available;
- how to enable the exact test build in its own popup.

After pairing, the four read-only sections are:

- **Tasks:** active tasks, bound-page counts, status, expiry, and pending-action summaries;
- **Rules:** confirmed rule scope, decision, exact tool/origin binding, and expiry;
- **Activity:** bounded outcome summaries; full redacted receipts stay on extension-owned pages; and
- **Connection Health:** device/service state and last check.

The remote view uses an exact-origin, snapshot-only extension bridge. Opening it from the extension creates a random memory-only disclosure capability that expires after 10 minutes and travels only in a no-referrer URL fragment; direct navigation cannot read the local snapshot. It cannot approve, deny, pause, revoke, connect, or edit rules. Device private keys, bearer credentials, pairing secrets, full receipts, and action arguments never enter the remote page DOM, script-readable storage, or ordinary network payloads. The URL fragment contains only the short-lived disclosure capability, never a device or service credential.

## Tasks and agents

doA2Ai groups actions by task but does not require an agent plan. One task can span multiple pages and multiple external agents. Each origin, tool, action, and data flow is evaluated independently.

If agent identity is unavailable, the UI says **Browser agent (identity unavailable)** or equivalent. It must not guess a vendor or person.

The agent may receive task-boundary information needed to use protected tools, but not the user's complete policy or receipt history.

## Receipt presentation

Every protected action has a receipt, including nonexecution. The human view clearly separates:

- requested;
- authorized and authority source;
- dispatched;
- reported or observed result;
- verification evidence; and
- match/divergence/unknown outcome.

The JSON view is redacted by default and includes the same canonical lineage, signer public JWK/device ID/key thumbprint, locally verified device signature, and broker-bound terminal digest. Copy marks the receipt as exported for local retention. The presentation must distinguish `independently_verified` from `tool_reported` and never turn `unknown` into implied success or failure.

## Visual and accessibility direction

- Native, calm Chrome-utility proportions with restrained doA2Ai branding.
- Responsive popup without horizontal scrolling at supported zoom.
- Accessible light and dark themes.
- Keyboard-reachable controls, visible focus, semantic headings, labelled status, and no color-only meaning.
- Short action-first copy; raw protocol details live behind disclosure.
- No fake browser shell, full-screen onboarding, constant animation, page overlay, or persistent control tab.

## Verified baseline versus target UI

**OBSERVED at commit `d587d2b`:** the popup supports current-page discovery, manual tool selection, enablement, a copied MCP URL, manual setup, and links to normal-tab review/receipt pages. This is a working baseline, not the target product interaction.

The intended V1 removes routine manual setup and tool selection, adds local rules/tasks/history and one-time enablement, and changes the control page into the product detail surface. Those behaviors remain unverified until the exact implementation and packaged extension pass automated checks and owner-run Chrome acceptance.

## Private surfaces

Synthetic pages, local smoke-test interfaces, fake-browser shells, research-brief and insurance examples, and internal review artifacts are private fixtures only. They must not appear in the public repository snapshot, test-build package, live control center, judge path, or video.

The separate `doa2ai.omniamula.ca` site is outside this track and remains untouched.

## Still UNKNOWN or roadmap

- universal interception of native WebMCP tools;
- target-owned enforcement and independently attested target results;
- production human/organization/agent identity and OAuth 2.1;
- encrypted sync, recovery, and multi-device continuity;
- organization administration and external orchestration hooks;
- Chrome Web Store publication and non-Chrome compatibility;
- server signing or independently trusted signer attestation; and
- jurisdiction- and class-specific formal legal clearance.
