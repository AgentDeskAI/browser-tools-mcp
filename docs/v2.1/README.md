# v2.1 design notes

Design and spike plans for the tab-awareness follow-ups. They do not change
runtime behavior, and they do not block the 2.1.0 code. Nothing here attaches
the debugger, launches a browser, or publishes a package.

Banner policy, from [SECURITY.md](../../SECURITY.md):

> Chrome's "started debugging this browser" banner is a browser safety
> control. It is intentional, and this project never hides it, suppresses it,
> or documents a setup step that does. Features that can run without the
> debugger do so. When a feature attaches the debugger, the banner stays
> visible for that attachment, and dismissing it stops the attachment.

The same rule is in the README. These notes keep it.

Order of operations, matching the
[Oct 23 findings](https://linear.app/agentdesk/document/findings-using-teds-browser-without-the-debugging-banner-oct-23-2026-f49d757c2c4d):

| Need | Path | Banner in Ted's browser |
| --- | --- | --- |
| See tabs, read them, soft click and type | [AGE-584](https://linear.app/agentdesk/issue/AGE-584) default. No debugger. | No |
| UI that only works once the page is drawn | [AGE-613](age-613-never-focused-window.md) spike. Still no debugger. | No |
| A short batch of real (trusted) input in Ted's signed-in browser | [AGE-614](age-614-batched-debugger-attach.md). Opt-in. Banner stays up. | Yes, for the batch plus about 5 seconds after the last detach |
| Real input on a job that should not touch Ted's session | [AGE-615](age-615-agent-profile-lane.md). A different browser profile. | No |

[AGE-617](age-617-upstream-watchlist.md) is the monthly check on the two
upstream changes that could shrink that table. [AGE-616](https://linear.app/agentdesk/issue/AGE-616)
still has to rule on the bypass list before any debugger fallback ships.
This set does not ask for any bypass to be turned on.
