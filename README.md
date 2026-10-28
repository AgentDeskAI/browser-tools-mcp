# BrowserTools MCP

Give your AI coding agent eyes on the Chrome session you already have open:
console, network, the selected element, screenshots, and Lighthouse. You stay
logged in, on the page you were already on. It works with any MCP client:
Cursor, Claude Code, Windsurf, Cline, Zed, Gemini CLI, and others.

`browser-tools` mirrors those MCP tools from the shell. Separate tab tools can
list tabs, read a page, navigate in the background, and soft-click or
soft-type. They stay off until you allow them. They do not attach the debugger
and do not steal focus. A soft click is not a trusted user gesture.

---

## Why this instead of a CDP-based server

Tools like Chrome DevTools MCP and Playwright MCP drive a *fresh, automated*
browser. That is the right choice for writing tests. It is the wrong choice for
debugging the app you are actually looking at, because since Chrome 136 the
browser refuses remote debugging on your default profile — the one holding your
logins. So you end up recreating your auth state in a throwaway profile before
you can debug anything.

BrowserTools attaches to the session you are already in, through a DevTools
extension. You stay logged in, on the page you were already on, and your agent
reads what you see. It also reports Lighthouse-grade performance, accessibility
and SEO data, which the automation-first servers do not.

## Install

Two pieces: an MCP server (one command) and a Chrome extension.

### 1. Point your MCP client at the server

```json
{
  "mcpServers": {
    "browser-tools": {
      "command": "npx",
      "args": ["-y", "@agentdeskai/browser-tools-mcp@latest"]
    }
  }
}
```

On Windows, if your client cannot find `npx`, use `"command": "cmd"` with
`"args": ["/c", "npx", "-y", "@agentdeskai/browser-tools-mcp@latest"]`.

Requires **Node 22.19 or newer**. Check with `node --version`; if you use nvm or
asdf, make sure your editor inherits the same version.

### 2. Load the Chrome extension

1. Download or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Choose **Load unpacked** and select the `chrome-extension` directory.

That is the whole setup. **There is no second server to start** — the MCP server
runs the connector itself.

Coming from 1.x? See [MIGRATION.md](MIGRATION.md). How captured data is handled
is in [SECURITY.md](SECURITY.md).

### 3. Use it

Open Chrome DevTools (F12) on the page you want the agent to see. Capture
starts as soon as DevTools is open. The **BrowserTools** panel is for settings
and status. Ask for console errors, a network call, the element selected in
the Elements panel, a screenshot, or a Lighthouse audit.

The same tools are on the `browser-tools` command, which ships in this
package. Pass the tool name and one JSON object of arguments:

```
npx -y --package @agentdeskai/browser-tools-mcp@latest browser-tools getConsoleLogs '{"limit":20}'
```

`listTabs`, `readTab`, `navigateTab`, `softClick`, and `softType` work on tabs
that do not have DevTools open. Turn on the extension popup switch first.
Background navigation and soft click or type also need `--allow-input` on
`browser-tools-mcp`, or `--allow-actions` on `browser-tools`. They do not
attach the debugger and do not bring a tab or window to the front. A soft
click is not a trusted user gesture. The result is `worked` or `needs a real
gesture`.

Not working? Run `npx @agentdeskai/browser-tools-mcp --doctor`, which reports
exactly which piece is missing.

To watch capture happen live — useful when checking a fresh install — start the
connector with `--verbose`:

```
npx @agentdeskai/browser-tools-server --verbose
```

```
· console error tab 42 Uncaught TypeError: total is not a function
· network 500 POST tab 42 https://myapp.local/api/pay (1310ms)
```

Without it the connector only reports connect and disconnect, so a working
setup and a silent one look the same.

## Tools

| Tool | What it does |
| --- | --- |
| `getConsoleLogs` | Console output, filterable by keyword with paging |
| `getConsoleErrors` | Error-level output and uncaught exceptions |
| `getNetworkLogs` | XHR/fetch requests with status, timing and bodies |
| `getNetworkErrors` | Only failed and 4xx/5xx requests |
| `getSelectedElement` | The element selected in the Elements panel |
| `getPageInfo` | Which page the browser is currently on |
| `getConnectionStatus` | Whether the extension is connected, and capture counts |
| `listBrowserTabs` | Tabs with DevTools open, addressed by a DevTools-connected `tabId` |
| `listTabs` | Tabs `chrome.tabs` returns (not every open tab), addressed by `chromeTabId` |
| `readTab` | Headings, excerpt, and a snapshot of a `chromeTabId`, without the debugger |
| `navigateBrowser` | Load a URL in a DevTools-connected tab, without focusing it |
| `navigateTab` | Load a URL in the background from `listTabs`, visible window only |
| `softClick` / `softType` | Soft click or type. Not a trusted user gesture. Result is `worked` or `needs a real gesture` |
| `takeScreenshot` | Screenshot returned **as an image**, plus its file path |
| `refreshBrowser` | Reloads the inspected tab |
| `getBrowserStorage` | localStorage, sessionStorage and cookies (values gated) |
| `wipeLogs` | Clears captured telemetry before a clean reproduction |
| `runAccessibilityAudit` | Lighthouse accessibility audit |
| `runPerformanceAudit` | Lighthouse performance audit with Core Web Vitals |
| `runSEOAudit` | Lighthouse SEO audit |
| `runBestPracticesAudit` | Lighthouse best-practices audit |

