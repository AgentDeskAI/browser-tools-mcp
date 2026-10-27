# AGE-613: never-focused agent window

[AGE-613](https://linear.app/agentdesk/issue/AGE-613). Spike plan and the
numbers that decide whether AGE-584 v2 should build it. This note does not
record a measurement. Every cell below stays `unmeasured` until the spike
runs on Chrome stable, on a machine where someone is actually working.

No debugger, no banner, no `tabs.update({ active: true })`, no
`windows.update({ focused: true })`. The private macOS display API that
agent-lanes uses for an invisible screen is out of scope. Do not port it.

## What the spike creates

A normal Chrome window, created once with
`chrome.windows.create({ focused: false, type: "normal", state: "normal", ... })`
and never updated to focused, minimized, maximized, or fullscreen.
Minimized windows stop drawing. The agent's tab is the active tab inside
that window only.

Suggested home when someone runs it: `spikes/age-613-agent-window/`, same
shape as `spikes/age-618-chrome-tabs/`. Permissions: `tabs`, `windows`,
`storage`. Not `debugger`. The spike must not read page contents beyond a
same-origin fixture it opened itself.

Placement to try first (question 5): 320×240, left at
`screen.availWidth - 8`, top at `screen.availHeight - 8`, so a sliver stays
on the display Ted is not using. Title prefix `BrowserTools agent`. If he
closes it, recreate once and log the close. A second close ends the spike
and reports `closed-by-user`. An off-screen window (fully past
`availWidth`) is a second arm, because occlusion may stop drawing there.

## Sampler

Sample from 100ms before each create until 2s after each close.

| Signal | How | Valid run |
| --- | --- | --- |
| Frontmost app | A local sampler on a 20ms loop. Record the actual interval. | Median interval ≤ 25ms and no gap over 40ms. A slower run is invalid, not a pass. |
| Chrome's focused window | The extension, `chrome.windows.onFocusChanged` plus `windows.getLastFocused` | Every cycle |
| Active tab in Ted's window | `chrome.tabs.query` on the window id captured before the cycle | Unchanged |
| Space | Automatic window-focus signal, plus a person watching 10 of the 50 cycles | The 10 watched cycles are written down |

AppleScript once per sample will miss the interval. Use a loop that can
actually hit 20ms. Do not call a private window-server API to get there.

The with-flag arm (question 2) relaunches Chrome with
`--disable-backgrounding-occluded-windows`. That arm is a separate Chrome
process, not a silent change to Ted's daily launch. The flag is a drawing
flag. It is still a launch change, so it stays opt-in even if the numbers
say drawing needs it.

## Score sheet

Run Chrome stable first. Arc is a separate sheet. Fill `result` with `yes`,
`no`, or `only-with-flag`. Leave `unmeasured` until then.

| # | Question | Pass | Fail | Result |
| --- | --- | --- | --- | --- |
| 1 | Does the unfocused window stay behind? | 0 focus steals in 50 create/close cycles. Ted's active tab id unchanged on all 50. Frontmost app unchanged, or Chrome stays front and the focused window id stays Ted's. 0 Space changes on the 10 watched cycles. | Any steal, any active-tab change, any watched Space change. | unmeasured |
| 2 | Is the occlusion flag required to draw? | Without the flag, over 2s while Ted's window covers the agent window: requestAnimationFrame count ≥ 30, a lazy-loaded fixture node appears, and `captureVisibleTab(agentWindowId)` is not a blank frame. | Those checks fail without the flag and pass with it → `only-with-flag`. They fail both ways → `no`. | unmeasured |
| 3 | Do external opens land in the agent window? | 0 of 20 `open <url>` launches, 0 of 5 Mail links, and 0 of 5 Slack links have `windowId` equal to the agent window. If any do, the mitigation (below) moves 20/20 back with 0 focus steals. | A landed tab stays in the agent window, or the move changes focus. | unmeasured |
| 4 | Does Arc pass question 1? | Same bar as question 1. | Any API failure, Little Arc, or a Space switch. Record `no`. Chrome can still pass. | unmeasured |
| 5 | Can the window sit where Ted will not close it, and still draw? | The question-5 placement passes question 2, and two intentional closes stop the spike (one recreate, then stop). | Drawing only works fully on-screen in the middle of the work, or the spike keeps recreating. | unmeasured |

Fixture page for question 2, served by the spike: a rAF counter, a
`content-visibility` or below-the-fold image, and a menu that opens on the
second animation frame. The page origin is the fixture only.

Question 3 mitigation, if the first counts are non-zero: on
`chrome.tabs.onCreated`, when `windowId` is the agent window and the opener
is not the agent's own tab, `chrome.tabs.move` the new tab into Ted's
window with the moved tab not active. Do not call `windows.update`. Also
rewrite `window.open` from the agent's own page into a same-tab navigation,
so a popup cannot pull the agent window forward.

Record the browser version, the screen layout, the sampler intervals, and
the cycle counts next to the sheet. Origins only if a note has to mention a
URL. No page titles.

## Recommendation rule

Build it into AGE-584 v2 only when all of these are true:

- Question 1 is `yes` on Chrome stable.
- Question 2 is `yes`, or `only-with-flag` and the flag stays an opt-in
  launch for that window's Chrome, documented as a drawing flag.
- Question 3 is `yes` with or without the move-back mitigation.
- Question 5 is `yes`.
- Question 4 is recorded. `no` on Arc means the feature is Chrome-only,
  which is an acceptable ship note. A missing Arc row is not.

Drop it when question 1 is `no`. A window that takes focus fails Ted's ask,
and no flag repairs that.

Until the sheet is filled, the recommendation is to run the spike and to
keep it out of 2.1.0. There is no measured `yes` to build on.

## Out of scope

Trusted input and any debugger attach. That is AGE-614. Logged-out jobs
that need real input throughout are AGE-615. Both can run later against a
window this spike proved, and neither is part of the measurement.
