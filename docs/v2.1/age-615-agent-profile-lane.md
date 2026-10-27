# AGE-615: separate agent Chrome profile

[AGE-615](https://linear.app/agentdesk/issue/AGE-615). Decision note. No
lane is added in v2.1.

## Decision

Point long real-input jobs at an existing isolated browser. Do not build a
second automation stack into Browser Tools for v2.1.

The tool to point at is Playwright MCP's isolated context, or Chrome
DevTools MCP aimed at a profile the person created for the agent. Chrome
DevTools MCP `--autoConnect` is the wrong target: it drives Ted's own
browser and shows that product's automation bar there.

Browser Tools stays the way in to Ted's signed-in browser (AGE-584, and
AGE-614 when a short trusted batch is worth the banner).

## When to use which

| Situation | Use |
| --- | --- |
| The work is about tabs Ted already has open, or a site he is signed into | Ted's browser. Soft input. No banner. |
| One short trusted gesture in that signed-in browser (file picker, clipboard, `isTrusted`, a single Docs edit) and both input switches are on | Ted's browser, AGE-614 batch. Banner visible, then detach. |
| The page has to be drawn and still must be Ted's session | Ted's browser plus the AGE-613 window, once that spike passes. No banner. |
| Trusted input runs longer than one AGE-614 batch, or a debugger session would sit on his daily profile | Agent profile. |
| The page is public, or a test account he signs into on purpose in the other profile | Agent profile. |
| The job needs his cookies, payments, 2FA, or an open tab | Ted's browser. An agent profile cannot see those. |

Copying his profile or cookies into the agent profile is on the
[AGE-616](https://linear.app/agentdesk/issue/AGE-616) bypass list. This
note does not design that copy. Logins in the agent profile are test
accounts or a sign-in he does himself in that window.

## Why not build it here

- Audits already launch a throwaway headless Chrome
  (`browser-tools-mcp/src/lighthouse/runner.ts`) with
  `--disable-extensions` and an egress proxy. That process is an audit
  runner. Loading an interactive agent session into it would mix the audit
  network policy with a signed-in browsing session.
- Chrome 136 refuses remote debugging on the default profile. A fresh
  `--user-data-dir` is a different profile, which is why an isolated
  browser can be automated without touching Ted's. A raw DevTools port is
  also a different trust boundary: any local process that can open it can
  drive the browser. Browser Tools' connector is loopback, bearer token,
  and extension origin. v2.1 does not add an unauthenticated debug port
  beside that.
- A new dependency such as Playwright has to go through
  [AGE-485](https://linear.app/agentdesk/issue/AGE-485). Pointing agents at
  a tool they already run avoids that dependency for this milestone.
- Same tool names for two browsers will cross wires. Keeping the agent
  profile outside this server makes the split obvious.

## If a later card builds it

Build an extension-in-a-fresh-profile, not a cookie import and not a port
on the default profile.

- Profile directory owned by the connector, mode `0700`, created empty.
  Never a copy of `~/Library/Application Support/Google/Chrome` or the
  platform equivalent.
- The same extension and the same loopback token. The banner, when a
  trusted batch runs, appears in that Chrome process. Ted's daily profile
  stays quiet.
- Launch headless, or headed with `focused: false` and the AGE-613 score
  sheet applied to that process.
- Every tool call names its target. `user` (the default) is Ted's browser.
  `agent-browser` is the other profile. A call with the wrong target
  fails. There is no silent fallback from one to the other.
- File a dependency review before adding Playwright or any other browser
  driver.

Acceptance for that later card is the one on AGE-615: a real-input job
runs in the agent browser while Ted's window stays where it was.