Three prompts ship alongside them — `debuggerMode`, `auditMode` and
`nextjsSeoAudit` — giving your agent a systematic workflow instead of a wall of
static text in every tool listing.

All tools declare MCP output schemas, so clients receive structured data rather
than prose they have to parse, and read-only tools are annotated as such so
clients can auto-approve them safely.

### Tabs without DevTools

`listTabs`, `readTab`, `navigateTab`, `softClick`, and `softType` use
`chrome.tabs` and `chrome.scripting`.

`chromeTabId` comes from `listTabs`. `tabId` on the DevTools tools comes from
`listBrowserTabs`. Pass each id only to the tool that issued it.

`listTabs` reports the tabs `chrome.tabs` returns in the windows it returns.
Other Arc Spaces, Little Arc, pinned favorites, split-view partners, and slept
tabs may be missing. Incognito is skipped. This is not every open tab.
Background navigation stays in the visible window, and a tab in another window
is refused.

`listTabs` and `readTab` need the popup switch. Navigation and soft input also
need `--allow-input` on `browser-tools-mcp`, or `--allow-actions` on
`browser-tools`. Local origins are allowed by default; name any other http(s)
origin with `--allow-input-origins`. An asleep tab is reported and not
reloaded. A soft action says `worked` or `needs a real gesture`.

### Several tabs at once

Every tab with DevTools open is tracked separately. Telemetry is attributed to
the tab that produced it, and retention is per tab, so a chatty page cannot push
out the history of the one you care about.

Tools act on the **current tab** — the one you most recently opened DevTools on.
A tab whose connection drops and comes back does not steal that position, which
is what used to make screenshots capture the wrong page. Every result reports
the `tabId` and `url` it came from, plus `otherTabs`, so a wrong-tab answer is
visible rather than silent. To target a specific DevTools-connected tab, call
`listBrowserTabs` and pass its `tabId`. Pass `allTabs: true` to read across
every connected tab.

### Large data stays out of the context window

Whole-history payloads are exposed as MCP **resources** rather than inlined, and
tools link to them with `resource_link` so your agent fetches them only when it
decides to:

| Resource | What it is |
| --- | --- |
| `browser-tools://console/{tabId\|all}` | Every console entry, with no per-call budget |
| `browser-tools://network/{tabId\|all}` | Every captured request, including bodies |
| `browser-tools://har/{tabId\|all}` | The same traffic as a HAR 1.2 file |
| `browser-tools://screenshot/{name}` | A screenshot you captured earlier |
| `browser-tools://audit/{reportId}` | The unabridged Lighthouse result behind a summary |

Log tools attach a link when a read had to be cut short; network reads always
offer the HAR; screenshots always link to the stored image, which is the only
way to see one too large to inline. The last 20 full Lighthouse reports are kept
under `audits/` in the screenshot directory.

The CLI reads the same resources with `browser-tools resource <name> <scope>`
(`console-history`, `network-history`, `network-har`, `screenshot`,
`audit-report`).

### Keeping responses small

Log payloads are the usual cause of a blown context window. Every read tool
takes `limit` and `offset`, and the log tools take keyword filters:

```
getConsoleErrors({ keywords: ["hydration"], limit: 20 })
getNetworkLogs({ urlKeywords: ["/api/"], bodyKeywords: ["quota"], limit: 10 })
```

Results are returned newest-first and always report `total` alongside
`returned`, so an agent knows when it is only seeing part of the picture.

## Privacy and security

This tool captures whatever your browser sees, so it treats that data carefully:

- **Loopback only.** The connector binds `127.0.0.1` and refuses non-loopback
  addresses.
- **The extension stays on loopback.** It does not scan the network for a
  connector.
- **Authenticated.** The HTTP API requires a per-run bearer token. A token in
  the URL is refused. The extension WebSocket requires the same token; the
  extension collects it from a loopback pairing route that answers only a
  browser-extension origin, and `/.identity` does not reveal it. Pass
  `--extension-id` to accept one extension and no others.
- **Credentials are scrubbed** on the way in: `Authorization`, `Cookie` and
  similar headers, plus JWTs, cloud keys and vendor tokens found anywhere in
  captured strings, become `[REDACTED]`.
- **Headers are off by default**, per direction, and storage values are withheld
  unless explicitly requested.
- **Cookie access is an optional permission** you grant from the panel, not
  something the extension holds by default.
- **The debugger banner stays visible** when a tool attaches the debugger.
  Chrome's "started debugging this browser" warning is a safety control, and
  this project never hides it. Tab tools that do not attach the debugger do
  not raise it.
