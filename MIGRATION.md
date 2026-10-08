# Migrating from 1.x to 2.0

**Upgrade regardless of what else you want from 2.0: 1.2.x contains a critical
remote code execution vulnerability.** See [SECURITY.md](SECURITY.md).

## What changes for you

### You no longer run a second process

1.x needed three processes: the MCP server, a separate `browser-tools-server`,
and the extension. Forgetting the middle one was the single most common failure.

2.0 embeds the connector in the MCP server. Delete any "start the browser tools
server" step from your setup, scripts or docs.

```jsonc
// Still all you need
{
  "mcpServers": {
    "browser-tools": {
      "command": "npx",
      "args": ["-y", "@agentdeskai/browser-tools-mcp@latest"]
    }
  }
}
```

`@agentdeskai/browser-tools-server` still exists for the case where several MCP
clients share one browser session, but you no longer need it for normal use.

### Reinstall the extension

The extension was rewritten. Remove the old one from `chrome://extensions` and
load the `chrome-extension` directory again. Old and new are not compatible:
the wire protocol, the permissions and the settings all changed.

The extension now requests **fewer** permissions. `<all_urls>` and `tabs` are
gone from the default set; cookie access is optional and granted from the panel.

### Node 22.19 or newer

1.x ran on Node 18. Lighthouse 13 and the current toolchain require Node 22.19+.
The package now declares `engines`, so an unsupported version fails at install
with a clear message instead of at runtime with `fetch is not defined`.

### You do not need to select the panel

In 1.x capture only started once you clicked the BrowserTools panel. In 2.0 it
starts as soon as DevTools is open. The panel is for settings and status.

## Tool changes

| 1.x | 2.0 |
| --- | --- |
| `getConsoleLogs`, `getConsoleErrors` | Same names, now take `keywords`, `limit`, `offset` |
| `getNetworkLogs`, `getNetworkErrors` | Same names, now take `urlKeywords`, `bodyKeywords`, `limit`, `offset` |
| `takeScreenshot` | Now returns the **image itself** plus the saved path, instead of the string "Successfully saved screenshot" |
| `getSelectedElement`, `wipeLogs` | Unchanged |
| `runAccessibilityAudit`, `runPerformanceAudit`, `runSEOAudit`, `runBestPracticesAudit` | Same names; reports are restructured (see below) and accept an optional `url`. A `url` on localhost or a private network is audited only while that origin is open in a connected tab, or is allowlisted with `--audit-allow-origin`; link-local and cloud metadata addresses are never audited |
| `runDebuggerMode`, `runAuditMode`, `runNextJSAudit` | **Removed as tools.** They returned static text and cost context on every request. They are now MCP *prompts*: `debuggerMode`, `auditMode`, `nextjsSeoAudit` |
| — | New: `getPageInfo`, `getConnectionStatus`, `refreshBrowser`, `getBrowserStorage`, `listBrowserTabs` |

Every tool now declares an MCP output schema, so results arrive as structured
data rather than prose. Read-only tools are annotated `readOnlyHint`, which lets
clients auto-approve them.

### Audit report shape

Reports are flatter and consistently shaped across all four categories:

```jsonc
{
  "category": "accessibility",
  "score": 72,                       // 0-100, or null
  "metadata": { "url": "...", "timestamp": "...", "lighthouseVersion": "13.4.1" },
  "summary": { "failed": 4, "passed": 1, "manual": 1, "informative": 1, "notApplicable": 1 },
  "issues": [                        // failing audits, heaviest first
    {
      "id": "color-contrast",
      "impact": "critical",          // critical | serious | moderate | minor
      "details": { "items": [...], "omittedItems": 0 }
    }
  ],
  "metrics": { }                     // Core Web Vitals, performance only
}
```

`omittedItems` tells you how many detail rows were withheld to keep the payload
small. Critical issues are never truncated.

## Behaviour changes worth knowing

- **Credentials are redacted.** `Authorization` and `Cookie` headers, JWTs,
  cloud keys and vendor tokens become `[REDACTED]` before storage. A value
  reading `[REDACTED]` is this tool protecting you, not your app misbehaving.
  `--no-redact` disables it if you genuinely need raw values.
- **Headers are off by default,** independently for requests and responses.
- **Storage values are withheld** unless you pass `includeValues: true`.
- **Auto-paste into Cursor is gone.** It existed because screenshots could not
  reach the model; they now do. It was also the mechanism behind the RCE.
- **Newest logs win.** When a response exceeds the character budget, 1.x
  returned the *oldest* entries and stopped at the first oversized one. 2.0
  returns the newest and never lets one large entry hide the rest.
- **Network capture starts when DevTools opens.** Reload the page to capture a
  full page load.

## Configuration

| 1.x | 2.0 |
| --- | --- |
| `PORT` | `BROWSER_TOOLS_PORT` or `--port` |
| `SERVER_HOST` (defaulted to `0.0.0.0`) | `BROWSER_TOOLS_HOST` or `--host`, loopback only |
| Screenshot path set from the extension panel | `BROWSER_TOOLS_SCREENSHOT_DIR` or `--screenshot-dir` |
| — | `--only` / `--exclude` to control which tools are exposed |
| — | `--doctor` to diagnose a broken setup |
| — | `--verbose` to watch capture as it happens |

## If something is wrong

Run `npx @agentdeskai/browser-tools-mcp --doctor`. It reports your Node version,
whether the connector started, whether the extension is connected, and whether
the screenshot directory is writable, with a suggested fix for each problem it
finds.
