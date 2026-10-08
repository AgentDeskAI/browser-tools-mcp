# BrowserTools MCP

Give your AI coding agent eyes on the browser. BrowserTools MCP streams console
output, network activity, screenshots and Lighthouse audits from **your real
Chrome session** — the one already logged into your app — to any MCP-compatible
client: Cursor, Claude Code, Windsurf, Cline, Zed, Gemini CLI, and others.

> **Version 2.0 is a rewrite.** One process instead of three, no unauthenticated
> local server, credentials scrubbed before they leave the browser, and a real
> test suite. If you are coming from 1.x, read [MIGRATION.md](MIGRATION.md) —
> **and upgrade, because 1.2.x has a critical vulnerability.** See
> [SECURITY.md](SECURITY.md).

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

### 3. Use it

Open Chrome DevTools (F12) on the page you want to inspect. Capture begins as
soon as DevTools is open; the **BrowserTools** panel is only for settings and
status. Then ask your agent something like *"check the console for errors"* or
*"run an accessibility audit on this page"*.

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
| `listBrowserTabs` | Every tab with DevTools open, and the id to address it by |
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

### Several tabs at once

Every tab with DevTools open is tracked separately. Telemetry is attributed to
the tab that produced it, and retention is per tab, so a chatty page cannot push
out the history of the one you care about.

Tools act on the **current tab** — the one you most recently opened DevTools on.
A tab whose connection drops and comes back does not steal that position, which
is what used to make screenshots capture the wrong page. Every result reports
the `tabId` and `url` it came from, plus `otherTabs`, so a wrong-tab answer is
visible rather than silent. To target a specific tab, call `listBrowserTabs` and
pass its `tabId` to any tool; pass `allTabs: true` to read across every tab.

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
  addresses. In 1.x it bound `0.0.0.0`, reachable by anyone on your network.
- **The extension never leaves loopback.** 1.x scanned private network ranges
  and adopted whichever host answered with a known string — meaning anyone on
  shared Wi-Fi could receive your logs and screenshots. That scan is gone.
- **Authenticated.** The HTTP API requires a per-run token. The WebSocket
  accepts browser-extension origins only, so a web page you visit cannot
  impersonate the extension.
- **Credentials are scrubbed** on the way in: `Authorization`, `Cookie` and
  similar headers, plus JWTs, cloud keys and vendor tokens found anywhere in
  captured strings, become `[REDACTED]`.
- **Headers are off by default**, per direction, and storage values are withheld
  unless explicitly requested.
- **Cookie access is an optional permission** you grant from the panel, not
  something the extension holds by default.
- **Audits stay off your internal network.** An audit accepts a url, and the
  caller may be a model reading untrusted pages. Link-local and cloud metadata
  addresses are never audited. Pages on localhost or a private network are
  audited only while open in a connected tab (or allowlisted with
  `--audit-allow-origin`), and every request the audit browser makes —
  redirects and subresources included — is checked again as it happens.

Report vulnerabilities per [SECURITY.md](SECURITY.md).

## Configuration

Flags, or the matching `BROWSER_TOOLS_*` environment variables:

| Flag | Purpose |
| --- | --- |
| `--port <n>` | Connector port (default 3025) |
| `--screenshot-dir <path>` | Where screenshots are written |
| `--only <a,b>` | Expose only these tools |
| `--exclude <a,b>` | Hide these tools |
| `--doctor` | Check the setup and exit |
| `--verbose` | Print each captured entry as it arrives |
| `--host <addr>` | Loopback address to bind (default `127.0.0.1`) |
| `--connect <url>` | Attach to a connector already running elsewhere |
| `--token <t>` | Auth token to use with `--connect` |
| `--no-redact` | Disable credential scrubbing (not recommended) |
| `--audit-allow-origin <o,o>` | Loopback/private origins audits may target without an open tab |
| `--audit-allow-private-network` | Let audits reach any loopback/private address (not recommended) |

To share one browser session between several MCP clients, start the connector
once with `npx @agentdeskai/browser-tools-server` and every client will attach to
it automatically.

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
- Console capture defaults to the DevTools protocol, which makes Chrome show a
  "started debugging this browser" banner. Switch the panel's capture mode to
  **Wrap page console** to avoid it.
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
npm run test:e2e   # real Chromium with the extension loaded
```

`npm test` runs in seconds. The end-to-end suite launches a headed Chromium with
the extension installed, drives fixture pages, and asserts the whole capture
path — run `npx playwright install chromium` first.

## License

MIT