- **Audits stay off your internal network.** An audit accepts a url, and the
  caller may be a model reading untrusted pages. Link-local and cloud metadata
  addresses are never audited. Pages on localhost or a private network are
  audited only while open in a connected tab (or allowlisted with
  `--audit-allow-origin`), and every request the audit browser makes —
  redirects and subresources included — is checked again as it happens. A
  local page may load only the local origins that are open in a tab or
  allowlisted, so if your app calls an API on another local port, open that
  too or allowlist it. Audits connect directly, not through a system proxy.
  Behind a fake-IP proxy (Clash, sing-box, Surge), which hides where names
  really go, audits are refused unless you pass
  `--audit-allow-private-network`; see SECURITY.md.

Report vulnerabilities per [SECURITY.md](SECURITY.md).

## Configuration

Flags. Where a `BROWSER_TOOLS_*` environment variable exists, it matches the
flag. `--allow-input`, `--allow-eval`, `--allow-input-origins`, and
`--exclude-origins` are argv only.

| Flag | Purpose |
| --- | --- |
| `--port <n>` | Connector port (default 3025) |
| `--screenshot-dir <path>` | Where screenshots are written |
| `--only <a,b>` | Expose only these tools, on MCP and on the local API |
| `--exclude <a,b>` | Hide these tools, on MCP and on the local API |
| `--allow-input` | Click, type, navigation, and soft input. Off unless passed. No environment variable. Also permits state-changing local API calls (reload, screenshot, wipe, settings, tab selection); otherwise confirm those in the BrowserTools panel |
| `--allow-eval` | Script evaluation. Off unless passed. No environment variable |
| `--allow-input-origins <o,o>` | http(s) origins where input and navigation are allowed besides local addresses. Argv only |
| `--exclude-origins <o,o>` | http(s) origins that are never acted on. Argv only |
| `--extension-id <id>` | Only this extension may pair and connect |
| `--doctor` | Check the setup and exit |
| `--verbose` | Print each captured entry as it arrives |
| `--host <addr>` | Loopback address to bind (default `127.0.0.1`) |
| `--connect <url>` | Attach to a connector already running elsewhere |
| `--token <t>` | Auth token to use with `--connect` |
| `--no-redact` | Disable credential scrubbing (not recommended) |
| `--audit-allow-origin <o,o>` | Loopback/private origins audits may target or load without an open tab |
| `--audit-allow-private-network` | Let audits reach any loopback/private address except the audit's own ports (not recommended); also needed behind a fake-IP proxy |

`browser-tools` takes `--allow-actions` for the input policy above. It does
not accept `--allow-input` or `--allow-eval`.

MCP tools in the process that embeds the connector call it directly. Reload,
screenshot, and wipe from those tools are not held behind the local API check.
Navigation and soft input still need `--allow-input`, and the tab tools still
need the popup switch.

To share one browser session between several MCP clients, start the connector
once with `npx @agentdeskai/browser-tools-server` and every client will attach to
it automatically. The local API uses the `--only`, `--exclude`,
`--allow-input`, and `--extension-id` of that process. An attached client's
`--only` / `--exclude` still hide tools from that client. Input and audit
flags count on the process that started the connector.

## Known limits

- Network capture starts when DevTools opens. Requests that finished before then
  are not recorded — reload the page to capture a full page load.
- Screenshots are held to a byte budget (`screenshotMaxBytes`, 3 MB by default).
  A capture that would exceed it is re-encoded as JPEG and, if still too large,
  downscaled. A viewport capture of dense content on a high-DPI display can
  otherwise run past 13 MB, which is more than a model's context can take and
  past the read buffer newer MCP stdio transports enforce. If an image still
  cannot fit, it is written to disk and the tool returns the path instead of
  inlining it.
- Console capture defaults to the DevTools protocol, which shows Chrome's
  debugging banner. Switch the panel's capture mode to **Wrap page console**
  to capture the console without attaching the debugger.
- **Firefox is not verified.** The extension is written cross-browser — a
  `browser`/`chrome` shim, `browser_specific_settings`, and a capture mode that
  does not need `chrome.debugger` — but it has never been loaded in Firefox, and
  nothing in the test suite covers it. Screenshots in particular go through the
  DevTools protocol and will not work there. Treat Firefox as unsupported until
  someone has actually run it; a report either way is welcome.
- Audits launch a separate browser and take up to a minute. Any Chromium-based
  browser works — Chrome, Chromium, Brave, Edge, Vivaldi, Opera or Arc — and
  `--doctor` reports which one will be used. Set `CHROME_PATH` to override.
  Arc is supported on a best-effort basis and has not been verified headless.

## Development

```bash
npm install
npm run build
npm test           # unit + integration, no browser required
npm run test:e2e   # real Chromium with the extension loaded (headless)
```

`npm test` runs in seconds. The end-to-end suite launches Chromium with the
extension installed, drives fixture pages, and asserts the whole capture path.
It runs headless; set `HEADED=1` to open a visible window. Run
`npx playwright install chromium` first.

## License

MIT
