# doA2Ai: beginner walkthrough

Updated: September 1, 2026

This guide is for the current **local prototype** of doA2Ai. It is written for someone who does not work with code every day.

The short version is:

1. Start the local website on your computer.
2. Open it in Chrome.
3. Optionally install the small Chrome add-on that shows what the current page makes available.
4. Review the sample action yourself and choose whether to authorize it.

The current repository does not include a one-click installer or a Chrome Web Store install. The current version runs from the project folder. If the project owner gives you a confirmed live doA2Ai link, you can open that link directly and skip Part 1; the optional Chrome add-on still follows Part 2.

## What you are installing

| Part | What it does | Do you need it? |
| --- | --- | --- |
| Local website demo | Shows the full doA2Ai walkthrough in a browser page | Yes, for the main walkthrough |
| **Current Page** Chrome add-on | Shows the capabilities exposed by the page currently open in Chrome | Optional |
| Popup visual preview | A developer-only preview of the add-on | No |

Important: this version is a demonstration. It uses sample information in your browser's memory. It does **not** log in, connect to an outside service, share a real document, or perform a real external action. Use only the sample data; do not enter passwords, API keys, financial information, or private documents.

## Before you start

You need:

- the doA2Ai project folder, extracted from a ZIP if it was sent to you;
- Windows PowerShell or Windows Terminal;
- Node.js 22 or newer, for the local website;
- Google Chrome 149 or newer, if you want to install the optional add-on.

