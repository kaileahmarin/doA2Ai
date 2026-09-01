# Current-page browser extension

This is the name-neutral product GUI: a thin Manifest V3 popup for the website currently open in the active tab.

It does one job. When the person opens the extension in a compatible browser, it uses temporary `activeTab` access to call `document.modelContext.getTools()` in the page's main world and shows the current WebMCP capabilities. It stores no browsing history, page content, credentials, decisions, or protected inputs.

The website remains the human interface. The extension does not reproduce website forms or execute page tools.

## Load the local build

1. Open `chrome://extensions` in a compatible Chrome build.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `extension` directory.
5. Pin **Current Page** if you want the action visible in the toolbar.

After installation, the action can be opened on ordinary HTTP and HTTPS pages. Actual tool listing requires a browser build and page that expose the WebMCP listing API. Browser-owned and other restricted pages do not allow script injection. Pages that expose no WebMCP tools show an honest empty state.

The source has automated checks, but unpacked installation and current-browser behavior remain **NOT PROVEN** until runtime acceptance is performed.

## Local visual preview

From the project root, run `npm.cmd run ui:preview`, then open `http://127.0.0.1:4175/`. The preview uses sample page metadata and the real popup modules. It does not install the extension or establish browser interoperability.

## Permissions

- `activeTab`: temporary access after the person invokes the extension.
- `scripting`: runs the bounded capability-discovery function in the current page's main world.

The initial build requests no persistent host access and makes no network requests.
