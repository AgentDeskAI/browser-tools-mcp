# Changelog

## Unreleased

- **Audits run on current stable Chrome.** Lighthouse is 13.6 and
  chrome-launcher is 1.2.2. The audit browser lets Chrome pick its debugging
  port, and the end-to-end suite loads the extension in Chromium 156.
- **Non-scriptable pages are reported the same way everywhere.** `chrome://`,
  DevTools, `view-source:`, the Chrome Web Store, extension pages, and the
  built-in PDF viewer come back as metadata only (`access: "metadata-only"`,
  "metadata only, can't read or act"). Navigation to those pages is refused.
  An http(s) PDF can still load, and is then reported as not scriptable. Page
  info and the tab list carry the same fields. Screenshot, storage, console,
  network, and audits on those pages return that result instead of an empty
  success.
- **Tab awareness without the debugging banner.** `listTabs`, `readTab`,
  `navigateTab`, `softClick`, and `softType` use `chrome.tabs` and
  `chrome.scripting`. They do not attach the debugger and do not change focus.
  `chromeTabId` from `listTabs` is separate from the DevTools-connected `tabId`
  used by `listBrowserTabs`. The tab list does not claim to see every open tab.
  Background navigation stays in the visible window. Soft click and type report
  `worked` or `needs a real gesture`.

## 2.0.5

The `browser-tools` CLI. The packages published to npm as 2.0.4 were
hardening only: that publish was cut from 936272d, which is the local API
hardening and the capability gates in the section below, and it does not
include this command.

- **`browser-tools` calls the same tools as the MCP server.** The binary
  ships in `@agentdeskai/browser-tools-mcp`. A command is the tool name and
  one JSON object of arguments
  (`browser-tools getConsoleLogs '{"limit":20}'`).
  `browser-tools resource <name> <scope>` reads the same resources
  (`console-history`, `network-history`, `network-har`, `screenshot`,
  `audit-report`). Connector flags match `browser-tools-mcp`, except
  capability gating: the CLI takes `--allow-actions` (argv only), which maps
  to the connector's input policy, and it rejects `--allow-eval` and
  `--allow-input`.
- **`navigateBrowser` loads a URL in an existing tab without focusing it or
  attaching the debugger.** The extension service worker calls
  `chrome.tabs.update` with `active: false`. Pass the `tabId` of a tab that
  has DevTools open (`listBrowserTabs`). It needs the session popup switch
  and `--allow-input` on `browser-tools-mcp`, or `--allow-actions` on the
  CLI. Local origins are allowed by default; other http(s) origins need
  `--allow-input-origins`.
- `@agentdeskai/browser-tools-server` now requires
  `@agentdeskai/browser-tools-mcp` `^2.0.5`.

## 2.0.4

Low-severity hardening of the local connector, and the test runner is now Vitest 5.

- **The token is a bearer token.** The HTTP API and the extension WebSocket
  accept it from `Authorization: Bearer` or, for the extension, a WebSocket
  subprotocol. A token in the URL is refused. The extension collects it from
  `POST /.pair`, which answers only a real browser-extension origin
  (`chrome-extension://` with a Chromium id, or `moz-extension://` /
  `safari-web-extension://` with a UUID). `/.identity` still does not include
  it. `--extension-id` limits pairing and the extension socket to one
  extension.
- **`--only` and `--exclude` apply to the local API**, not only to the MCP tool
  list. A shared connector enforces the filters it was started with.
- **State-changing local API calls are refused by default.** Reload,
  screenshot, wipe, settings changes and tab selection need `--allow-actions`
  or the "Allow state-changing calls" checkbox in the BrowserTools panel.
  Closing DevTools withdraws the confirmation. Tools in the process that
  embeds the connector are not gated by this.
- **1.x is unsupported.** README and SECURITY.md tell anyone still on it to
  upgrade. The vulnerabilities fixed in 2.0 are not patched on 1.x.
