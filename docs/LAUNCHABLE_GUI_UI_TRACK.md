# Browser UI track

**Status:** active product direction. Source implementation is present; installation and live browser behavior remain **NOT PROVEN**. The owner selected **doA2Ai**, stated that the “name stuff is done,” and directed the project to continue under that identity. This closes the operational hackathon identity-selection gate; no explicit acceptance of every unindexed legal risk, legal opinion, or formal trademark clearance is claimed. Exact release-tree application remains **NOT PROVEN**.

## Product shape

The product GUI is a thin browser-extension surface for the current page. It is not a separate dashboard, task inbox, approval center, or duplicate application.

After installation, the extension action is intended to be available while a person browses ordinary HTTP and HTTPS pages. When opened in a compatible browser build, it reads the WebMCP capabilities currently exposed by that page and shows only the minimum current-page context:

- page identity;
- whether WebMCP capability discovery is available;
- the capabilities currently exposed by the page; and
- whether the person should return to the page for a human action.

The website remains the human interface. It owns its forms, protected inputs, review language, decisions, and result presentation. The extension must not copy those controls into browser chrome.

## Responsibility boundary

| Owner | Responsibility |
| --- | --- |
| Website | Business semantics, visible page state, forms, protected inputs, focused review, and human decisions. |
| WebMCP | The page-scoped tool definitions and their registration lifecycle. |
| Agent | Uses only the capabilities currently exposed for the active page and task. |
| Extension | Discovers and displays the current page's reported tool surface. It does not invent tools or execute business actions. |
| Authority and target services | Enforce durable authority and protected execution outside the popup. Their final topology remains `UNKNOWN`. |

## Available everywhere does not mean arbitrary access

The installed extension action should be invocable on ordinary HTTP and HTTPS websites, but capability is browser- and page-provided:

- In a compatible browser, on a WebMCP-enabled page that exposes the listing API, the popup reads `document.modelContext.getTools()` and shows the currently exposed tools.
- On a page with no WebMCP tool surface, the popup says so. It does not infer actions from the DOM or manufacture generic write capabilities.
- Browser-owned and other restricted URLs may prevent extension script injection; the popup reports that boundary truthfully.

The first implementation uses Manifest V3 `activeTab` plus `scripting`. Access begins only when the person invokes the extension on the current tab and ends under the browser's `activeTab` lifecycle. It does not request persistent `<all_urls>` access merely to remain visible.

## Human-authority behavior

The popup is informational and contextual. It must not become an approval queue.

- In-bounds agent work continues through the page's current tools without a popup interruption.
- When a human decision is needed, the website exposes the exact review at the relevant place on the page.
- The popup may indicate that attention is needed and point back to the page, but it does not reproduce the decision.
- When the page changes its tool surface, reopening or refreshing the popup shows the new current capabilities.

## First launchable slice

The initial extension contains:

1. a Manifest V3 action popup;
2. current-tab identity using temporary `activeTab` access;
3. WebMCP discovery using `document.modelContext.getTools()` in the page's main world when the browser exposes that API;
4. a compact list of current capability titles and descriptions;
5. honest unsupported, restricted-page, no-tools, ready, and error states; and
6. no stored browsing history, page content, credentials, decisions, or protected inputs.

The synthetic reference client remains a separate ordinary website fixture. It is not imported by the extension and does not supply product copy or product-domain fields. It must not imitate Chrome, a browser window, or the extension popup; browser chrome belongs to the user's actual browser.

The WebMCP API is still evolving. Passing source checks does not establish compatibility with a particular browser build or third-party page; those are runtime acceptance cases, not inferred properties.

## Non-goals for the browser GUI

- A task-management dashboard
- A docket inbox or receipt archive
- Duplicated website forms or protected inputs
- Generic DOM automation on sites that expose no WebMCP tools
- Persistent all-site page access in the initial extension
- An agent-callable authorization or execution control
- A claim that extension presence makes every website WebMCP-enabled

## Still `UNKNOWN`

This UI decision does not settle durable identity, grant storage, target-side enforcement, execution adapters, signing, cross-device continuity, distribution, jurisdiction- and class-specific formal legal clearance, or independently verifiable receipts. Those remain separate product and release decisions. The bounded name-screening decision and its limitations are recorded in [`../BRANDING_STATUS.md`](../BRANDING_STATUS.md).
