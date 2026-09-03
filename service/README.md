# doA2Ai authority transport and control center

This directory is the deployable, domain-agnostic HTTPS service. The installed doA2Ai extension owns authority policy, task state, decisions, and full receipt history. The service provides proof-of-possession device pairing, replay-resistant signed requests, staged short-lived connection credentials, terminal receipt-digest binding, and a read-only ordinary-browser control-center shell.

It does not create or host an agent, act as a WebMCP target, store the user's local authority policy, or provide fake/sample tasks. V1 remains available as a rollback bridge while V2 is integrated and accepted.

## Configure and deploy

Wrangler 4.45 or newer can provision the configured D1 binding on the first deployment. For an authenticated permanent account, deploy once and then apply the schema to the provisioned remote database:

```powershell
npx.cmd wrangler deploy
npx.cmd wrangler d1 migrations apply doa2ai-broker --remote
```

For an unauthenticated first live run, Wrangler 4.102 or newer supports the following explicit bootstrap. Cloudflare provides a real Worker plus D1 in a temporary account and returns a claim URL. The owner must complete that claim within 60 minutes or Cloudflare deletes the temporary account and its resources.

```powershell
npx.cmd wrangler deploy --temporary
npx.cmd wrangler d1 migrations apply doa2ai-broker --remote
```

The following three secrets belong only to the V1 rollback bridge. The MCP token is for the external agent, the browser token is for the extension bridge, and the operator token is for exact-action docket decisions. Never put the browser or operator token in an agent configuration, and never put the MCP token in the extension.

```powershell
npx.cmd wrangler secret put MCP_BEARER_TOKEN
npx.cmd wrangler secret put BROWSER_BEARER_TOKEN
npx.cmd wrangler secret put OPERATOR_BEARER_TOKEN
```

Set `ALLOWED_EXTENSION_ORIGINS` in `wrangler.jsonc` to the exact installed extension origin (comma-separated only if more than one signed build is intentionally supported). Wildcards are not accepted. Then deploy:

```powershell
npx.cmd wrangler deploy
```

The Worker root is the product control center and public readiness URL. It exposes no WebMCP tools and is deliberately rejected as a target. It explains the product and reports whether the installed extension bridge is present; enablement and pairing stay in the extension popup. Opening the control center from the extension creates a random memory-only disclosure capability that expires after 10 minutes and is carried only in a no-referrer URL fragment. Direct navigation cannot read local state. After pairing, its Tasks, Rules, Activity, and Connection Health views contain only a redacted snapshot supplied through the exact-origin isolated-world bridge. The remote page cannot approve, deny, pause, revoke, connect, edit rules, or fetch full receipts, and receives no signing private key, bearer credential, policy database, or standalone agent.

## V2 device contract

Pairing is an explicit proof-of-possession exchange:

1. Generate a non-exportable ECDSA P-256 key in the extension and export only its public JWK.
2. Send the closed body `{ "public_key_jwk": <JWK> }` to `POST /v2/devices/challenge`.
3. Sign the returned unpadded base64url `challenge` bytes exactly as UTF-8 using ECDSA P-256/SHA-256. The signature wire form is the 64-byte IEEE P1363 `r || s` value encoded as unpadded base64url.
4. Send `{ "challenge_id": "...", "signature": "..." }` to `POST /v2/devices/register` within five minutes. The challenge is single-use. Proof from an already-active key safely returns its existing device ID, while a revoked key cannot re-register.

Every later V2 mutation, and device status, carries these headers:

```text
X-doA2Ai-Device: dev_...
X-doA2Ai-Timestamp: 2026-09-02T12:34:56.789Z
X-doA2Ai-Nonce: <unique 16-128 character nonce>
X-doA2Ai-Signature: <base64url P-256 signature>
```

Sign the UTF-8 bytes of this exact input, with `SHA256_BODY` as lowercase hexadecimal over the exact request-body bytes (the empty body for `GET`):

```text
doa2ai.v2
METHOD
PATH_WITH_QUERY
TIMESTAMP
NONCE
SHA256_BODY
```

The server accepts a canonical timestamp only within five minutes, binds the signature to the exact endpoint audience and body, requires an active device, and atomically rejects a reused device nonce.

V2 routes are:

