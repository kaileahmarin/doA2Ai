# doA2Ai owner and judge network runbook

This is the acceptance procedure for the real product path:

**installed Chrome extension → real HTTPS doA2Ai service/control center → external browser agent → real WebMCP target → allow, review, and block → truthful receipts**

It does not use a local simulator, fake site, research-brief or insurance scenario, embedded agent, or `doa2ai.omniamula.ca`. Do not touch that separate site.

## Evidence status

**OBSERVED baseline:** commit `d587d2b`, its Worker deployment, D1 migrations `0001`–`0003`, and its extension bundle were verified independently of installed-browser use. That baseline still requires manual service credentials, manual tool selection, and a copied MCP URL.

**NOT PROVEN:** the target V1 one-time enablement and the complete owner-run Chrome/network path. Do not hand the owner a package or call the product ready until the candidate gate below is satisfied.

## 1. Exact-candidate gate

The implementer records all of the following from one candidate after the target V1 implementation lands:

- full Git commit;
- clean intended diff and list of any preserved unrelated working changes;
- full automated-check results;
- Worker URL and deployed version;
- applied D1 migration list with none pending;
- unpacked extension ID;
- exact package path, SHA-256, and manifest SHA-256; and
- confirmation that the package was rebuilt from that commit rather than reused from `d587d2b`.

Before owner handoff, verify:

- the built-in service URL is present and HTTPS;
- normal onboarding asks for no service URL or bearer token;
- the extension package contains no internal dogfood, synthetic, insurance, research-brief, attachment, review-bundle, credential, or local-state material;
- the Worker root is the real control center and returns truthful unpaired readiness without sample tasks/results;
- health, control assets, device challenge/registration, replay rejection, and origin checks pass; and
- the candidate retains a recoverable rollback reference to the verified baseline.

A health response proves only service availability. Automated tests prove only their measured paths.

## 2. Install in Chrome

Use Chrome 152 with WebMCP enabled.

1. Extract the exact candidate ZIP into a new directory; do not load an older extracted folder.
2. Open `chrome://extensions`.
3. Enable **Developer mode**, select **Load unpacked**, and choose the extracted `extension` directory.
4. Record the displayed extension ID and compare it with the candidate record.
5. Pin doA2Ai if convenient, then open its popup.
6. Expand **Review the starter policy**, read the three outcomes, and select **I confirm this starter policy**.
7. Choose **Enable doA2Ai**, then review and accept Chrome's requested optional HTTPS site access. Browser-owned pages remain inaccessible.
8. Confirm that pairing completes without entering a Worker URL, operator/browser/MCP token, agent name, site list, or tool selection.
9. Close any detailed tab. Protection must remain enabled without an always-open doA2Ai page.

Optional pre-agent setup: while the real target tab is active, open the popup and choose **Set up a rule**. The Rules page re-checks the current protected HTTPS catalog. Choose an eligible low-sensitivity read or reversible self-directed change, enter the exact JSON arguments, review the displayed schema and page origin, check the confirmation box, and confirm the exact rule. The rule is universal only across matching exact origin, tool-definition digest, and argument digest; it does not grant a site-wide or tool-wide allowance. If you skip this step, the starter policy and focused review flow remain unchanged.

If any normal-flow secret or endpoint entry is requested, stop: the target V1 UX has not landed. If the extension fails to load or enable, capture the exact error and preserve the candidate rather than modifying it in place.

## 3. Connect the real target and agent