- **Script evaluation and input default off (#251).** `--allow-eval` and
  `--allow-input` are process flags with no environment-variable form.
  Navigation, soft input, and real input share an origin allowlist that is
  local by default (`--allow-input-origins`, `--exclude-origins`). The
  DevTools panel switch covers real input and script evaluation. A
  session-scoped popup switch, also default off, covers page actions that do
  not use DevTools. The extension re-reads the tab URL before a decision.
  Nothing here hides the debugger banner. These gates are in the 2.0.4 npm
  packages; the `browser-tools` CLI that sits on top of them is 2.0.5.

Vitest 5 is a dev dependency. Node 22.12 or newer is required to run the tests,
which the existing Node 22.19 floor already satisfies.

## 2.0.3 — Security

Fixes a server-side request forgery in the four Lighthouse audit tools
(`runAccessibilityAudit`, `runPerformanceAudit`, `runSEOAudit`,
`runBestPracticesAudit`), CWE-918, present in 2.0.0 through 2.0.2.
Advisory: GHSA-fm7v-38h4-4q7w.

The tools accept a `url` and audited it in a headless Chrome on the user's
machine after checking only that the scheme was http or https. A caller — in
practice a model acting on prompt-injected page content — could point that
browser at loopback services, the LAN or a cloud metadata endpoint, and the
stored report (`browser-tools://audit/{reportId}`) handed the rendered page
back as its `final-screenshot`.

- **Audits no longer reach link-local, cloud metadata, or unvouched loopback
  and private addresses.** Link-local and metadata addresses (169.254.0.0/16,
  `metadata.google.internal`, AWS IMDS over IPv6, Alibaba, and the rest) are
  never audited, in any spelling (Azure's WireServer at 168.63.129.16, which
  sits in public address space, included): IPv4-mapped, IPv4-compatible and
  IPv4-translated IPv6, NAT64, 6to4, decimal, hex and octal forms are all
  classified the same way. Every address on this machine's own network
  interfaces counts as this machine, so a service bound to `0.0.0.0` or `::`
  is not reachable through the machine's LAN or global IPv6 address either.
  Pages on localhost or a private network are audited only while that origin
  is open in a connected tab (the normal dev-server flow keeps working), or
  when allowlisted. A tab vouches only for
  a local name — an IP address, `localhost`, a single-label name, or a name
  under `.test`, `.local`, `.internal`, `.lan`, `.home.arpa` and the like — so
  a public site the user has open cannot rebind its own name to a LAN address
  and have that audited. A public name that points at a local address on
  purpose (`lvh.me`, `nip.io`) needs `--audit-allow-origin`.
- **Every request the audit browser makes is checked as it happens.** The
  browser runs behind an in-process proxy that resolves and classifies each
  request — redirects, iframes, fetches and websockets included — and
  connects to the address it vetted, so a public page cannot redirect or frame
  its way inside, and a rebinding name cannot change address after the check.
  Lookups fail closed. WebRTC is kept off direct UDP, so it cannot go around
  the proxy either.
- **A local page reaches only the local origins vouched for.** Auditing
  `http://localhost:3000` lets that page load `localhost:3000` (and
  `127.0.0.1:3000` or `[::1]:3000`, either of which the name may reach) and
  the other origins open in a tab or allowlisted, not every loopback and
  private address, so a dev server's open redirect cannot carry the audit to
  another service. An address, or a `*.localhost` name, vouches for itself
  alone: a service bound only to `[::1]:3000` is not the one on
  `127.0.0.1:3000`, and a Host-routing proxy serves another site under each
  name. A page whose API runs on another local port loads it once that port
  is open in a tab or passed to `--audit-allow-origin`. A public page loads
  nothing local.
- **Fake-IP answers are refused.** Behind a fake-IP proxy (Clash, mihomo,
  sing-box or Surge in fake-ip mode) every name resolves to 198.18.0.0/15 and
  the proxy picks the real address later, so where a name goes cannot be
  checked, and loopback or LAN services would be reachable by name. Audits
  refuse such answers, for the audited page and everything it loads, and the
  error names the way out: turn fake-ip mode off while auditing, or pass
  `--audit-allow-private-network`, which gives up checking local reach (see
  SECURITY.md). No tab or `--audit-allow-origin` entry opens the range.
- New flags `--audit-allow-origin <o,o>` and `--audit-allow-private-network`
  (environment: `BROWSER_TOOLS_AUDIT_ALLOW_ORIGINS`,
  `BROWSER_TOOLS_AUDIT_ALLOW_PRIVATE_NETWORK`) for audits of local pages that
  are not open in a tab. Even with private access allowed, link-local and
  metadata addresses stay blocked, and so do the connector's own port and
  the DevTools and checking-proxy ports of every running audit, under any
  name. They apply to the process
  that starts the connector (`browser-tools-connector --help` lists them); one
  that attaches to a running connector warns that they are ignored.
- URLs with embedded credentials are rejected.
- Audits now connect directly rather than through a system, PAC or
  `HTTP(S)_PROXY` proxy. Handing requests to an outside proxy would let it
  resolve names and reach addresses the audit policy never checked. On a
  network where direct connections are blocked, audits of public sites fail.
- `@agentdeskai/browser-tools-server` is affected through its dependency and
  now requires `@agentdeskai/browser-tools-mcp` `^2.0.3`.

If you cannot upgrade: exclude the audit tools with
`--exclude runAccessibilityAudit,runPerformanceAudit,runSEOAudit,runBestPracticesAudit`,
and do not run the server on a host with an IMDSv1 metadata service.

The session file written by the embedded connector reported version 2.0.0
regardless of the installed version; it now reports the real one. An audit
requested with a `tabId` could audit another tab: through a shared connector
the `tabId` was dropped, and a tab that had not reported its page yet fell back
to the current one. It now audits the named tab, or says it cannot yet. An
audit with no `tabId` took the page of whichever tab last reported while
current, even after another tab was selected; it now audits the current tab.

Thanks to @beardthelion for reporting.

## 2.0.2

Five defects, all found by writing the 2.1 capability specifications rather
than by anything failing. Four were invisible in normal use, which is why they
survived the rewrite.

- **HAR exports reported every request as starting when it finished.** The
  capture stamps `timestamp` at `onRequestFinished`, and the HAR builder used
  that for `startedDateTime`, so a 2-second request appeared instantaneous at
  the wrong moment. Requests now carry `startedAt`, taken from the DevTools
  entry's own start time, and fall back to finish-minus-duration. Anything
  reading a HAR — including Chrome's Network panel — was being misled.
- **Reads came back in arrival order rather than event order.** The store keeps
  entries in the order the connector received them, and telemetry is flushed in
  100ms batches per tab and buffered up to 1000 entries while the socket is
  down, so arrival and event order genuinely diverge. Queries slice the tail as
  "the newest" — which could return the wrong entries entirely, and interleave
  two tabs wrongly on an `allTabs` read. Reads are now ordered by event time.
- **`logLimit` defaulted to 50 entries per category per tab**, which is less
  than a single real page load. Anything reading back over a session was
  silently clipped. The default is now 500; the range is unchanged.
- **The selected element was truncated in the page but never scrubbed there.**
  Every console and network value goes through `scrubAndTruncate`, which scrubs
  first; the selected element was sliced inside the page and sent as-is. The
  server still scrubbed on arrival, so nothing unredacted reached the model,
  but it crossed the socket unscrubbed, and truncating first is precisely the
  ordering that hid a token from the pattern meant to catch it — the bug 2.0.0
  fixed everywhere else. Now sanitised in the browser, scrub before truncate.
- **Audits ran one device and reported another.** `formFactor` and
  `screenEmulation` were set but `throttling` and `emulatedUserAgent` were not,
  so a desktop audit ran a desktop viewport under Lighthouse's default mobile
  Slow-4G throttling while identifying as a phone. `metadata.device` was
  hardcoded to `"desktop"` regardless. Flags now come from Lighthouse's own
  presets so all three agree, and the report names the device it simulated.

Lighthouse's device presets are loaded on demand: importing them eagerly cost
about 30ms at startup, on the path that answers `initialize`.

## 2.0.1

Metadata only — no code changes. `npx @agentdeskai/browser-tools-mcp@latest`
behaves identically to 2.0.0.

- Added `mcpName` to `package.json`. The MCP Registry verifies that a listed
  server actually owns the npm package behind it, and for npm packages that
  proof is this field; without it the listing cannot be published.
- `server.json` moved to the current `2025-12-11` schema. Its description was
  over the registry's 100-character limit, which validation caught.

## 2.0.0

A rewrite. See [MIGRATION.md](MIGRATION.md) to upgrade and [SECURITY.md](SECURITY.md)
for the vulnerabilities this release fixes.

### Security

- **Fixed remote code execution** ([GHSA-xvrv-w8pg-f25f](https://github.com/AgentDeskAI/browser-tools-mcp/security/advisories/GHSA-xvrv-w8pg-f25f), CVSS 9.8). A caller-supplied path arriving over an
  unauthenticated WebSocket was interpolated into an `osascript` shell command.
  The AppleScript path is gone; screenshot names are restricted and resolved
  inside a fixed directory. (#224, #232, #233)
- **Stopped binding every network interface.** The connector binds `127.0.0.1`
  and refuses non-loopback addresses without an explicit override. It previously
  defaulted to `0.0.0.0`.
- **Removed the extension's local network scan.** It probed private IP ranges
  and adopted any host answering with a public constant, which let anyone on the
  same network receive captured logs and screenshots.
- **Added authentication.** The HTTP API requires a per-run bearer token stored
  `0600`; the WebSocket accepts only browser-extension origins; `Host` is
  validated against DNS rebinding; wildcard CORS is gone.
- **Added credential redaction.** Credential-bearing headers and secret-shaped
  strings are scrubbed before storage. Headers are off by default. (#228)
- **Allowlisted settings.** An unauthenticated request body could previously be
  spread over server settings, allowing memory exhaustion and log injection.

### Fixed

- **Credentials could survive redaction when they were longer than the
  truncation limit.** Found by manual testing against a live
  Clerk-authenticated app: a JWT and several session identifiers reached the
  store intact. Two causes, both fixed. The extension truncated strings before
  sending, so a token longer than `stringSizeLimit` arrived as a lone header
  segment that no longer matched the JWT pattern; and there was no pattern for
  vendor session identifiers at all, which appeared in request URLs as well as
  response bodies. Scrubbing now happens **in the browser, before truncation**,
  so secrets no longer cross the socket at all, and the server keeps its own
  pass as defence in depth.
- **A browser that is found but will not start now explains itself.** Lighthouse
  surfaced that as `connect ECONNREFUSED 127.0.0.1:57529`, which says nothing.
  The error now names the browser and its path, keeps the underlying cause, and
  suggests a fix — including the ad-hoc-signing repair when the browser is a
  Playwright-downloaded Chromium, which macOS sometimes refuses to launch.
- **A stale `CHROME_PATH` no longer costs you every audit.** If it points at a
  browser that is not there — uninstalled since, or a path from another machine
  — the connector now warns and looks for another browser, rather than failing.
- **An installed Google Chrome is no longer passed over.** `chrome-launcher`
  locates browsers through Spotlight on macOS, which is unavailable in
  restricted environments, with indexing off, or for an install too recent to
  have been indexed. Stock Chrome was missing from the fallback list on the
  assumption that chrome-launcher would always find it, so a freshly installed
  Chrome lost out to a stale cached Playwright build. Installed browsers now
  come first, cached test builds next, and heavily customised ones like Arc
  last. Windows and Linux Chrome paths are covered too.
- **Audits now work without Google Chrome installed.** `chrome-launcher` only
  looks for Chrome and Chromium, so anyone running Arc, Brave or Edge and
  nothing else lost all four audit tools to "No Chrome installations found",
  with no hint that another browser would do. Any Chromium-based browser can
  serve, so a fallback chain now covers Chromium, Canary, Brave, Edge, Vivaldi,
  Opera and Arc, plus a Chrome for Testing build if one is present. `--doctor`
  reports which browser audits will use, and the error when none is found now
  names what was looked for and how to point at one with `CHROME_PATH`.
- **Redaction no longer destroys base64-encoded data that is not a token.**
  "eyJ" is only base64 for `{"`, so every base64-encoded JSON object starts the
  same way as a JWT. Matching on that prefix turned Clerk profile image URLs
  into `https://img.clerk.com/[REDACTED]`. A candidate is now confirmed by
  decoding its header and looking for the fields only a JWT carries, so
  truncated tokens are still caught and innocent payloads are left alone.
- **A reconnecting background tab no longer steals targeting.** A tab that is
  timer-throttled, misses the heartbeat and reconnects looked identical to a
  user opening DevTools on a new tab, so it silently became the target of
  screenshots and reads. The connector now remembers which tab ids it has seen,
  so only genuinely new tabs take over.
- A tab navigating in the background no longer takes over either.
- A response can only resolve the request it was sent for, on the connection it
  was sent to; previously any tab could answer another tab's request.
- Closing a DevTools window now fails its in-flight requests immediately instead
  of leaving the caller waiting for the full timeout.
- **Screenshots are held to a byte budget.** A viewport capture of visually
  dense content measured 13.3 MB of base64 on a 1440p retina display and
  17.9 MB on an ultrawide — more than a model's context can take, and past the
  10 MB read buffer newer MCP stdio transports enforce, which severs the
  connection. The browser now degrades PNG to JPEG and then downscales until the
  capture fits `screenshotMaxBytes` (3 MB by default, configurable). An image
  that still cannot fit is written to disk and its path returned rather than
  inlined.
- Screenshots carry their real media type end to end, so a capture that fell
  back to JPEG is saved as `.jpg` with JPEG bytes instead of being mislabelled
  `.png`, and the MCP image block reports the correct `mimeType`.
- The connector no longer waits on lingering sockets when shutting down, so its
  port is released promptly instead of staying bound after `close()` resolves.
- Discovery logging no longer corrupts the MCP stdio stream; all diagnostics go
  to stderr. (#239, #103, #183, #159)
- Startup no longer blocks on a sequential 33-second port scan before answering
  `initialize`. (#226, #95, #91)
- Screenshots capture the inspected page through the DevTools protocol, so they
  work with DevTools undocked and never photograph the DevTools window itself.
  (#79, #189, #81)
- Concurrent screenshot requests are correlated by request id instead of
  resolving whichever callback happened to be first. (#81, #130)
- `takeScreenshot` returns the image to the model instead of a bare success
  string. (#200, #52, #181, #111)
- Changing host or port in the panel now reconnects. The old comparison checked
  a value against itself after assignment and was always false.
- The extension answers the server's heartbeat, so dead connections are detected
  instead of being logged as an unhandled message type. (#120)
- A second DevTools window no longer silently steals the connection. (#43)
- Socket errors no longer take down the process — the WebSocket had no `error`
  handler.
- Log queries return the newest entries and no longer let one oversized entry
  hide everything after it.
- Telemetry captured before the connector handshake completes is buffered rather
  than dropped, so page-load activity is not lost.
- `getNetworkErrors` no longer reports success as a tool error.
- Audits fail immediately with an explanation when no page URL is known, instead
  of polling a variable nothing set for 25 seconds.
- Windows drive paths convert correctly on POSIX hosts; the previous
  implementation left the drive prefix in place.
- `stringSizeLimit` now applies to selected-element markup. (#137)

### Added

- **`--verbose` prints each captured entry as it arrives.** Without it the
  connector reports only connect and disconnect, so there was no way to tell a
  working capture from a silent one without querying the API. Output goes to
  stderr, so it is safe to enable on the MCP server without corrupting the
  JSON-RPC stream, and values are printed after redaction.
- **Large payloads are MCP resources now, not inlined text.** Full console and
  network history, network traffic as a HAR 1.2 file, captured screenshots, and
  the unabridged Lighthouse result behind an audit summary are all readable at
  `browser-tools://…` URIs. Tools attach a `resource_link` — when a log read was
  cut short, alongside every network read for the HAR, and always for a
  screenshot, which is the only route to one too large to inline. Only the 20
  most recent full audit reports are kept on disk.
- **Multi-tab support.** Every tab with DevTools open is tracked separately,
  telemetry is attributed to the tab that produced it, and retention is per tab
  so a noisy page cannot evict a quiet one's history. New `listBrowserTabs`
  tool; every other tool takes an optional `tabId`, and the log tools take
  `allTabs`. Results carry `tabId`, `url` and `otherTabs` so a wrong-tab answer
  is visible rather than silent. No extension change is required — it already
  reports its tab id.
- Single-process operation: the MCP server embeds the connector. No second
  terminal.
- `--doctor` reports Node version, connector state, extension connection and
  screenshot writability, with a fix for each problem found.
- `getPageInfo`, `getConnectionStatus`, `refreshBrowser` (#185, #99, #196, #57)
  and `getBrowserStorage` (#49) tools.
- Keyword filtering and `limit`/`offset` paging on all log tools. (#218, #205)
- Tool annotations and MCP output schemas on every tool. (#219)
- `--only` and `--exclude` to control which tools are exposed. (#71, #72)
- Guidance moved from static "tools" to MCP prompts: `debuggerMode`,
  `auditMode`, `nextjsSeoAudit`.
- A console capture mode that wraps the page's console instead of attaching the
  debugger — no "started debugging" banner, and no dependency on
  `chrome.debugger`, which is what a Firefox port would need. Firefox itself is
  unverified: the extension is built for it but has never been run there. (#115)
- 400 tests: unit, integration, and end-to-end suites that load the real
  extension into a real Chromium and assert the whole capture path, drive the
  full MCP client -> server -> connector -> extension -> page chain, run real
  Lighthouse audits, exercise the shared-connector attach path over HTTP, drive
  the DevTools panel UI in the real extension origin, and cover the injected
  console-capture mode used where chrome.debugger is unavailable.
- `engines: node >=22.19`, so an unsupported runtime fails at install with a
  clear message. (#18, #2, #15)

### Changed

- Node 22.19 is now the minimum.
- `@modelcontextprotocol/sdk` 1.5 → 1.30; Express 4 → 5; Lighthouse 11 → 13;
  `ws` 8.18 → 8.21. `npm audit` reports zero vulnerabilities, down from 22
  across the two packages.
- Dropped `body-parser`, `node-fetch`, `llm-cost` and `puppeteer-core`; Express
  and Node provide the first two, the third was unused, and Lighthouse is
  driven through `chrome-launcher` directly.
- The extension has no background service worker. Everything runs in the
  DevTools page, which removes the Manifest V3 worker eviction that caused
  "Could not establish connection. Receiving end does not exist." (#147, #141, #184)
- The extension requests fewer permissions: `<all_urls>` and `tabs` are no
  longer in the default set, and cookie access is optional.
- Capture starts when DevTools opens, rather than when the panel is selected.
- Auto-paste into Cursor removed — screenshots reach the model directly now, and
  auto-paste was the mechanism behind the RCE.


## 1.2.1 and earlier

See the repository history. **These versions are affected by the critical vulnerabilities described in
[SECURITY.md](SECURITY.md) and [GHSA-xvrv-w8pg-f25f](https://github.com/AgentDeskAI/browser-tools-mcp/security/advisories/GHSA-xvrv-w8pg-f25f), and should not be used.**