- `GET /v2/status`: public, state-free service readiness.
- `POST /v2/devices/challenge` and `POST /v2/devices/register`: one-time pairing.
- `GET /v2/devices/:device_id/status` and `POST /v2/devices/:device_id/revoke`: signed device lifecycle.
- `POST /v2/receipts/bind`: signed `{ action_id, task_id, receipt_digest }`; returns the stored terminal binding without claiming a service signature or target attestation.
- `POST /v2/connections`: creates a device- and task-scoped bearer credential. The default lifetime is 15 minutes, the plaintext token is returned once, and D1 stores only its SHA-256 digest.
- `POST /v2/connections/:connection_id/revoke`: signed connection revocation.

Connection credentials belong in the `Authorization` header, never in a URL. A connection request may supply a doA2Ai task ID or let the service issue one; the task is always bound to the signing device. This candidate does not implement a V2 MCP endpoint that consumes the credential or exposes a filtered catalog. OAuth 2.1 protected-resource discovery, PKCE, and audience-bound tokens remain a post-V1 production requirement, not a claim about this hackathon slice.

V2 D1 tables intentionally contain only public device keys, challenge/replay records, task and connection ownership, optional short-lived action transport fields, and terminal receipt bindings. They contain no reusable authority rules or full local receipt history. If the action transport fields are used later, raw request/result payloads must be cleared after local acknowledgement or their TTL; the schema records `local_ack_at`, `payload_expires_at`, and `purged_at` for that purpose.

## V1 rollback bridge

The V1 extension registers a real target page at `POST /v1/browser/sessions`; the returned one-session pairing key remains in extension-owned session storage. Choosing **Open details** attaches the control page through the isolated-world extension bridge; the page never receives the pairing key, browser token, or operator token. A legacy external MCP client sends `Authorization: Bearer <MCP_BEARER_TOKEN>` to `POST /mcp?session=<opaque-key>`. Browser and operator REST calls require their distinct bearer tokens.

`/mcp` is a Streamable HTTP JSON-RPC endpoint using MCP protocol version `2025-11-25`. It implements `initialize`, `ping`, `tools/list`, and `tools/call`. It returns JSON directly and intentionally returns `405` for an MCP `GET` because this slice does not offer a server-sent event stream.

Transaction-authorized calls create one exact docket. In delegated mode, the judging slice can save one session-, origin-, tool-definition-, exact-argument-, profile-, and expiry-bound rule; a matching repeat is queued without routine review. Missing or exceeded delegated authority creates a focused docket only under `ask_on_exception`; `autonomous_within_bounds` stops without interruption. This single-operator hackathon rule is not the repository's full production exact-grant contract. Page-supplied annotations are not accepted as authority. Because a Worker cannot synchronously wait for the paired browser, a call returns `queued`, `authority_required`, or a terminal non-execution status and the agent reads completion through `doa2ai_status`. A missing result after browser dispatch becomes `unknown`; the page action is never retried automatically, while an already-recorded identical bound result envelope may be safely resubmitted.

## Truth limits

- D1 provides durable broker records and conditional queue claims, but the Worker cannot make a page-owned WebMCP call itself. A dispatch becomes externally ambiguous if the browser receives a command and no bound result returns before the deadline; it is recorded `unknown` and is never automatically retried.
- A completed result proves that the authenticated extension returned a result bound to the exact queued action. It does not independently prove the semantics or downstream side effects of arbitrary page-owned code.
- The generic bridge is cooperative mediation for agents configured to use its MCP endpoint. It does not prevent another client from directly invoking an ordinary page-owned WebMCP tool.
- The V1 rollback path stores the origin-only source URL and exact call arguments needed for dispatch and review. Use non-sensitive judging data until V1 is retired. V2 policy and complete receipts are local-first; optional encrypted synchronization, production tenant isolation, and account recovery are not implemented.
- Tool arguments are checked against a closed JSON Schema subset for JSON types, object properties and requirements, arrays, `const`, `enum`, and basic size/range bounds before they enter a docket or queue. Unsupported schema keywords fail closed.
- Deployment, extension installation, agent connectivity, page compatibility, identity provisioning, human comprehension, and real network execution require separate observation. The commands above do not claim any of them occurred.