You can download Node.js from the [official Node.js download page](https://nodejs.org/en/download). After installing it, close and reopen PowerShell before continuing.

You do not need to run `npm install`: the current local demo has no third-party runtime dependencies.

## Part 1: start the local website

### 1. Open a terminal in the project folder

1. Open the doA2Ai project folder in File Explorer.
2. Click the folder path near the top of the window.
3. Type `powershell` and press **Enter**.

A PowerShell window should open already pointed at the doA2Ai folder. The folder should contain names such as `app`, `extension`, `scripts`, and `package.json`.

### 2. Check Node.js

In PowerShell, copy and paste this command, then press **Enter**:

```powershell
node --version
```

You should see a version beginning with `v22` or a higher number. If Windows says that `node` is not recognized, install Node.js, close PowerShell, open a new PowerShell window in the project folder, and try again.

### 3. Start doA2Ai

Copy and paste:

```powershell
npm.cmd run dev
```

Wait for a message saying that doA2Ai is running at:

```text
http://127.0.0.1:4173
```

Keep this PowerShell window open while you use the website. Closing it stops the local website.

### 4. Open the website

Open Chrome and enter this address in the address bar:

```text
http://127.0.0.1:4173/
```

The doA2Ai page should appear. `127.0.0.1` means “this computer”; it is not a public website.

Do not double-click `app\index.html`. Use the local address above so the page is served correctly.

## Part 2: install the optional Chrome add-on

The add-on is called **WebMCP Current Page** (its short name is **Current Page**). It is loaded locally in Chrome as an “unpacked” extension.

### 1. Turn on the browser feature used by the prototype

This step is needed when you want Chrome to expose WebMCP capabilities.

1. In Chrome, open:

   ```text
   chrome://version
   ```

   Confirm that Chrome is version 149 or newer.

2. Open:

   ```text
   chrome://flags/#enable-webmcp-testing
   ```

3. Set the WebMCP testing setting to **Enabled**.
4. Click **Relaunch**.

This is an experimental browser setting. If your Chrome build does not show it, you can still use the local website's simulator, but the add-on may report that WebMCP tools are unavailable.

### 2. Load the add-on

1. Open:

   ```text
   chrome://extensions
   ```

2. Turn on **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. In the folder picker, select the project's **`extension` folder**.

   Select the folder that contains `manifest.json` and `popup.html`. Do **not** select the project root, the `app` folder, or the `preview` folder.

5. Confirm the selection.
6. Optional: click the puzzle-piece icon in Chrome's toolbar and pin **Current Page** so it is always visible.

### 3. Use the add-on

1. Return to the doA2Ai page at `http://127.0.0.1:4173/`.
2. Click the pinned **Current Page** icon, or open it from Chrome's puzzle-piece menu.
3. The popup reads the capabilities exposed by the page and lists them if Chrome can discover them.
4. Click the refresh icon in the popup if you want to read the current page again.

The add-on is deliberately small. It only reports what the current page exposes. It does not approve anything, fill in forms, execute page actions, or replace the human controls on the website.

These results are normal:

- On `chrome://extensions` or another browser-owned page: **Unavailable on this page**.
- On an ordinary page that has not exposed WebMCP tools: **No WebMCP tools** or **No active capabilities**.
- If Chrome can see WebMCP but cannot list its tools: **WebMCP detected** with a browser-capability explanation.
- On the doA2Ai page in a compatible enabled browser: the current page's capabilities should be listed.

## Part 3: use the main doA2Ai walkthrough

The website is the part where you make the human decision. The add-on does not replace this.

### Try the normal successful path

1. On the doA2Ai page, click **Preview bounded preparation**.
2. Wait a few seconds while the local simulator prepares the sample brief.
3. A window titled **Review the exact brief share** should appear. The agent is paused at this point.
4. Read the sample details. The page shows a fictional brief, two scoped sources, a date, a brief length, and a sharing audience.
5. If you want, change:

   - **Brief length:** Concise (600 words), Standard (900 words), or Detailed (1,200 words).
   - **Share audience:** Research collaborators or Project stewards.

6. Leave the synthetic collaborator-note reference selected.
7. Tick the checkbox confirming that the terms are accurate and that you authorize this exact fixture state.
8. Click **Authorize exact action**.
9. Wait for the local result. The successful result is labeled **Verified match** or **Local fixture complete** and **Exact match**.
10. If you want a copy of the result, click **Export receipt**. This downloads a local JSON receipt. Click **Done** when finished.

The word “share” describes the sample scenario only. Nothing is sent anywhere.

### Try “Not now”

When the review window is open, click **Not now**. Nothing is authorized. The task remains waiting for your review, and you can choose **Review focused docket** to open it again.

### Try “Deny”

1. Refresh the doA2Ai page to start a fresh local task.
2. Click **Preview bounded preparation**.
3. When the review window appears, click **Deny**.

The receipt should say **Nothing was executed** and **Not attempted**.

### Try the protected mismatch demonstration

This path shows what happens when the proposed state changes after you approve it.

1. Refresh the page to start a fresh local task.
2. Open **Demo controls** near the top of the page.
3. Turn on **Change the candidate after approval**.
4. Click **Preview bounded preparation**.
5. Review the brief, tick the confirmation box, and click **Authorize exact action**.

The local simulator should detect a mismatch and show **Execution blocked**, **No external action**, and a message that a new authorization is required.

## If something does not work

| What you see | What to do |
| --- | --- |
| `node` or `npm.cmd` is not recognized | Install Node.js 22 or newer, close PowerShell, open a new one in the project folder, and try again. |
| The page will not open | Check that the PowerShell window running `npm.cmd run dev` is still open. Use `http://127.0.0.1:4173/`, not a `C:\...` file path. |
| PowerShell says the address is already in use | Run `$env:BOUNDED_DEMO_PORT = "4174"` and then `npm.cmd run dev`. Open `http://127.0.0.1:4174/`. |
| Chrome says the add-on is unavailable on this page | You are probably on a browser-owned page. Return to the ordinary doA2Ai page and open the add-on there. |
| The add-on says there are no WebMCP tools | Reload the doA2Ai page, confirm the Chrome version and WebMCP testing setting, and open the popup again. The local simulator can still run even when browser WebMCP discovery is unavailable. |
| Chrome will not load the add-on | In **Load unpacked**, select the folder named `extension`—the one containing `manifest.json`—not the project root. |
| The review button is disabled | Wait for preparation to finish. If the review window is open, tick the confirmation checkbox before trying **Authorize exact action**. |

## When you are finished

- To stop the local website, click the PowerShell window and press **Ctrl+C**.
- To remove the add-on, open `chrome://extensions`, find **WebMCP Current Page**, and click **Remove**.

## Current limitations

This version keeps its task and authorization state in browser memory. Refreshing the page starts over. It has no login, account connection, backend, durable storage, real sharing service, or external executor. The local checks and simulator demonstrate the intended safety behavior, but they do not by themselves prove compatibility with every Chrome build or real third-party website.

If someone asks you to run `npm.cmd run ui:preview` and open `http://127.0.0.1:4175/`, that is only the add-on's visual preview. It does not install the add-on and does not prove that Chrome can discover WebMCP tools.
