# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 2.x | Yes |
| 1.x | **No — contains known critical vulnerabilities. Upgrade immediately.** |

1.x will not receive fixes. Install a 2.x release. The issues below are already
fixed there; staying on 1.x leaves them in place.

## Reporting a vulnerability

Please report privately through
[GitHub Security Advisories](https://github.com/AgentDeskAI/browser-tools-mcp/security/advisories/new)
rather than opening a public issue. We aim to acknowledge within 72 hours.

Include what the issue is, how to reproduce it, and what an attacker gains.
Proof-of-concept code is welcome and speeds up triage considerably.

## Known vulnerabilities in 1.x

Published as [GHSA-xvrv-w8pg-f25f](https://github.com/AgentDeskAI/browser-tools-mcp/security/advisories/GHSA-xvrv-w8pg-f25f) (CVSS 9.8, critical). A CVE has been
requested through GitHub and will be added here once assigned.

Version 1.2.x and earlier are affected by the following. All are fixed in 2.0.0
by design changes, not patches, which is why 2.0 is a rewrite.

### Remote code execution through the WebSocket endpoint (critical)

The connector bound `0.0.0.0`, applied wildcard CORS, and performed no origin
check or authentication on its WebSocket upgrade. A `path` value taken from a
WebSocket message was interpolated into a shell command:

```
exec(`osascript -e '${appleScript}'`)   // appleScript embedded the caller's path
```

Any web page the user visited — or anyone on the same network — could open the
socket, impersonate the extension, and execute arbitrary commands as the user.
Reported in issues #224, #232 and #233.

**Fixed in 2.0.0 by:** binding loopback only and refusing non-loopback addresses;
requiring a browser-extension `Origin` on the WebSocket upgrade; requiring a
per-run bearer token on the HTTP API; validating the `Host` header; removing the
AppleScript path entirely; and constraining screenshot names to a safe character
set resolved inside a fixed directory.

### Network-wide interception of captured browser data (high)

The extension probed `192.168.0.x`, `192.168.1.x`, `10.0.0.x` and `10.0.1.x`
across ports 3025-3035, and adopted the first host that returned the constant
string `mcp-browser-connector-24x7` — persisting it to settings. That string is a
public identifier in a public repository, not a credential.

Anyone on shared Wi-Fi could run a trivial HTTP server returning it and silently
receive the developer's console output, full request and response bodies, and
screenshots, across restarts.

**Fixed in 2.0.0 by:** removing the network scan. The extension only ever
contacts `127.0.0.1` and `localhost`.

### Unauthenticated data exfiltration and control (high)

With no authentication and wildcard CORS, any visited page could read
`/console-logs` and `/network-success` (including request and response bodies
and headers), force a screenshot, write arbitrary bytes to arbitrary paths via
`/screenshot`, overwrite global settings via `/extension-log`, wipe captured
data, and spawn headless Chrome instances.

`/extension-log` also merged arbitrary keys from an unauthenticated request body
into server settings, which allowed both memory exhaustion and injecting
fabricated log entries that the developer's AI agent would then read and act on.

**Fixed in 2.0.0 by:** token-authenticated API, origin and host validation, an
explicit settings allowlist with clamped ranges, and removal of caller-supplied
filesystem paths.

## Redaction is best-effort, and layered

Credential scrubbing runs twice: in the browser before anything is truncated or
transmitted, and again on the server before storage. The browser pass is the
one that matters most — it means a recognised secret never crosses the socket.

It is pattern-based, so it is **not a guarantee**. It covers credential-bearing
headers, JWTs (including ones cut short by truncation), vendor session and
client identifiers, cloud provider keys, and common `password`/`token` JSON
fields. A bespoke or unrecognised token shape can still get through. Treat
`--no-redact` as strictly for cases where you have decided the captured data is
not sensitive.

Over-redaction is treated as a bug too. A false positive silently destroys the
debugging information this tool exists to provide, so patterns are confirmed
rather than assumed where a cheap check exists — a JWT candidate, for instance,
is verified by decoding its header, because plenty of harmless data is also
base64-encoded JSON.

If you find a shape that leaks, or one that is being redacted when it should not
be, both are worth reporting.

## Design commitments in 2.x

- The connector binds loopback and refuses anything else without an explicit,
  documented override.
- The HTTP API requires a bearer token generated per run and stored in a
  `0600` file. The token is accepted only as an `Authorization: Bearer` header.
  A copy of it in the query string is refused, on HTTP and on the WebSocket,
  because URLs end up in logs.
- The WebSocket accepts `chrome-extension://` (a 32-character Chromium id),
  `moz-extension://` and `safari-web-extension://` (UUIDs), and it requires the
  same bearer token an HTTP client would send. The extension reads that token
  from `POST /.pair`, which answers only those origins; `/.identity` does not
  include it. `--extension-id` limits pairing to one extension. Any `http(s)`
  origin is rejected outright, because a browser sets `Origin` itself and a
  page therefore cannot forge one.
- `--only` and `--exclude` apply to the local HTTP API as well as to the MCP
  tool list. On a shared connector, the filters belong to the process that
  started it.
- State-changing local API calls — reload, screenshot, wipe, settings and tab
  selection — are refused unless the connector was started with
  `--allow-actions` or the DevTools panel has confirmed them. Closing DevTools
  withdraws the confirmation. MCP tools inside the process that embeds the
  connector call it directly and are not gated by this.
- No captured value reaches a shell. Screenshot names are restricted to
  `[A-Za-z0-9._/-]` and resolved inside a fixed directory.
- Chrome's "started debugging this browser" banner is a browser safety
  control. It is intentional, and this project never hides it, suppresses it,
  or documents a setup step that does. Features that can run without the
  debugger do so. When a feature attaches the debugger, the banner stays
  visible for that attachment, and dismissing it stops the attachment.
- Credential-bearing headers and secret-shaped strings are redacted before
  storage, not before display.
- Request bodies are size-limited; log retention is bounded and client-supplied
  limits are clamped.
- The audit browser never reaches link-local or cloud metadata addresses, and
  reaches a loopback or private origin only when the user has it open in a
  connected tab under a local name, or has allowlisted it. Every request it
  makes goes through a checking proxy that connects to the address it vetted,
  and WebRTC is kept off direct UDP. Behind a fake-IP proxy (Clash, mihomo,
  sing-box or Surge in fake-ip mode) every name resolves to 198.18.0.0/15 and
  that proxy picks the real address later, so the check cannot see where a
  name really goes. Such answers are refused, for the audited page and for
  everything it loads, so on such a machine every audit fails with a message
  that names the way out: turn fake-ip mode off while auditing, or start the
  connector with `--audit-allow-private-network`. That flag switches the
  local-reach check off, and then, wherever the proxy's rules connect a name
  directly (rules sending LAN and loopback ranges DIRECT are common), an
  audit, or any page it loads, can reach this machine's services and the LAN
  by name (`127.0.0.1.nip.io:6379`, a LAN host's name), and cloud metadata by
  any name that resolves to it. A tab or `--audit-allow-origin` entry never
  opens the range, because the address says nothing about the destination.

These are covered by regression tests in
`browser-tools-mcp/test/integration/connector-security.test.ts`, which assert
the listener address, the absence of permissive CORS, rejection of page origins
and foreign hosts, and that a path containing shell metacharacters is refused.
