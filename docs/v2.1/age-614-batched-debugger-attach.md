# AGE-614: brief batched debugger attach

[AGE-614](https://linear.app/agentdesk/issue/AGE-614). Design only. The
implementation waits on this note, the tests listed below, and security-lead
sign-off ([AGE-483](https://linear.app/agentdesk/issue/AGE-483),
[AGE-616](https://linear.app/agentdesk/issue/AGE-616)).

## Decision

Real input is a short, explicit fallback behind the input switch. The
extension attaches `chrome.debugger` to one tab, runs the batch, and detaches
before the tool returns. The Chrome banner stays visible for that attachment.
Dismissing the banner stops the batch and blocks another attach until Ted
turns the panel switch off and back on.

Default work stays on the AGE-584 path and never attaches.

## When an attach is allowed

All of these are already enforced by `decideCapability` in
`browser-tools-mcp/src/gates/capability.ts` and `confirmBeforeAct` in
`chrome-extension/gates.js`. An attach happens only after both have allowed
`debuggerFallback`.

| Gate | Today | Attach? |
| --- | --- | --- |
| `--allow-input` off (the default) | `inputOff` | Never |
| DevTools panel checkbox off (the default, session key `btmcpPanelInput`) | `panelOff` | Never |
| `hideBanner: true` | `banner` ("banner bypass is disabled") | Never |
| Live tab URL missing, non-http(s), excluded, or a public origin not in `--allow-input-origins` | url / exclude reasons | Never |
| Local origin, or an origin listed in `--allow-input-origins`, with both switches on | `allowed` | Yes, for one batch |

The toolbar popup switch does not arm this action. `debuggerFallback` is a
panel action. Soft click, soft type, and navigate stay on the popup switch
and still do not attach.

The panel label says "on this tab". The bit is one session-storage flag for
the whole browser session. Before this ships, either the label should say
that, or the flag should become per-tab. Until then the origin check is what
limits which tab can be attached, and it is re-read from `chrome.tabs.get`
immediately before the attach.

Two further gates belong in the same function when this is built:

- `bannerDismissed`, after Ted presses Cancel, until the panel checkbox goes
  off and then on again in this browser session.
- A live URL re-check after attach, before the first input command. A
  navigation between the check and the command aborts the batch.

`chrome.debugger.getTargets()` is not a probe. Call it for nothing. An
unsettled field report says the call itself can raise the banner, and the
extension can track its own sessions without it.

## Who owns the session

Chrome gives this extension one debugger client per tab. The service worker
and the DevTools page cannot both attach to that tab.

| Situation | Owner | What the other side does |
| --- | --- | --- |
| DevTools is open on that tab and capture mode is `debugger` (devtools.js has already called `attach`) | The DevTools page | The worker sends the batch over the `btmcp-debugger` port. It does not call `attach` or `detach`. |
| DevTools is closed, or capture mode is `inject` | The service worker | It attaches, runs the batch, undoes focus emulation, and detaches. |
| `attach` fails because a client is already there, and no port answers within 300ms | Nobody | The batch fails with `owner-unavailable`. No second attempt. |

`devtools.js` already owns the long-lived capture session
(`attachDebugger` around the inspected `tabId`, protocol `1.3`). The worker
today does not attach; the comment at the top of `worker.js` says so. This
fallback is the first worker attach, and only in the second row.

The DevTools page registers the port when it attaches and clears it when it
detaches or unloads. After a service-worker restart the map is empty. A
failed attach plus a silent port is `owner-unavailable`, not a retry.

One batch at a time for the whole extension. A second `debuggerFallback`
while one is running returns `busy`. It does not queue. A queue would hold
the session open.

## Batching rule

A batch is one tool call: at most 8 steps, one `tabId`, wall clock 5 seconds
for the commands and a hard stop at 8 seconds. The worker (or the DevTools
page, if it owns the tab) attaches at the start and detaches in a `finally`
block before the call returns. There is no idle timer and no "keep it warm".

Steps that may be in the batch: a trusted click, a trusted key or text
insert, and the gesture that opens a file picker, a popup, or fullscreen.
The file picker then stops. The tool reports `needsUser: "file-chooser"` and
Ted picks the file. This design does not supply a filesystem path.

Soft input runs first. The attach happens after a step comes back
`needsRealGesture`, or when the caller asked for a known gesture action
(clipboard, file picker, popup, fullscreen, a site that checks `isTrusted`).
A step on a different tab ends the call. The agent sends a new call, which
is a new attach, after the first detach.

Protocol version stays `1.3`, the version capture already uses, so a borrowed
DevTools session and a worker session match.

Commands inside the window:

1. `Emulation.setFocusEmulationEnabled` with `{ enabled: true }`.
2. The input commands for the steps.
3. `Page.setWebLifecycleState` with `{ state: "active" }` only if a step
   still failed because the page was frozen, and only for the rest of this
   batch. Record `wokeTab: true`. Discarded tabs stay skipped on the default
   path; waking one is part of the result, not a surprise.
4. In `finally`, before detach: focus emulation back to `{ enabled: false }`.
   Leave lifecycle `active` if it was woken, and say so.

`chrome.tabs.update({ active: true })` and `chrome.windows.update({ focused: true })`
are not called. Ted's active tab, window, and Space stay as they were.

Side effect for the security review: the page is told it is focused, and
maybe that it is visible. Read receipts, presence, and autoplay can fire
while the batch runs. The result includes `focusEmulated: true` when step 1
ran.

## The banner stays, and Cancel stops the work

Attaching shows Chrome's "started debugging this browser" banner. Facts
taken from Chromium's extension infobar (Amplifier's
[DEBUGGER_BANNER.md](https://github.com/microsoft/amplifier-browser-bridge/blob/main/docs/DEBUGGER_BANNER.md)
cites the source; this project has not re-timed them):

- One banner per extension, on every tab in every window of that profile,
  not only the tab being driven.
- Chromium clears it about 5 seconds after the last detach. It does not
  clear while any session of this extension is still attached, and a
  navigation does not clear it.
- Cancel detaches every debugger session this extension holds, including
  console capture on other tabs.

So the "action plus about 5 seconds" line is true only when this batch is
the extension's only debugger session. Capture mode `debugger` on any open
DevTools holds a session for as long as that DevTools is open, and the
banner stays for that whole time. The result says `bannerCleared: false`
and `bannerReason: "other-session"` in that case. The brief-banner promise
needs capture mode `inject`, or DevTools closed, on every tab.

Dismiss handling:

1. Listen for `chrome.debugger.onDetach` before `attach`.
2. Reason `canceled_by_user` sets `cancelled: true`, sets the
   `bannerDismissed` latch, and skips every step not already sent.
3. No code path calls `attach` again until the panel checkbox is turned off
   and on. A reconnect, a capture restart, or the next agent tool call does
   not clear the latch.
4. The tool returns the partial result. It does not swap in a soft click
   and report success.

`target_closed` also stops the batch. It does not set the latch.

## Result

Each call returns:

| Field | Meaning |
| --- | --- |
| `trusted` | `true` only when a CDP input command completed for that step |
| `steps[]` | One entry per step: name, `trusted`, `ok`, optional `error` |
| `attachedMs` | Time from attach acknowledgement to detach. `0` when an existing DevTools session was borrowed |
| `bannerShown` | `true` when this extension attached or already held a session |
| `bannerAlreadyUp` | `true` when the DevTools page already owned the tab |
| `bannerCleared` | `true` only if this detach was the last session |
| `cancelled` | Ted pressed Cancel |
| `detached` | This call released the session. `false` when DevTools still owns capture |
| `focusEmulated` | Focus emulation was turned on |
| `wokeTab` | Lifecycle was forced to `active` |
| `focusStealing` | Always `false`. Present so a caller can assert it |

## Tests to add with the implementation

These are not in this change.

| Case | Expected |
| --- | --- |
| `--allow-input` omitted | `debuggerFallback` is `inputOff`. `chrome.debugger.attach` is not called. |
| `hideBanner: true`, every other switch on | Reason `banner`. `attach` is not called. |
| Both switches on, allowlisted origin | One `attach`, the steps, focus emulation undone, one `detach`. No `tabs.update` active and no `windows.update` focused. |
| `onDetach` with `canceled_by_user` after step 1 of 3 | Steps 2 and 3 are not sent. No second `attach`. `cancelled: true`. The next call is `bannerDismissed` until the panel switch cycles. |
| DevTools already attached to that tab | The worker does not call `attach`. Commands go to the port. The fallback does not call `detach`. |
| Second call while the first batch is open | `busy`. Still one attach. |

Unit coverage for `hideBanner` already exists in
`browser-tools-mcp/test/unit/capability-gates.test.ts` and
`chrome-extension` gate tests. Keep it.

## For the security review

In scope to approve or reject: a worker-owned attach of at most 8 seconds,
banner visible, Cancel latched, focus emulation with the visibility side
effect, same origin rules as other input.

Out of scope, and not designed here: `--silent-debugger-extension-api`,
policy force-install, shielding this extension by disabling others,
SkyLight or AppleScript input, copying Ted's profile or cookies, and any
setup step that hides the banner.