1. Open the official [WebMCP Coffee Store](https://webmcp-coffee.jilles.fyi/) in a normal HTTPS tab. It is an independent target, not a doA2Ai fixture or dependency.
2. Open doA2Ai and verify that the popup identifies the current origin and distinguishes WebMCP support, page tools, and protected-tool availability.
3. Inspect the target's actual current `getTools()` catalog. Record the real names and schemas used in the test; do not rely on remembered or invented tool names.
4. Start a compatible external browser-integrated agent that can use page WebMCP tools.
5. Ask it to use the doA2Ai-protected tool path for a normal safe task. doA2Ai does not require a plan declaration, vendor name, MCP URL, or per-agent configuration in this primary path.
6. Verify that protected tools are clearly distinguishable while retaining the source tool identity and schema.

Chrome may still expose native page tools directly. If the agent chooses a native tool instead of the protected variant, that is a bypass observation, not a successful doA2Ai run. Redirect the test to the protected tool and record the limitation honestly.

If Coffee Store's live catalog does not support a required safe path, use another currently listed target from the official [Challenge resources](https://webmcp.devpost.com/resources) only for the missing path. Do not create or substitute a local test page.

## 4. Exercise the three outcomes

Use non-sensitive test data. Do not make a real purchase, enter credentials, provide personal data, publish content, or create an irreversible external commitment.

### A. Allowed by delegated authority

1. Choose either a low-sensitivity read covered by the confirmed starter policy or an exact rule created in the optional pre-agent setup on the cooperative official target.
2. Ask the agent to perform it through the protected tool with the exact arguments (if using the pre-agent rule, use the exact JSON set that was confirmed).
3. Confirm there is no review interruption.
4. Confirm the target/tool result returns to the agent.
5. Open the receipt and verify `allow`, delegated authority, exact page/tool/arguments bindings, and an evidence label no stronger than the observed result.

### B. Exact transaction review

1. Choose a safe reversible action whose classification requires review.
2. Invoke it once through the protected tool.
3. Confirm the agent receives a stable pending action ID and does not resubmit the side effect.
4. Open the pending notification or popup review.
5. Verify the exact origin, tool, arguments, impact, reason authority is missing, and redaction before choosing **Approve once**.
6. Confirm the same action lineage resumes once, the tool result returns, and the receipt records current-human transaction authorization.
7. Change a relevant argument and verify the prior approval is not reused.
8. If the action is a non-sensitive reversible self-directed change, optionally create a reusable rule and verify the second confirmation names the exact site/tool/arguments boundary. Change an argument and verify review is required again. Consequential actions must not offer reusable allow.

### C. Blocked by policy

1. Propose a credential, destructive, security-sensitive, or other configured hard-block action using a harmless request that cannot create an effect.
2. Confirm it does not dispatch and creates no approval notification by default.
3. Confirm the toolbar/popup shows calm blocked activity.
4. Open its receipt and verify the proposed action, policy reason, `block`, and nonexecution.

If the live target cannot safely express one category, record the limitation and use another official live target. Never weaken policy or perform a real high-impact action merely to complete the test.

## 5. Verify persistence and failure truth

After the three core paths:

1. Close the control-center tab and confirm protection remains active.
2. Let the Manifest V3 worker suspend or restart Chrome, then confirm confirmed policy, task state, and receipts recover without silently reviving expired authority.
3. Revoke the active task and verify a later action cannot use its temporary authority.
4. Toggle global pause and verify state-changing dispatch stops.
5. Open the HTTPS control center and verify Tasks, Rules, Activity/Receipts, and Connection Health agree with the popup.
6. Copy redacted JSON for one receipt and verify it contains the signer public JWK/device ID/key thumbprint, a locally **Verified** device signature, and broker-bound terminal digest but no private key, bearer credential, or unredacted secret.
7. Rotate the device key only if recovery testing is intended, then verify the previously exported receipt still validates against its embedded old public key.
8. If a state-changing dispatch becomes ambiguous, verify the action becomes `unknown`; retrying the identical protected call must return the prior action lineage without a second dispatch.

The owner may adjust the notification → compact review → detailed-tab interaction after this test. Any UI change must preserve exact visible context before authorization.

## 6. Evidence packet

Capture only evidence needed for the release record:

- Chrome version and extension ID;
- exact commit, package hash, Worker version, and migrations;
- target HTTPS origin and observed live tool names;
- external-agent request/result for each protected path;
- screenshots of compact popup states and focused review;
- human and redacted JSON receipts for allow, reviewed, and blocked actions;
- target-visible result when available; and
- any bypass, compatibility, ambiguity, or accessibility limitation.

Redact personal data, tokens, device identifiers, and browser-profile details. Do not put secrets in screenshots, logs, chat, the public repository, or the video.

## 7. Standalone MCP status

**NOT IMPLEMENTED IN THIS CANDIDATE.** The service includes signed creation and revocation of short-lived task-bound connection credentials, but there is no V2 MCP consumer or filtered-catalog endpoint. Skip this path during owner and judge acceptance. Do not configure an MCP client against the legacy V1 rollback endpoint or present credential lifecycle as a working standalone integration.

The browser-integrated protected-tool path is the sole V1 acceptance path. A standalone consumer and production OAuth 2.1 remain future work.

## 8. Video and judge path

Record the video only after the owner test passes on the exact candidate. Keep it public, audible, and under three minutes as required by the official [Rules](https://webmcp.devpost.com/rules).

Show the working product in the first 10–15 seconds:

1. real HTTPS target and external agent invoking a protected tool;
2. one allowed action proceeding without routine review;
3. one focused exact-action review and resumed result;
4. one blocked action with truthful nonexecution;
5. concise human receipt and verification status; and
6. the compact popup plus real HTTPS control center.

Do not use a local fixture, fake browser frame, deployment log, health response, or source walkthrough as the core proof. Do not claim universal interception, independent target attestation, production identity, or OAuth.

## 9. Submission gate

After the video and final exact-candidate verification:

- materialize a fresh allowlisted public source snapshot with a visible license and complete instructions;
- exclude private Git/history, internal fixtures, synthetic/insurance/research material, attachments, review artifacts, packages, secrets, and local state;
- verify the public commit and live Worker version match the documented candidate;
- verify the live control-center URL in both paired and unpaired states; and
- complete Devpost fields only from observed evidence and owner-supplied eligibility/account facts.

The official references are:

- [Challenge overview](https://webmcp.devpost.com/)
- [Resources](https://webmcp.devpost.com/resources)
- [Rules](https://webmcp.devpost.com/rules)
- [Organizer updates](https://webmcp.devpost.com/updates)

## Baseline migration note

The old setup-token/tool-checkbox/session-URL procedure remains historical evidence for `d587d2b`; it is not the intended owner handoff. Keep the deployed baseline available for rollback until the V1 candidate passes, then update the release record rather than silently rewriting earlier evidence.
